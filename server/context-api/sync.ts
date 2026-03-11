/**
 * Background sync: balances, positions, and market discovery.
 * Runs periodically to keep local state in sync with Context Markets.
 */

import { getAgentClient, getReadClient } from "./client";
import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { ALL_AGENTS } from "../../src/game/config/agents";

const BALANCE_SYNC_INTERVAL_MS = 30_000; // 30s
const MARKET_SYNC_INTERVAL_MS = 60_000; // 60s

let balanceSyncTimer: ReturnType<typeof setInterval> | null = null;
let marketSyncTimer: ReturnType<typeof setInterval> | null = null;

// Circuit breaker
let consecutiveFailures = 0;
const MAX_FAILURES = 5;
const CIRCUIT_BREAK_MS = 60_000;
let circuitBrokenUntil = 0;

function isCircuitBroken(): boolean {
  if (circuitBrokenUntil > Date.now()) return true;
  return false;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    circuitBrokenUntil = Date.now() + CIRCUIT_BREAK_MS;
    console.warn(`[Context Sync] Circuit breaker tripped — pausing API calls for ${CIRCUIT_BREAK_MS / 1000}s`);
    consecutiveFailures = 0;
  }
}

/**
 * Start background sync loops.
 */
export function startSync(): void {
  console.log("[Context Sync] Starting balance + market sync loops");

  // Initial sync after a short delay
  setTimeout(() => syncBalances(), 5_000);
  setTimeout(() => syncMarkets(), 10_000);

  balanceSyncTimer = setInterval(syncBalances, BALANCE_SYNC_INTERVAL_MS);
  marketSyncTimer = setInterval(syncMarkets, MARKET_SYNC_INTERVAL_MS);
}

export function stopSync(): void {
  if (balanceSyncTimer) { clearInterval(balanceSyncTimer); balanceSyncTimer = null; }
  if (marketSyncTimer) { clearInterval(marketSyncTimer); marketSyncTimer = null; }
}

/**
 * Sync balances and positions for all trading agents.
 */
async function syncBalances(): Promise<void> {
  if (isCircuitBroken()) return;

  const tradingAgents = ALL_AGENTS.filter((a) => a.role === "pricer" || a.role === "trader");

  for (const agentCfg of tradingAgents) {
    const client = getAgentClient(agentCfg.id);
    const agent = state.agents.get(agentCfg.id);
    if (!client || !agent) continue;

    try {
      // Fetch balance
      const balance = await client.portfolio.balance();
      agent.usdcBalance = parseFloat(String(balance?.usdc?.balance ?? "0"));

      // Fetch positions
      const portfolio = await client.portfolio.get();
      const positions = portfolio?.portfolio ?? [];
      agent.positions = positions.map((p) => ({
        marketId: p.marketId,
        outcome: p.outcomeName || `index-${p.outcomeIndex}`,
        size: parseFloat(String(p.balance ?? "0")),
        avgPrice: parseFloat(String(p.netInvestment ?? "0")) / Math.max(1, parseFloat(String(p.balance ?? "1"))),
      }));

      recordSuccess();
    } catch {
      recordFailure();
    }
  }
}

/**
 * Discover active markets from Context Markets testnet.
 * Merges with locally tracked markets.
 */
async function syncMarkets(): Promise<void> {
  if (isCircuitBroken()) return;

  const client = getReadClient();
  if (!client) return;

  try {
    const result = await client.markets.list({ status: "active", limit: 50 });
    const apiMarkets = result?.markets ?? [];

    let newCount = 0;
    for (const m of apiMarkets) {
      // Skip if we already track this market
      if (state.getMarketByApiId(m.id)) continue;

      // Add as external market
      const question = m.question || m.shortQuestion || m.id;
      // Extract yes price from outcome prices if available
      const yesPrice = m.outcomePrices?.find((op) => op.outcomeIndex === 1);
      // lastPrice is in raw units (e.g. 615000 = 61.5¢), divide by 10000 to get probability 0-1
      const fairValue = yesPrice?.lastPrice ? yesPrice.lastPrice / 10000 : null;

      const localId = state.addExternalMarket({
        apiMarketId: m.id,
        question,
        fairValue,
      });

      if (localId) newCount++;
    }

    if (newCount > 0) {
      console.log(`[Context Sync] Discovered ${newCount} new markets from testnet`);
      // Broadcast market list update
      broadcast({
        type: "markets_synced",
        count: state.getActiveMarkets().length,
      });
    }

    recordSuccess();
  } catch (err) {
    console.error("[Context Sync] Market sync failed:", err);
    recordFailure();
  }
}

/**
 * Search Context Markets for markets related to a news headline.
 * Called when breaking/significant news arrives — surfaces relevant markets for agents.
 */
const SEARCH_COOLDOWN_MS = 30_000; // Don't search more than once per 30s
let lastSearchAt = 0;
const MAX_NEWS_MARKETS = 8; // Cap how many news-linked markets we track

export async function searchMarketsForNews(headline: string): Promise<void> {
  if (isCircuitBroken()) return;
  if (Date.now() - lastSearchAt < SEARCH_COOLDOWN_MS) return;
  lastSearchAt = Date.now();

  const client = getReadClient();
  if (!client) return;

  // Extract 1-2 keywords from headline for search
  const keywords = extractSearchKeywords(headline);
  if (!keywords) return;

  try {
    const result = await client.markets.search({ q: keywords, limit: 5 });
    const found = result?.markets ?? [];

    let newCount = 0;
    for (const m of found) {
      if (state.getMarketByApiId(m.id)) continue;
      if (!m.status || m.status !== "active") continue;

      const question = m.question || m.shortQuestion || m.id;
      const yesPrice = m.outcomePrices?.find((op: { outcomeIndex: number }) => op.outcomeIndex === 1);
      const fairValue = yesPrice?.lastPrice ? yesPrice.lastPrice / 10000 : null;

      const localId = state.addExternalMarket({
        apiMarketId: m.id,
        question,
        fairValue,
      });

      if (localId) {
        newCount++;
        // Add as news-linked market so agents see it
        state.addMarketNews(localId, `📰 Related to: ${headline.slice(0, 60)}`);
      }
    }

    if (newCount > 0) {
      console.log(`[Context Search] "${keywords}" → ${newCount} new markets from news`);
      broadcast({ type: "markets_synced", count: state.getActiveMarkets().length });
    }

    recordSuccess();
  } catch (err) {
    console.error(`[Context Search] Failed for "${keywords}":`, err);
    recordFailure();
  }
}

/**
 * Extract 1-2 meaningful search keywords from a news headline.
 * The Context Markets search API works best with simple queries.
 */
function extractSearchKeywords(headline: string): string | null {
  const h = headline.toLowerCase();

  // Known entity patterns — extract the most searchable term
  type ExtractFn = string | ((m: RegExpMatchArray) => string);
  const patterns: [RegExp, ExtractFn][] = [
    [/\b(bitcoin|btc)\b/, "bitcoin"],
    [/\b(ethereum|eth)\b/, "ethereum"],
    [/\b(solana|sol)\b/, "solana"],
    [/\b(trump)\b/, "trump"],
    [/\b(fed|federal reserve)\b/, "federal reserve"],
    [/\b(openai|chatgpt)\b/, "openai"],
    [/\b(nvidia)\b/, "nvidia"],
    [/\b(tesla)\b/, "tesla"],
    [/\b(apple)\b/, "apple"],
    [/\b(google)\b/, "google"],
    [/\b(spacex)\b/, "spacex"],
    [/\b(nba|nfl|nhl|ncaab?|mlb)\b/i, (m: RegExpMatchArray) => m[1].toUpperCase()],
    [/\b(lakers|celtics|cavaliers|knicks|warriors|clippers|rockets|nuggets|heat|bucks)\b/, (m: RegExpMatchArray) => m[1]],
    [/\b(ukraine|russia|china|iran|israel)\b/, (m: RegExpMatchArray) => m[1]],
    [/\b(tariff|trade war)\b/, "tariff"],
    [/\b(recession|inflation|rate cut|rate hike)\b/, (m: RegExpMatchArray) => m[0]],
  ];

  for (const [regex, extract] of patterns) {
    const match = h.match(regex);
    if (match) {
      return typeof extract === "function" ? extract(match) : extract;
    }
  }

  // Fallback: grab the first significant noun (skip common words)
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "will", "has", "have", "had", "been", "be", "do", "does", "did", "not", "no", "yes", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about", "into", "over", "after", "new", "says", "report", "reports", "just", "now", "today", "breaking", "update", "news"]);
  const words = headline.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w.toLowerCase()));

  if (words.length > 0) {
    return words[0]; // Single keyword works best with the API
  }

  return null;
}

/**
 * Check if the Context API circuit is healthy.
 */
export function isApiHealthy(): boolean {
  return !isCircuitBroken();
}
