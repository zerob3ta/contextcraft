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
      console.log(`[StaleOrderSweep] ${agent.name}: cancelling orders on ${localMarketId} — ${reasons[0]}`);
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
  const yesBid = Math.max(1, fairValueCents - halfSpread);
  const yesAsk = Math.min(99, fairValueCents + Math.ceil(spreadCents / 2));
  const noBid = Math.max(1, (100 - fairValueCents) - halfSpread);
  const noAsk = Math.min(99, (100 - fairValueCents) + Math.ceil(spreadCents / 2));

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

  const baseSize = sizeFromAccount(agent, 0.02, fairValueCents, 5, 200);
  // Skew: reduce bids on side we're long, increase asks to offload
  const invSkew = Math.min(Math.floor(baseSize * 0.4), 50);
  const yesSkew = yesInventory > 0 ? Math.min(invSkew, Math.floor(yesInventory / 5)) : 0;
  const noSkew = noInventory > 0 ? Math.min(invSkew, Math.floor(noInventory / 5)) : 0;
  const yesBidSize = Math.max(5, baseSize - yesSkew);
  const yesAskSize = Math.max(5, baseSize + yesSkew);
  const noBidSize = Math.max(5, baseSize - noSkew);
  const noAskSize = Math.max(5, baseSize + noSkew);

  try {
    // Get all open order nonces for atomic cancel
    const existingOrders = await client.orders.allMine(market.apiMarketId);
    const cancelNonces = existingOrders
      .filter((o) => o.status === "open")
      .map((o) => o.nonce as `0x${string}`);

    // Build 4 new orders — SDK PlaceOrderRequest uses outcome ("yes"/"no") + priceCents
    const creates = [
      { marketId: market.apiMarketId!, outcome: "yes" as const, side: "buy" as const, priceCents: yesBid, size: yesBidSize },
      { marketId: market.apiMarketId!, outcome: "yes" as const, side: "sell" as const, priceCents: yesAsk, size: yesAskSize, inventoryModeConstraint: 2 as const },
      { marketId: market.apiMarketId!, outcome: "no" as const, side: "buy" as const, priceCents: noBid, size: noBidSize },
      { marketId: market.apiMarketId!, outcome: "no" as const, side: "sell" as const, priceCents: noAsk, size: noAskSize, inventoryModeConstraint: 2 as const },
    ];

    // Atomic bulk: cancels execute first, then creates
    let results: { nonce: string }[];
    try {
      const bulkResult = await client.orders.bulk(creates, cancelNonces);
      // Extract nonces from bulk results — create results have type: "create"
      results = bulkResult.results
        .filter((r) => r.type === "create" && (r as Record<string, unknown>).success)
        .map((r) => {
          const order = (r as Record<string, unknown>).order as Record<string, unknown> | undefined;
          return { nonce: String(order?.nonce || "") };
        });
    } catch {
      // Fallback: sequential cancel + create if bulk not supported
      if (cancelNonces.length > 0) {
        await client.orders.bulkCancel(cancelNonces);
      }
      results = [];
      for (const order of creates) {
        const r = await client.orders.create(order);
        results.push({ nonce: r.order?.nonce || "" });
      }
    }

    // Track orders locally
    type TrackedOrder = { nonce: string; side: "buy" | "sell"; price: number; size: number; marketId: string };
    const tracked: TrackedOrder[] = [
      { nonce: results[0]?.nonce || "", side: "buy", price: yesBid, size: yesBidSize, marketId: localMarketId },
      { nonce: results[1]?.nonce || "", side: "sell", price: yesAsk, size: yesAskSize, marketId: localMarketId },
      { nonce: results[2]?.nonce || "", side: "buy", price: noBid, size: noBidSize, marketId: localMarketId },
      { nonce: results[3]?.nonce || "", side: "sell", price: noAsk, size: noAskSize, marketId: localMarketId },
    ];

    const inv = yesInventory > 0 || noInventory > 0 ? ` (inv: ${yesInventory}Y/${noInventory}N)` : "";
    console.log(`[Trading] ${agentId}: priced ${localMarketId} YES ${yesBid}¢/${yesAsk}¢ NO ${noBid}¢/${noAsk}¢${inv}`);

    state.updatePrice(localMarketId, fairValueCents / 100, spreadCents / 100);
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
  if (!isApiHealthy()) return false;

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

  // Cancel existing orders on this market before trading
  try {
    const existingOrders = await client.orders.allMine(market.apiMarketId);
    const openNonces = existingOrders
      .filter((o) => o.status === "open")
      .map((o) => o.nonce as `0x${string}`);
    if (openNonces.length > 0) {
      await client.orders.bulkCancel(openNonces);
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

    // Simulate sell to get realistic price
    const sim = await simulateTrade(client, market.apiMarketId, outcome as "yes" | "no", sellSize);
    let priceCents: number;

    if (sim && sim.avgPrice > 0) {
      priceCents = Math.round(sim.avgPrice);
    } else {
      // Fallback to orderbook
      try {
        const orderbook = await client.markets.orderbook(market.apiMarketId);
        const bids = side === "YES" ? orderbook?.bids : orderbook?.asks;
        priceCents = bids?.[0]?.price
          ? Math.round(bids[0].price)
          : market.fairValue
            ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100)
            : 50;
      } catch {
        priceCents = market.fairValue ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100) : 50;
      }
    }

    try {
      await client.orders.create({
        marketId: market.apiMarketId!,
        outcome: outcome as "yes" | "no",
        side: "sell",
        priceCents: Math.max(1, Math.min(99, priceCents)),
        size: sellSize,
      });

      const price = priceCents / 100;
      const proceeds = Math.round(sellSize * price * 100) / 100;
      console.log(`[Trading] ${agentId}: SOLD ${sellSize} ${side} at ${priceCents}¢ ($${proceeds}) on ${localMarketId}`);

      state.addTrade(localMarketId, agentId, side, -sellSize, price);

      // Optimistically reduce local position so forceResolveCleanup doesn't re-fire
      if (position) {
        position.size = Math.max(0, position.size - sellSize);
      }

      broadcast({
        type: "trade_executed",
        agentId,
        marketId: localMarketId,
        side,
        size: sellSize,
        price: Math.round(price * 100) / 100,
        building: "pit",
        question: market.question,
      });
      notifyBuildingEvent("pit");

      const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 70);
      state.addAction(agentId, `sold ${side}`, `$${proceeds} on ${shortQ}`);

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

  // Simulate buy to preview fill price and slippage
  const sim = await simulateTrade(client, market.apiMarketId, outcome as "yes" | "no", size);
  let priceCents: number;

  if (sim && sim.avgPrice > 0) {
    // Check slippage — skip trade if too high
    if (sim.slippage > 10) {
      console.log(`[Trading] ${agentId}: skipping buy — slippage ${sim.slippage.toFixed(1)}% too high on ${localMarketId}`);
      return false;
    }
    priceCents = Math.round(sim.avgPrice);
  } else {
    // Fallback to orderbook
    try {
      const orderbook = await client.markets.orderbook(market.apiMarketId);
      if (side === "YES") {
        priceCents = orderbook?.asks?.[0]?.price
          ? Math.round(orderbook.asks[0].price)
          : market.fairValue ? Math.round(market.fairValue * 100) : 50;
      } else {
        priceCents = orderbook?.bids?.[0]?.price
          ? Math.round(100 - orderbook.bids[0].price)
          : market.fairValue ? Math.round((1 - market.fairValue) * 100) : 50;
      }
    } catch {
      priceCents = market.fairValue ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100) : 50;
    }
  }

  // Dynamic buy cap: ~3% of account value, clamped to what we can afford
  const maxBuyContracts = sizeFromAccount(agent, 0.03, priceCents, 5, 500);
  const maxAffordable = Math.floor((balance / priceCents) * 100);
  size = Math.min(size, maxAffordable, maxBuyContracts);
  if (size < 1) {
    console.log(`[Trading] ${agentId}: can't afford any contracts at ${priceCents}¢`);
    return false;
  }

  try {
    await client.orders.create({
      marketId: market.apiMarketId!,
      outcome: outcome as "yes" | "no",
      side: "buy",
      priceCents: Math.max(1, Math.min(99, priceCents)),
      size,
    });

    const price = priceCents / 100;
    const cost = Math.round(size * price * 100) / 100;
    console.log(`[Trading] ${agentId}: BUY ${size} ${side} at ${priceCents}¢ ($${cost}) on ${localMarketId}`);

    state.addTrade(localMarketId, agentId, side, size, price);

    broadcast({
      type: "trade_executed",
      agentId,
      marketId: localMarketId,
      side,
      size,
      price: Math.round(price * 100) / 100,
      building: "pit",
      question: market.question,
    });
    notifyBuildingEvent("pit");

    const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 70);
    state.addAction(agentId, `bought ${side}`, `$${cost} on ${shortQ}`);

    return true;
  } catch (err) {
    console.error(`[Trading] ${agentId}: buy failed on ${localMarketId}:`, err);
    return false;
  }
}
