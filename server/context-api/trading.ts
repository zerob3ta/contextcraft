/**
 * Order placement for pricers and traders via Context Markets SDK.
 *
 * Pricers: Cancel all existing orders, then place 4 orders (YES bid/ask + NO bid/ask).
 * Traders: Can buy or sell. Cancels stale orders before placing new ones.
 */

import { getAgentClient } from "./client";
import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { notifyBuildingEvent } from "../agents/group-chat";
import { isApiHealthy } from "./sync";

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
      await client.orders.bulkCancel(openNonces);
      console.log(`[Trading] ${agentId}: cancelled ${openNonces.length} orders on ${localMarketId}`);
    }

    // Clear tracked orders
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
 * Place a two-sided market on both YES and NO orderbooks.
 * Cancels ALL existing orders for this market first.
 *
 * Places 4 orders:
 *   YES buy  at (fair - spread/2)  — bid on YES
 *   YES sell at (fair + spread/2)  — ask on YES
 *   NO  buy  at (100 - fair - spread/2)  — bid on NO
 *   NO  sell at (100 - fair + spread/2)  — ask on NO
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

  // Determine size based on inventory — reduce size on side where we're long
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

  const baseSize = 10;
  // Skew sizes: offer more on the side where we're long (to offload inventory)
  const yesBidSize = Math.max(5, baseSize - Math.min(5, Math.floor(yesInventory / 10)));
  const yesAskSize = Math.max(5, baseSize + Math.min(5, Math.floor(yesInventory / 10)));
  const noBidSize = Math.max(5, baseSize - Math.min(5, Math.floor(noInventory / 10)));
  const noAskSize = Math.max(5, baseSize + Math.min(5, Math.floor(noInventory / 10)));

  try {
    // Cancel ALL existing orders for this market first
    await cancelOrders(agentId, localMarketId);

    type TrackedOrder = { nonce: string; side: "buy" | "sell"; price: number; size: number; marketId: string };
    const orders: TrackedOrder[] = [];

    // YES side
    const yesBidResult = await client.orders.create({
      marketId: market.apiMarketId,
      outcome: "yes",
      side: "buy",
      priceCents: yesBid,
      size: yesBidSize,
    });
    orders.push({ nonce: yesBidResult.order.nonce, side: "buy", price: yesBid, size: yesBidSize, marketId: localMarketId });

    const yesAskResult = await client.orders.create({
      marketId: market.apiMarketId,
      outcome: "yes",
      side: "sell",
      priceCents: yesAsk,
      size: yesAskSize,
      inventoryModeConstraint: 2,
    });
    orders.push({ nonce: yesAskResult.order.nonce, side: "sell", price: yesAsk, size: yesAskSize, marketId: localMarketId });

    // NO side
    const noBidResult = await client.orders.create({
      marketId: market.apiMarketId,
      outcome: "no",
      side: "buy",
      priceCents: noBid,
      size: noBidSize,
    });
    orders.push({ nonce: noBidResult.order.nonce, side: "buy", price: noBid, size: noBidSize, marketId: localMarketId });

    const noAskResult = await client.orders.create({
      marketId: market.apiMarketId,
      outcome: "no",
      side: "sell",
      priceCents: noAsk,
      size: noAskSize,
      inventoryModeConstraint: 2,
    });
    orders.push({ nonce: noAskResult.order.nonce, side: "sell", price: noAsk, size: noAskSize, marketId: localMarketId });

    const inv = yesInventory > 0 || noInventory > 0 ? ` (inv: ${yesInventory}Y/${noInventory}N)` : "";
    console.log(`[Trading] ${agentId}: priced ${localMarketId} YES ${yesBid}¢/${yesAsk}¢ NO ${noBid}¢/${noAsk}¢${inv}`);

    // Update local state
    state.updatePrice(localMarketId, fairValueCents / 100, spreadCents / 100);
    agent.openOrders = orders;

    // Broadcast
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
 * Place a trade order for a trader agent. Supports buy and sell.
 *
 * Buy: places a buy order on the specified outcome (YES/NO).
 * Sell: sells existing position — places a sell order if agent holds inventory.
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

  const client = getAgentClient(agentId);
  if (!client) return false;

  const agent = state.agents.get(agentId);
  if (!agent) return false;

  // Cancel any existing orders on this market before trading
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
    // Selling: check that we have a position to sell
    const position = (agent.positions || []).find(
      (p) => (p.marketId === market.apiMarketId || p.marketId === localMarketId)
        && p.outcome.toLowerCase().includes(outcome)
    );

    if (!position || position.size < 1) {
      console.log(`[Trading] ${agentId}: no ${side} position to sell on ${localMarketId}`);
      return false;
    }

    const sellSize = Math.min(size, Math.floor(position.size), 100);
    if (sellSize < 1) return false;

    // Get current price for the sell order
    let priceCents: number;
    try {
      const orderbook = await client.markets.orderbook(market.apiMarketId);
      // Selling YES: use best bid; Selling NO: use NO best bid
      const bids = side === "YES" ? orderbook?.bids : orderbook?.asks;
      priceCents = bids?.[0]?.price
        ? Math.round(bids[0].price)
        : market.fairValue
          ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100)
          : 50;
    } catch {
      priceCents = market.fairValue ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100) : 50;
    }

    try {
      await client.orders.create({
        marketId: market.apiMarketId,
        outcome: outcome as "yes" | "no",
        side: "sell",
        priceCents: Math.max(1, Math.min(99, priceCents)),
        size: sellSize,
      });

      const price = priceCents / 100;
      const proceeds = Math.round(sellSize * price * 100) / 100;
      console.log(`[Trading] ${agentId}: SOLD ${sellSize} ${side} at ${priceCents}¢ ($${proceeds}) on ${localMarketId}`);

      state.addTrade(localMarketId, agentId, side, -sellSize, price);

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

      const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40);
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

  // Get current price from orderbook
  let priceCents: number;
  try {
    const orderbook = await client.markets.orderbook(market.apiMarketId);
    if (side === "YES") {
      priceCents = orderbook?.asks?.[0]?.price
        ? Math.round(orderbook.asks[0].price)
        : market.fairValue
          ? Math.round(market.fairValue * 100)
          : 50;
    } else {
      // Buy NO — use NO asks or derive from YES
      priceCents = orderbook?.bids?.[0]?.price
        ? Math.round(100 - orderbook.bids[0].price)
        : market.fairValue
          ? Math.round((1 - market.fairValue) * 100)
          : 50;
    }
  } catch {
    priceCents = market.fairValue ? Math.round((side === "YES" ? market.fairValue : 1 - market.fairValue) * 100) : 50;
  }

  // Clamp size to affordable amount
  const maxAffordable = Math.floor((balance / priceCents) * 100);
  size = Math.min(size, maxAffordable, 100);
  if (size < 1) {
    console.log(`[Trading] ${agentId}: can't afford any contracts at ${priceCents}¢`);
    return false;
  }

  try {
    await client.orders.create({
      marketId: market.apiMarketId,
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

    const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40);
    state.addAction(agentId, `bought ${side}`, `$${cost} on ${shortQ}`);

    return true;
  } catch (err) {
    console.error(`[Trading] ${agentId}: buy failed on ${localMarketId}:`, err);
    return false;
  }
}
