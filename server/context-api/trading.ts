/**
 * Order placement for pricers and traders via Context Markets SDK.
 *
 * Pricers: Atomic bulk cancel+create for 4 orders (YES bid/ask + NO bid/ask).
 * Traders: Simulate before placing. Supports buy and sell.
 */

import { getAgentClient } from "./client";
import { state } from "../state";
import type { AgentState } from "../state";
import { broadcast } from "../ws-bridge";
import { notifyBuildingEvent } from "../agents/group-chat";
import { isApiHealthy } from "./sync";

/**
 * Estimate total account value for an agent (buying power + position value).
 * Used to derive proportional position sizes.
 */
function getAccountValue(agent: AgentState): number {
  const balance = agent.usdcBalance ?? 0;

  let positionValue = 0;
  if (agent.positions) {
    for (const p of agent.positions) {
      const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
      if (m && m.fairValue !== null) {
        const isYes = p.outcome.toLowerCase().includes("yes");
        const mid = isYes ? m.fairValue : (1 - m.fairValue);
        positionValue += p.size * mid;
      } else {
        // No price — assume 50¢
        positionValue += p.size * 0.5;
      }
    }
  }

  return balance + positionValue;
}

/**
 * Compute a position size as a percentage of account value.
 * pctOfAccount: e.g. 0.02 = 2% of account per order
 * priceCents: price of the contract in cents (used to convert $ to contracts)
 * Returns contract count, clamped to [min, max].
 */
function sizeFromAccount(agent: AgentState, pctOfAccount: number, priceCents: number, min = 5, max = 500): number {
  const accountVal = getAccountValue(agent);
  const dollarRisk = accountVal * pctOfAccount;
  const contracts = Math.floor((dollarRisk / priceCents) * 100);
  return Math.max(min, Math.min(max, contracts));
}

/**
 * Cancel all open orders for an agent on a specific market.
 */
export async function cancelOrders(agentId: string, localMarketId: string): Promise<boolean> {
  if (!isApiHealthy()) return false;

  const market = state.markets.get(localMarketId);
  if (!market?.apiMarketId) return false;

  const client = getAgentClient(agentId);
  if (!client) return false;

  try {
    const existingOrders = await client.orders.allMine(market.apiMarketId);
    const openNonces = existingOrders
      .filter((o) => o.status === "open")
      .map((o) => o.nonce as `0x${string}`);

    if (openNonces.length > 0) {
      // API limit: max 20 cancels per bulk call
      for (let i = 0; i < openNonces.length; i += 20) {
        const batch = openNonces.slice(i, i + 20);
        await client.orders.bulkCancel(batch);
      }
      console.log(`[Trading] ${agentId}: cancelled ${openNonces.length} orders on ${localMarketId}`);
    }

    const agent = state.agents.get(agentId);
    if (agent) {
      agent.openOrders = (agent.openOrders || []).filter((o) => o.marketId !== localMarketId);
    }

    return true;
  } catch (err) {
    console.error(`[Trading] ${agentId}: cancel failed on ${localMarketId}:`, err);
    return false;
  }
}

/**
 * Sweep stale orders for ALL pricers/traders.
 * Cancels open orders whose price is far from current fair value (>15¢ off)
 * or on markets that have been inactive (no trades in >10 min).
 * Runs periodically from the sync loop — no LLM needed.
 */
const STALE_PRICE_THRESHOLD_CENTS = 15; // cancel if order price >15¢ from fair value
const STALE_MARKET_INACTIVITY_MS = 10 * 60_000; // 10 min with no trades

export async function sweepStaleOrders(): Promise<void> {
  if (!isApiHealthy()) return;

  const agents = Array.from(state.agents.values()).filter(
    (a) => (a.role === "pricer" || a.role === "trader") && a.openOrders && a.openOrders.length > 0
  );

  for (const agent of agents) {
    const ordersToCancel = new Map<string, string[]>(); // localMarketId → reasons

    for (const order of agent.openOrders || []) {
      const market = state.markets.get(order.marketId);
      if (!market || !market.apiMarketId) continue;

      // Skip resolving markets — forceResolveCleanup handles those
      if (market.resolutionStatus === "pending" || market.resolutionStatus === "resolved" ||
          market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed") {
        continue;
      }

      let shouldCancel = false;
      let reason = "";

      // Check price staleness: is the order price far from current fair value?
      if (market.fairValue !== null) {
        const fairCents = Math.round(market.fairValue * 100);
        // For YES side orders, compare directly. For NO side, the fair value is (100 - fairCents).
        // Since we track orders with a generic "price" field, compare to whichever is closer.
        const distFromYes = Math.abs(order.price - fairCents);
        const distFromNo = Math.abs(order.price - (100 - fairCents));
        const minDist = Math.min(distFromYes, distFromNo);

        if (minDist > STALE_PRICE_THRESHOLD_CENTS) {
          shouldCancel = true;
          reason = `price ${order.price}¢ is ${minDist}¢ from fair value`;
        }
      }

      // Check market inactivity
      if (!shouldCancel) {
        const lastTrade = market.trades[market.trades.length - 1];
        const lastActivity = lastTrade?.ts ?? 0;
        if (Date.now() - lastActivity > STALE_MARKET_INACTIVITY_MS && market.fairValue === null) {
          shouldCancel = true;
          reason = "market has no fair value and no recent activity";
        }
      }

      if (shouldCancel) {
        const existing = ordersToCancel.get(order.marketId) || [];
        existing.push(reason);
        ordersToCancel.set(order.marketId, existing);
      }
    }

    // Cancel stale orders market by market
    for (const [localMarketId, reasons] of ordersToCancel) {
      const market = state.markets.get(localMarketId);
      const shortQ = market ? market.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70) : localMarketId;
      console.log(`[StaleOrderSweep] ${agent.name}: cancelling orders on ${localMarketId} — ${reasons[0]}`);
      state.logTrade({ agentId: agent.id, marketId: localMarketId, type: "cancel", side: "YES", direction: "buy", shares: 0, priceCents: 0, reason: `stale: ${reasons[0]}` });
      state.addAction(agent.id, "cancel", `${agent.name} cancelled stale orders on "${shortQ}" — ${reasons[0]}`);
      await cancelOrders(agent.id, localMarketId).catch(() => {});
    }
  }
}

/**
 * Place a two-sided market on both YES and NO orderbooks using atomic bulk().
 * Cancels ALL existing orders and places 4 new ones in a single atomic call.
 */
export async function placePricingOrders(
  agentId: string,
  localMarketId: string,
  fairValueCents: number,
  spreadCents: number,
): Promise<boolean> {
  if (!isApiHealthy()) return false;

  const market = state.markets.get(localMarketId);
  if (!market?.apiMarketId) {
    console.log(`[Trading] ${agentId}: no API market ID for ${localMarketId}`);
    return false;
  }

  // Pre-flight: reject if market is resolving/resolved/closed
  if (market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed" ||
      market.resolutionStatus === "pending" || market.resolutionStatus === "resolved") {
    console.log(`[Trading] ${agentId}: skipping pricing on ${localMarketId} — market status: ${market.apiStatus}/${market.resolutionStatus}`);
    await cancelOrders(agentId, localMarketId);
    return false;
  }

  const client = getAgentClient(agentId);
  if (!client) return false;

  const agent = state.agents.get(agentId);
  if (!agent) return false;

  // Clamp values
  fairValueCents = Math.max(5, Math.min(95, Math.round(fairValueCents)));
  spreadCents = Math.max(2, Math.min(20, Math.round(spreadCents)));

  const halfSpread = Math.floor(spreadCents / 2);

  // 3 tiers of depth: tight, mid, wide
  // Each tier steps further from fair value with increasing size
  const TIER_OFFSETS = [0, 3, 6]; // additional cents from base spread per tier
  const TIER_SIZE_MULT = [1.0, 2.0, 3.0]; // size multiplier per tier

  // Dynamic sizing: ~2% of account value per side, with inventory skew
  let yesInventory = 0;
  let noInventory = 0;
  if (agent.positions) {
    for (const p of agent.positions) {
      if (p.marketId === market.apiMarketId || p.marketId === localMarketId) {
        if (p.outcome.toLowerCase().includes("yes")) yesInventory += p.size;
        if (p.outcome.toLowerCase().includes("no")) noInventory += p.size;
      }
    }
  }

  // Tight sizes due to limited testnet collateral (~$14-1000 per pricer)
  // 12 orders/market × 25 markets = 300 orders, size 1 = ~$0.50/order = ~$150 total
  const baseSize = 1;
  // No inventory skew at size 1 — can't go below 1
  const yesSkew = 0;
  const noSkew = 0;

  // Build 12 orders: 3 tiers × 2 sides (bid/ask) × 2 outcomes (YES/NO)
  type CreateOrder = { marketId: string; outcome: "yes" | "no"; side: "buy" | "sell"; priceCents: number; size: number; inventoryModeConstraint?: 2 };
  const creates: CreateOrder[] = [];
  type TrackedOrder = { nonce: string; side: "buy" | "sell"; price: number; size: number; marketId: string };
  const trackedTemplate: { side: "buy" | "sell"; price: number; size: number }[] = [];

  const noFV = 100 - fairValueCents;

  for (let tier = 0; tier < 3; tier++) {
    const offset = TIER_OFFSETS[tier];
    const sizeMult = TIER_SIZE_MULT[tier];

    const yesBid = Math.max(1, fairValueCents - halfSpread - offset);
    const yesAsk = Math.min(99, fairValueCents + Math.ceil(spreadCents / 2) + offset);
    const noBid = Math.max(1, noFV - halfSpread - offset);
    const noAsk = Math.min(99, noFV + Math.ceil(spreadCents / 2) + offset);

    const yesBidSize = Math.max(5, Math.round((baseSize - yesSkew) * sizeMult));
    const yesAskSize = Math.max(5, Math.round((baseSize + yesSkew) * sizeMult));
    const noBidSize = Math.max(5, Math.round((baseSize - noSkew) * sizeMult));
    const noAskSize = Math.max(5, Math.round((baseSize + noSkew) * sizeMult));

    creates.push(
      { marketId: market.apiMarketId!, outcome: "yes", side: "buy", priceCents: yesBid, size: yesBidSize },
      { marketId: market.apiMarketId!, outcome: "yes", side: "sell", priceCents: yesAsk, size: yesAskSize, inventoryModeConstraint: 2 },
      { marketId: market.apiMarketId!, outcome: "no", side: "buy", priceCents: noBid, size: noBidSize },
      { marketId: market.apiMarketId!, outcome: "no", side: "sell", priceCents: noAsk, size: noAskSize, inventoryModeConstraint: 2 },
    );
    trackedTemplate.push(
      { side: "buy", price: yesBid, size: yesBidSize },
      { side: "sell", price: yesAsk, size: yesAskSize },
      { side: "buy", price: noBid, size: noBidSize },
      { side: "sell", price: noAsk, size: noAskSize },
    );
  }

  // Innermost tier prices for logging / bestBid/bestAsk
  const t1YesBid = creates[0].priceCents;
  const t1YesAsk = creates[1].priceCents;
  const t1NoBid = creates[2].priceCents;
  const t1NoAsk = creates[3].priceCents;

  try {
    // Get all open order nonces for atomic cancel
    const existingOrders = await client.orders.allMine(market.apiMarketId);
    const cancelNonces = existingOrders
      .filter((o) => o.status === "open")
      .map((o) => o.nonce as `0x${string}`);

    // Cancel existing orders in batches of 20 (API limit)
    for (let i = 0; i < cancelNonces.length; i += 20) {
      try {
        await client.orders.bulkCancel(cancelNonces.slice(i, i + 20));
      } catch (cancelErr) {
        console.warn(`[Trading] ${agentId}: cancel batch failed, continuing:`, cancelErr);
      }
    }

    // Create 12 new orders via bulk (no cancels mixed in)
    let results: { nonce: string }[];
    try {
      const bulkResult = await client.orders.bulk(creates, []);
      const createResults = bulkResult.results.filter((r) => r.type === "create");
      const successCount = createResults.filter((r) => (r as Record<string, unknown>).success).length;
      const failCount = createResults.length - successCount;
      if (failCount > 0 || successCount < creates.length) {
        console.log(`[Trading] ${agentId}: bulk result — ${successCount}/${creates.length} created, ${failCount} failed`);
        const firstFail = createResults.find((r) => !(r as Record<string, unknown>).success);
        if (firstFail) console.log(`[Trading] ${agentId}: first failure:`, JSON.stringify(firstFail).slice(0, 200));
      }
      results = createResults
        .filter((r) => (r as Record<string, unknown>).success)
        .map((r) => {
          const order = (r as Record<string, unknown>).order as Record<string, unknown> | undefined;
          return { nonce: String(order?.nonce || "") };
        });
    } catch {
      // Fallback: sequential create if bulk fails
      results = [];
      for (const order of creates) {
        try {
          const r = await client.orders.create(order);
          results.push({ nonce: r.order?.nonce || "" });
        } catch { results.push({ nonce: "" }); }
      }
    }

    // Track orders locally
    const tracked: TrackedOrder[] = trackedTemplate.map((t, i) => ({
      nonce: results[i]?.nonce || "",
      side: t.side,
      price: t.price,
      size: t.size,
      marketId: localMarketId,
    }));

    const inv = yesInventory > 0 || noInventory > 0 ? ` (inv: ${yesInventory}Y/${noInventory}N)` : "";
    console.log(`[Trading] ${agentId}: priced ${localMarketId} 3-tier YES ${t1YesBid}¢/${t1YesAsk}¢ NO ${t1NoBid}¢/${t1NoAsk}¢ (${creates.length} orders)${inv}`);

    state.updatePrice(localMarketId, fairValueCents / 100, spreadCents / 100);
    market.bestBid = t1YesBid;
    market.bestAsk = t1YesAsk;
    agent.openOrders = tracked;

    broadcast({
      type: "price_update",
      marketId: localMarketId,
      fairValue: fairValueCents / 100,
      spread: spreadCents / 100,
      building: "exchange",
    });
    notifyBuildingEvent("exchange");
    notifyBuildingEvent("pit");

    return true;
  } catch (err) {
    console.error(`[Trading] ${agentId}: pricing failed for ${localMarketId}:`, err);
    return false;
  }
}

/**
 * Simulate a trade to preview fill, slippage, and cost.
 * Returns null if simulation fails (graceful degradation).
 */
async function simulateTrade(
  client: ReturnType<typeof getAgentClient>,
  apiMarketId: string,
  side: "yes" | "no",
  size: number,
): Promise<{ avgPrice: number; slippage: number; fillSize: number } | null> {
  if (!client) return null;
  try {
    // SDK simulate returns { estimatedAvgPrice, estimatedSlippage, estimatedContracts }
    const sim = await client.markets.simulate(apiMarketId, { side, amount: size });
    return {
      avgPrice: sim?.estimatedAvgPrice ?? 0,
      slippage: sim?.estimatedSlippage ?? 0,
      fillSize: sim?.estimatedContracts ?? size,
    };
  } catch {
    return null;
  }
}

/**
 * Place a trade order for a trader agent. Supports buy and sell.
 * Simulates before placing to check slippage.
 */
export async function placeTrade(
  agentId: string,
  localMarketId: string,
  side: "YES" | "NO",
  size: number,
  direction: "buy" | "sell" = "buy",
): Promise<boolean> {
  // Skip circuit breaker for trades — they should attempt even if sync is rate-limited

  const market = state.markets.get(localMarketId);
  if (!market?.apiMarketId) {
    console.log(`[Trading] ${agentId}: no API market ID for ${localMarketId}`);
    return false;
  }

  // Pre-flight: reject if market is resolving/resolved/closed (sells allowed for position exit)
  if (market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed" ||
      market.resolutionStatus === "pending" || market.resolutionStatus === "resolved") {
    if (direction === "buy") {
      console.log(`[Trading] ${agentId}: blocked buy on ${localMarketId} — market status: ${market.apiStatus}/${market.resolutionStatus}`);
      await cancelOrders(agentId, localMarketId);
      return false;
    }
    // Sells still allowed to exit positions, but cancel any resting orders first
    await cancelOrders(agentId, localMarketId);
  }

  const client = getAgentClient(agentId);
  if (!client) return false;

  const agent = state.agents.get(agentId);
  if (!agent) return false;

  // Cancel existing orders on this market before trading (batch in groups of 20)
  try {
    const existingOrders = await client.orders.allMine(market.apiMarketId);
    const openNonces = existingOrders
      .filter((o) => o.status === "open")
      .map((o) => o.nonce as `0x${string}`);
    for (let i = 0; i < openNonces.length; i += 20) {
      await client.orders.bulkCancel(openNonces.slice(i, i + 20));
    }
  } catch {
    // Continue even if cancel fails
  }

  const outcome = side === "YES" ? "yes" : "no";

  if (direction === "sell") {
    const position = (agent.positions || []).find(
      (p) => (p.marketId === market.apiMarketId || p.marketId === localMarketId)
        && p.outcome.toLowerCase().includes(outcome)
    );

    if (!position || position.size < 1) {
      console.log(`[Trading] ${agentId}: no ${side} position to sell on ${localMarketId}`);
      return false;
    }

    // Dynamic sell cap: up to 5% of account value in contracts, or the full position
    const maxSellContracts = sizeFromAccount(agent, 0.05, 50, 5, 500);
    const sellSize = Math.min(size, Math.floor(position.size), maxSellContracts);
    if (sellSize < 1) return false;

    // Market sell: price well below fair value to sweep the bid side
    const fvCents = market.fairValue ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100) : 50;
    const priceCents = Math.max(5, fvCents - 15);

    try {
      const agentName = state.agents.get(agentId)?.name || agentId;
      const shortQ = market.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
      const orderPrice = Math.max(1, Math.min(99, priceCents));

      console.log(`[Trading] ${agentName}: placing sell ${sellSize} ${side} at ${orderPrice}¢ on ${localMarketId}`);

      const result = await client.orders.create({
        marketId: market.apiMarketId!,
        outcome: outcome as "yes" | "no",
        side: "sell",
        priceCents: orderPrice,
        size: sellSize,
      });

      // Check actual fill from API response
      const order = result.order;
      const filledSize = order ? parseInt(order.filledSize, 10) : 0;

      // Simulate fill for self-trade prevention (same mnemonic = no API match)
      const sellFvCents = market.fairValue ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100) : 50;
      const shouldSimSellFill = filledSize === 0 && (
        (side === "YES" && market.bestBid !== null && orderPrice <= market.bestBid) ||
        (side === "NO" && market.bestAsk !== null && orderPrice <= (100 - market.bestAsk))
      );
      const effectiveSellFill = filledSize > 0 ? filledSize : (shouldSimSellFill ? sellSize : 0);

      if (effectiveSellFill > 0) {
        const execPrice = filledSize > 0 ? orderPrice : sellFvCents;
        state.logTrade({ agentId, marketId: localMarketId, type: "execution", side, direction: "sell", shares: effectiveSellFill, priceCents: execPrice });
        state.addAction(agentId, "execution", `${agentName} sold ${effectiveSellFill} shares ${side} "${shortQ}" at ${execPrice}¢`);
        console.log(`[Trading] ${agentName}: FILLED sell ${effectiveSellFill} ${side} at ${execPrice}¢ on ${localMarketId}${filledSize === 0 ? " (sim)" : ""}`);

        const price = execPrice / 100;
        state.addTrade(localMarketId, agentId, side, -effectiveSellFill, price);

        if (position) {
          position.size = Math.max(0, position.size - effectiveSellFill);
        }
        // Credit proceeds
        agent.usdcBalance = (agent.usdcBalance ?? 0) + (effectiveSellFill * execPrice / 100);

        broadcast({
          type: "trade_executed", agentId, marketId: localMarketId, side, size: effectiveSellFill,
          price: Math.round(price * 100) / 100, building: "pit", question: market.question,
          tradeType: "execution", direction: "sell",
        });
        notifyBuildingEvent("pit");
      } else {
        state.logTrade({ agentId, marketId: localMarketId, type: "order", side, direction: "sell", shares: sellSize, priceCents: orderPrice });
        state.addAction(agentId, "order", `${agentName} resting sell ${sellSize} shares ${side} "${shortQ}" at ${orderPrice}¢`);
        console.log(`[Trading] ${agentName}: RESTING sell ${sellSize} ${side} at ${orderPrice}¢ on ${localMarketId} (no match)`);

        broadcast({
          type: "trade_executed", agentId, marketId: localMarketId, side, size: sellSize,
          price: orderPrice / 100, building: "pit", question: market.question,
          tradeType: "order", direction: "sell",
        });
      }

      return true;
    } catch (err) {
      console.error(`[Trading] ${agentId}: sell failed on ${localMarketId}:`, err);
      return false;
    }
  }

  // ── Buy direction ──

  const balance = agent.usdcBalance ?? 0;
  if (balance < 1) {
    console.log(`[Trading] ${agentId}: insufficient balance ($${balance})`);
    return false;
  }

  // Market order: price aggressively to guarantee fill against resting orders.
  // Use fair value as the cost estimate for sizing, but price the order to cross.
  const fvCents = market.fairValue ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100) : 50;
  // Price far above fair value to sweep the book — API fills at best available price
  const priceCents = Math.min(95, fvCents + 15);

  const agentName = state.agents.get(agentId)?.name || agentId;
  console.log(`[Trading] ${agentName}: market buy ${side} at ${priceCents}¢ (fv=${fvCents}¢) on ${localMarketId}`);

  // Dynamic buy cap: ~5% of account value, sized using fair value (not crossing price)
  const maxBuyContracts = sizeFromAccount(agent, 0.05, fvCents, 10, 200);
  const maxAffordable = Math.floor((balance / fvCents) * 100);
  size = Math.min(size, maxAffordable, maxBuyContracts);
  if (size < 1) {
    console.log(`[Trading] ${agentId}: can't afford any contracts at ${priceCents}¢`);
    return false;
  }

  try {
    const shortQ = market.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
    const orderPrice = Math.max(1, Math.min(99, priceCents));

    console.log(`[Trading] ${agentName}: placing buy ${size} ${side} at ${orderPrice}¢ on ${localMarketId}`);

    const result = await client.orders.create({
      marketId: market.apiMarketId!,
      outcome: outcome as "yes" | "no",
      side: "buy",
      priceCents: orderPrice,
      size,
    });

    // Check actual fill from API response
    const order = result.order;
    const filledSize = order ? parseInt(order.filledSize, 10) : 0;

    // Self-trade prevention: all agents share the same mnemonic, so API won't match
    // them against each other. Simulate fill if order crosses our pricer quotes.
    const fillPrice = fvCents; // fill at fair value
    const shouldSimFill = filledSize === 0 && (
      (side === "YES" && market.bestAsk !== null && orderPrice >= market.bestAsk) ||
      (side === "NO" && market.bestBid !== null && orderPrice >= (100 - market.bestBid))
    );
    const effectiveFill = filledSize > 0 ? filledSize : (shouldSimFill ? size : 0);

    if (effectiveFill > 0) {
      const execPrice = filledSize > 0 ? orderPrice : fillPrice;
      state.logTrade({ agentId, marketId: localMarketId, type: "execution", side, direction: "buy", shares: effectiveFill, priceCents: execPrice });
      state.addAction(agentId, "execution", `${agentName} bought ${effectiveFill} shares ${side} "${shortQ}" at ${execPrice}¢`);
      console.log(`[Trading] ${agentName}: FILLED buy ${effectiveFill} ${side} at ${execPrice}¢ on ${localMarketId}${filledSize === 0 ? " (sim)" : ""}`);

      const price = execPrice / 100;
      state.addTrade(localMarketId, agentId, side, effectiveFill, price);

      // Update position
      if (!agent.positions) agent.positions = [];
      const existing = agent.positions.find(p => p.marketId === localMarketId && p.outcome.toLowerCase().includes(outcome));
      if (existing) {
        existing.size += effectiveFill;
      } else {
        agent.positions.push({ marketId: localMarketId, outcome: side, size: effectiveFill, avgPrice: price });
      }
      // Deduct cost
      agent.usdcBalance = Math.max(0, (agent.usdcBalance ?? 0) - (effectiveFill * execPrice / 100));

      broadcast({
        type: "trade_executed", agentId, marketId: localMarketId, side, size: effectiveFill,
        price: Math.round(price * 100) / 100, building: "pit", question: market.question,
        tradeType: "execution", direction: "buy",
      });
      notifyBuildingEvent("pit");
    } else {
      state.logTrade({ agentId, marketId: localMarketId, type: "order", side, direction: "buy", shares: size, priceCents: orderPrice });
      state.addAction(agentId, "order", `${agentName} resting buy ${size} shares ${side} "${shortQ}" at ${orderPrice}¢`);
      console.log(`[Trading] ${agentName}: RESTING buy ${size} ${side} at ${orderPrice}¢ on ${localMarketId} (no match)`);

      broadcast({
        type: "trade_executed", agentId, marketId: localMarketId, side, size,
        price: orderPrice / 100, building: "pit", question: market.question,
        tradeType: "order", direction: "buy",
      });
    }

    return true;
  } catch (err) {
    console.error(`[Trading] ${agentId}: buy failed on ${localMarketId}:`, err);
    return false;
  }
}
