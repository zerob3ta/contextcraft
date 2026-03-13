/**
 * Algorithmic Market Maker — runs mechanically, no LLM needed.
 *
 * The LLM pricer's job: set initial fair value on new/unpriced markets.
 * This module's job: continuously requote based on inventory, time decay, and order flow.
 *
 * Runs every tick for each pricer's active markets.
 */

import { state } from "../state";
import type { Market } from "../state";
import { placePricingOrders, cancelOrders } from "../context-api/trading";
import { isContextEnabled } from "../context-api/client";
import { broadcast } from "../ws-bridge";
import { notifyBuildingEvent } from "./group-chat";

// ─── Parameters ───

const BASE_SPREAD_CENTS = 4;       // 4¢ minimum spread
const MAX_SPREAD_CENTS = 18;       // 18¢ maximum spread
const MAX_POSITION_PER_MARKET = 200; // max contracts either side before pulling quotes
const INVENTORY_GAMMA = 0.5;       // how aggressively to skew price on inventory
const REQUOTE_INTERVAL_MS = 30_000; // mechanical requote heartbeat (30s)
const MIN_REQUOTE_INTERVAL_MS = 8_000; // don't requote faster than this

// ─── Per-pricer, per-market state ───

interface QuoteState {
  lastQuoteAt: number;
  lastFairValue: number;       // last fair value we quoted (cents)
  lastSpread: number;          // last spread we quoted (cents)
  orderFlowEma: number;       // exponential moving avg of order flow direction
  fillCount: number;           // total fills since we started quoting
  consecutiveFailures: number; // API failure count for exponential backoff
}

// Map<agentId, Map<localMarketId, QuoteState>>
const quoteStates = new Map<string, Map<string, QuoteState>>();

function getQuoteState(agentId: string, marketId: string): QuoteState {
  let agentQuotes = quoteStates.get(agentId);
  if (!agentQuotes) {
    agentQuotes = new Map();
    quoteStates.set(agentId, agentQuotes);
  }
  let qs = agentQuotes.get(marketId);
  if (!qs) {
    qs = { lastQuoteAt: 0, lastFairValue: 0, lastSpread: 0, orderFlowEma: 0, fillCount: 0, consecutiveFailures: 0 };
    agentQuotes.set(marketId, qs);
  }
  return qs;
}

// ─── Core Algorithm ───

interface QuoteResult {
  fairValueCents: number;
  spreadCents: number;
  shouldQuote: boolean;
  reason: string;
}

function computeQuote(
  market: Market,
  agentId: string,
  qs: QuoteState,
): QuoteResult {
  // === FAIR VALUE ===
  // Priority: analyst odds → market fairValue (from API/oracle) → can't quote
  let baseFV: number | null = null;
  if (market.analystOdds) {
    baseFV = market.analystOdds.probability / 100; // analyst probability is 0-100
  } else if (market.fairValue !== null) {
    baseFV = market.fairValue;
  }
  if (baseFV === null) {
    return { fairValueCents: 0, spreadCents: 0, shouldQuote: false, reason: "no fair value" };
  }
  let fvCents = Math.round(baseFV * 100);

  // === INVENTORY ===
  const agent = state.agents.get(agentId);
  if (!agent) return { fairValueCents: 0, spreadCents: 0, shouldQuote: false, reason: "no agent" };

  let yesPos = 0;
  let noPos = 0;
  if (agent.positions) {
    for (const p of agent.positions) {
      if (p.marketId === market.apiMarketId || p.marketId === market.id) {
        if (p.outcome.toLowerCase().includes("yes")) yesPos += p.size;
        if (p.outcome.toLowerCase().includes("no")) noPos += p.size;
      }
    }
  }
  // Net inventory: positive = long YES, negative = long NO
  const netInventory = yesPos - noPos;
  const maxPos = MAX_POSITION_PER_MARKET;
  const invRatio = Math.max(-1, Math.min(1, netInventory / maxPos)); // -1 to +1

  // Risk check: if way over limit, pull quotes
  if (Math.abs(netInventory) > maxPos * 1.5) {
    return { fairValueCents: fvCents, spreadCents: 0, shouldQuote: false, reason: "inventory limit exceeded" };
  }

  // Inventory shade: long YES → lower FV to attract NO buyers
  const invShade = -invRatio * INVENTORY_GAMMA * 5; // up to ±2.5¢ shade
  fvCents = Math.round(fvCents + invShade);

  // Order flow shade: if getting hit repeatedly on one side, adjust
  const flowShade = qs.orderFlowEma * 1.5; // up to ±1.5¢
  fvCents = Math.round(fvCents + flowShade);

  // Clamp
  fvCents = Math.max(3, Math.min(97, fvCents));

  // === SPREAD ===
  let spreadCents = BASE_SPREAD_CENTS;

  // Wider when inventory is heavy
  spreadCents += Math.abs(invRatio) * (MAX_SPREAD_CENTS - BASE_SPREAD_CENTS) * 0.5;

  // Wider near expiry
  if (market.deadline) {
    const remaining = new Date(market.deadline).getTime() - Date.now();
    const totalDuration = new Date(market.deadline).getTime() - market.createdAt;
    const timeLeft = totalDuration > 0 ? Math.max(0, remaining / totalDuration) : 1;

    if (remaining <= 0) {
      return { fairValueCents: fvCents, spreadCents: 0, shouldQuote: false, reason: "expired" };
    }
    if (timeLeft < 0.05) {
      return { fairValueCents: fvCents, spreadCents: 0, shouldQuote: false, reason: "near expiry" };
    }
    // Add up to 6¢ as expiry approaches
    spreadCents += (1 - timeLeft) * 6;
  }

  // Clamp spread
  spreadCents = Math.max(BASE_SPREAD_CENTS, Math.min(MAX_SPREAD_CENTS, Math.round(spreadCents)));

  return { fairValueCents: fvCents, spreadCents, shouldQuote: true, reason: "ok" };
}

// ─── Quote Trigger Logic ───

function shouldRequote(market: Market, qs: QuoteState, quote: QuoteResult): boolean {
  const now = Date.now();

  // Never requote too fast
  if (now - qs.lastQuoteAt < MIN_REQUOTE_INTERVAL_MS) return false;

  // Heartbeat: always requote after interval
  if (now - qs.lastQuoteAt >= REQUOTE_INTERVAL_MS) return true;

  // Fair value moved significantly (>2¢)
  if (Math.abs(quote.fairValueCents - qs.lastFairValue) >= 2) return true;

  // Spread changed significantly (>2¢)
  if (Math.abs(quote.spreadCents - qs.lastSpread) >= 2) return true;

  return false;
}

// ─── Public API ───

/** Track which markets each pricer is actively quoting */
const activeQuotes = new Map<string, Set<string>>(); // agentId → Set<localMarketId>

/** Register a pricer to quote a market (called when LLM sets initial price) */
export function startQuoting(agentId: string, localMarketId: string): void {
  let markets = activeQuotes.get(agentId);
  if (!markets) {
    markets = new Set();
    activeQuotes.set(agentId, markets);
  }
  markets.add(localMarketId);
}

/** Stop quoting a market (called when pulling liquidity) */
export function stopQuoting(agentId: string, localMarketId: string): void {
  const markets = activeQuotes.get(agentId);
  if (markets) {
    markets.delete(localMarketId);
    console.log(`[MM] ${agentId} stopped quoting ${localMarketId}`);
  }
}

/** Notify the MM that a fill happened — triggers immediate requote consideration */
export function notifyFill(agentId: string, localMarketId: string, side: "YES" | "NO"): void {
  const qs = getQuoteState(agentId, localMarketId);
  qs.fillCount++;
  // Update order flow EMA: +1 for YES buy (someone bought YES from us), -1 for NO buy
  const direction = side === "YES" ? 1 : -1;
  qs.orderFlowEma = 0.3 * direction + 0.7 * qs.orderFlowEma;
  // Reset last quote time to allow immediate requote
  qs.lastQuoteAt = Math.min(qs.lastQuoteAt, Date.now() - MIN_REQUOTE_INTERVAL_MS);
}

/** Get all markets a pricer is quoting */
export function getQuotedMarkets(agentId: string): string[] {
  return Array.from(activeQuotes.get(agentId) || []);
}

/** Get the number of markets being quoted across all pricers */
export function getQuotingStats(): { totalPricers: number; totalMarkets: number } {
  let totalMarkets = 0;
  for (const markets of activeQuotes.values()) {
    totalMarkets += markets.size;
  }
  return { totalPricers: activeQuotes.size, totalMarkets };
}

/**
 * Run the algorithmic MM for all pricers — called every tick.
 * This is the heartbeat. It checks each pricer's active markets
 * and requotes where needed.
 */
export async function tickMarketMaker(): Promise<void> {
  if (!isContextEnabled()) return;

  // Build work queue per pricer — process sequentially to avoid rate limits
  const perPricer: Map<string, { localMarketId: string; qs: ReturnType<typeof getQuoteState>; quote: ReturnType<typeof computeQuote> }[]> = new Map();
  const cancelPromises: Promise<void>[] = [];

  for (const [agentId, marketIds] of activeQuotes) {
    const agent = state.agents.get(agentId);
    if (!agent || agent.role !== "pricer") continue;

    const queue: { localMarketId: string; qs: ReturnType<typeof getQuoteState>; quote: ReturnType<typeof computeQuote> }[] = [];

    for (const localMarketId of marketIds) {
      const market = state.markets.get(localMarketId);
      if (!market || !market.apiMarketId) {
        marketIds.delete(localMarketId);
        continue;
      }

      // Skip resolved markets
      if (market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed" ||
          market.resolutionStatus === "pending" || market.resolutionStatus === "resolved") {
        cancelPromises.push(cancelOrders(agentId, localMarketId).then(() => {
          marketIds.delete(localMarketId);
          console.log(`[MM] ${agentId} auto-pulled from resolved ${localMarketId}`);
        }).catch(() => {}));
        continue;
      }

      const qs = getQuoteState(agentId, localMarketId);
      const quote = computeQuote(market, agentId, qs);

      if (!quote.shouldQuote) {
        if (qs.lastQuoteAt > 0) {
          cancelPromises.push(cancelOrders(agentId, localMarketId).then(() => {}).catch(() => {}));
          console.log(`[MM] ${agentId} pulling from ${localMarketId}: ${quote.reason}`);
        }
        continue;
      }

      if (!shouldRequote(market, qs, quote)) continue;

      queue.push({ localMarketId, qs, quote });
    }

    if (queue.length > 0) perPricer.set(agentId, queue);
  }

  // Process cancels in parallel (lightweight)
  if (cancelPromises.length > 0) await Promise.allSettled(cancelPromises);

  // Process each pricer's queue sequentially with throttling between markets
  // But run pricers in parallel (each pricer is a separate wallet/rate limit bucket)
  const pricerTasks = [...perPricer.entries()].map(async ([agentId, queue]) => {
    // Price up to 5 markets per tick per pricer to avoid rate limits
    const batch = queue.slice(0, 5);
    for (const { localMarketId, qs, quote } of batch) {
      try {
        const success = await placePricingOrders(agentId, localMarketId, quote.fairValueCents, quote.spreadCents);
        if (success) {
          qs.lastQuoteAt = Date.now();
          qs.lastFairValue = quote.fairValueCents;
          qs.lastSpread = quote.spreadCents;
          qs.consecutiveFailures = 0;
        } else {
          qs.consecutiveFailures = (qs.consecutiveFailures || 0) + 1;
          const backoffMs = Math.min(REQUOTE_INTERVAL_MS * Math.pow(2, qs.consecutiveFailures), 5 * 60_000);
          qs.lastQuoteAt = Date.now() - REQUOTE_INTERVAL_MS + backoffMs;
        }
      } catch {
        qs.consecutiveFailures = (qs.consecutiveFailures || 0) + 1;
        const backoffMs = Math.min(REQUOTE_INTERVAL_MS * Math.pow(2, qs.consecutiveFailures), 5 * 60_000);
        qs.lastQuoteAt = Date.now() - REQUOTE_INTERVAL_MS + backoffMs;
      }
      // Throttle: 500ms between markets per pricer
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  if (pricerTasks.length > 0) await Promise.allSettled(pricerTasks);
}

/**
 * Ensure every pricer quotes every quotable market.
 * Called periodically — finds gaps in coverage and assigns them.
 * The MM heartbeat handles requoting; LLM only needed for truly new markets (fairValue === null).
 */
export function assignUnquotedMarkets(): void {
  if (!isContextEnabled()) return;

  const allActive = state.getActiveMarkets().filter((m) => {
    if (!m.apiMarketId) return false;
    if (m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed") return false;
    if (m.resolutionStatus === "pending" || m.resolutionStatus === "resolved") return false;
    return true;
  });

  if (allActive.length === 0) return;

  // Auto-bootstrap fairValue for markets that have API data but no local price
  let bootstrapped = 0;
  for (const m of allActive) {
    if (m.fairValue !== null) continue;

    // Try to derive a fair value from available API data
    let derived: number | null = null;

    // 1. Best source: mid of bid/ask from quotes sync
    if (m.bestBid !== null && m.bestAsk !== null) {
      derived = (m.bestBid + m.bestAsk) / 2 / 100; // cents → 0-1
    } else if (m.lastTradePrice !== null) {
      // 2. Last trade price
      derived = m.lastTradePrice / 100;
    } else if (m.analystOdds) {
      // 3. Analyst odds
      derived = m.analystOdds.probability / 100;
    }

    if (derived !== null) {
      derived = Math.max(0.02, Math.min(0.98, derived));
      state.updatePrice(m.id, derived, 0.06); // 6¢ default spread
      bootstrapped++;
    }
  }

  if (bootstrapped > 0) {
    console.log(`[MM] Bootstrapped fair value for ${bootstrapped} markets from API data`);
  }

  // Divide markets among pricers — one pricer per market (round-robin)
  const quotable = allActive.filter((m) => m.fairValue !== null);
  const pricers = Array.from(state.agents.values()).filter((a) => a.role === "pricer");
  if (pricers.length === 0) return;

  // Find markets that no pricer is quoting yet
  const quotedByAnyone = new Set<string>();
  for (const [, marketIds] of activeQuotes) {
    for (const mid of marketIds) quotedByAnyone.add(mid);
  }

  const unquoted = quotable.filter((m) => !quotedByAnyone.has(m.id));
  if (unquoted.length === 0) return;

  // Round-robin assign to pricer with fewest markets
  let assigned = 0;
  for (const m of unquoted) {
    // Pick pricer with smallest book
    let minPricer = pricers[0];
    let minCount = (activeQuotes.get(minPricer.id) || new Set()).size;
    for (const p of pricers) {
      const count = (activeQuotes.get(p.id) || new Set()).size;
      if (count < minCount) {
        minPricer = p;
        minCount = count;
      }
    }
    startQuoting(minPricer.id, m.id);
    assigned++;
  }

  if (assigned > 0) {
    const breakdown = pricers.map((p) => `${p.name}:${(activeQuotes.get(p.id) || new Set()).size}`).join(", ");
    console.log(`[MM] Assigned ${assigned} new markets (${breakdown})`);
  }
}
