/**
 * Order placement for pricers and traders via Context Markets SDK.
 */

import { getAgentClient } from "./client";
import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { notifyBuildingEvent } from "../agents/group-chat";
import { isApiHealthy } from "./sync";

/**
 * Place a two-sided market-making order (bid + ask) for a pricer.
 * Cancels existing orders for this market first, then places new ones.
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

  const bidPrice = Math.max(1, fairValueCents - Math.floor(spreadCents / 2));
  const askPrice = Math.min(99, fairValueCents + Math.ceil(spreadCents / 2));

  try {
    // Cancel existing orders for this market
    try {
      const existingOrders = await client.orders.allMine(market.apiMarketId);
      const openNonces = existingOrders
        .filter((o) => o.status === "open")
        .map((o) => o.nonce as `0x${string}`);

      if (openNonces.length > 0) {
        await client.orders.bulkCancel(openNonces);
      }
    } catch {
      // No existing orders or cancel failed — continue
    }

    // Place bid (buy YES at lower price)
    const bidResult = await client.orders.create({
      marketId: market.apiMarketId,
      outcome: "yes",
      side: "buy",
      priceCents: bidPrice,
      size: 10, // Standard size for MM
    });

    // Place ask (sell YES at higher price = buy NO)
    const askResult = await client.orders.create({
      marketId: market.apiMarketId,
      outcome: "yes",
      side: "sell",
      priceCents: askPrice,
      size: 10,
      inventoryModeConstraint: 2, // Allow selling without inventory
    });

    console.log(`[Trading] ${agentId}: priced ${localMarketId} at ${bidPrice}¢/${askPrice}¢`);

    // Update local state
    state.updatePrice(localMarketId, fairValueCents / 100, spreadCents / 100);

    // Update open orders tracking
    if (agent) {
      agent.openOrders = [
        { nonce: bidResult.order.nonce, side: "buy", price: bidPrice, size: 10, marketId: localMarketId },
        { nonce: askResult.order.nonce, side: "sell", price: askPrice, size: 10, marketId: localMarketId },
      ];
    }

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
 * Place a trade order for a trader agent.
 */
export async function placeTrade(
  agentId: string,
  localMarketId: string,
  side: "YES" | "NO",
  size: number,
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

  // Check balance before trading
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
      // Buy YES — use best ask, or fair value
      priceCents = orderbook?.asks?.[0]?.price
        ? Math.round(orderbook.asks[0].price)
        : market.fairValue
          ? Math.round(market.fairValue * 100)
          : 50;
    } else {
      // Buy NO = Sell YES — use best bid
      priceCents = orderbook?.bids?.[0]?.price
        ? Math.round(orderbook.bids[0].price)
        : market.fairValue
          ? Math.round((1 - market.fairValue) * 100)
          : 50;
    }
  } catch {
    priceCents = market.fairValue ? Math.round(market.fairValue * 100) : 50;
  }

  // Clamp size to affordable amount
  const maxAffordable = Math.floor((balance / priceCents) * 100);
  size = Math.min(size, maxAffordable, 100); // cap at 100 contracts
  if (size < 1) {
    console.log(`[Trading] ${agentId}: can't afford any contracts at ${priceCents}¢`);
    return false;
  }

  try {
    const outcome = side === "YES" ? "yes" : "no";
    await client.orders.create({
      marketId: market.apiMarketId,
      outcome: outcome as "yes" | "no",
      side: "buy",
      priceCents: Math.max(1, Math.min(99, priceCents)),
      size,
    });

    const price = priceCents / 100;
    const cost = Math.round(size * price * 100) / 100;
    console.log(`[Trading] ${agentId}: ${side} ${size} contracts at ${priceCents}¢ ($${cost}) on ${localMarketId}`);

    // Update local state
    state.addTrade(localMarketId, agentId, side, size, price);

    // Broadcast — size is contracts, price is decimal
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

    // Log to social context — show dollar cost, not contract count
    const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40);
    state.addAction(agentId, `traded ${side}`, `$${cost} on ${shortQ}`);

    return true;
  } catch (err) {
    console.error(`[Trading] ${agentId}: trade failed on ${localMarketId}:`, err);
    return false;
  }
}
