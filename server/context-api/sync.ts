/**
 * Background sync: balances, positions, and market discovery.
 * Runs periodically to keep local state in sync with Context Markets.
 */

import { getAgentClient, getReadClient } from "./client";
import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { ALL_AGENTS } from "../../src/game/config/agents";
import { notifyBuildingEvent } from "../agents/group-chat";

const BALANCE_SYNC_INTERVAL_MS = 30_000; // 30s
const MARKET_SYNC_INTERVAL_MS = 60_000; // 60s
const TOPIC_SEARCH_INTERVAL_MS = 120_000; // 2min — search based on chat topics

let balanceSyncTimer: ReturnType<typeof setInterval> | null = null;
let marketSyncTimer: ReturnType<typeof setInterval> | null = null;
let topicSearchTimer: ReturnType<typeof setInterval> | null = null;

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
  setTimeout(() => searchChatTopics(), 30_000);

  balanceSyncTimer = setInterval(syncBalances, BALANCE_SYNC_INTERVAL_MS);
  marketSyncTimer = setInterval(syncMarkets, MARKET_SYNC_INTERVAL_MS);
  topicSearchTimer = setInterval(searchChatTopics, TOPIC_SEARCH_INTERVAL_MS);
}

export function stopSync(): void {
  if (balanceSyncTimer) { clearInterval(balanceSyncTimer); balanceSyncTimer = null; }
  if (marketSyncTimer) { clearInterval(marketSyncTimer); marketSyncTimer = null; }
  if (topicSearchTimer) { clearInterval(topicSearchTimer); topicSearchTimer = null; }
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
      const question = m.question || m.shortQuestion || m.id;
      const yesPrice = m.outcomePrices?.find((op) => op.outcomeIndex === 1);
      // lastPrice is in raw units (e.g. 615000 = 61.5¢), divide by 10000 to get probability 0-1
      const fairValue = yesPrice?.lastPrice ? yesPrice.lastPrice / 10000 : null;

      // Check if we already track this market
      const existing = state.getMarketByApiId(m.id);
      if (existing) {
        // Update price if it changed significantly (>3¢ move)
        if (fairValue !== null && existing.fairValue !== null) {
          const oldCents = Math.round(existing.fairValue * 100);
          const newCents = Math.round(fairValue * 100);
          const delta = Math.abs(newCents - oldCents);
          if (delta >= 3) {
            state.updatePrice(existing.id, fairValue, existing.spread || 0);
            const shortQ = question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 50);
            const dir = newCents > oldCents ? "up" : "down";
            const headline = `Oracle: "${shortQ}" moved ${dir} to ${newCents}¢ (was ${oldCents}¢)`;
            state.addNews({ headline, snippet: "", source: "Oracle", category: "Markets" });
            broadcast({ type: "news_alert", headline, source: "Oracle", severity: "normal", building: "newsroom" });
            notifyBuildingEvent("newsroom");
            notifyBuildingEvent("exchange");
          }
        } else if (fairValue !== null && existing.fairValue === null) {
          state.updatePrice(existing.id, fairValue, existing.spread || 0);
        }
        continue;
      }

      // Add as external market
      const localId = state.addExternalMarket({
        apiMarketId: m.id,
        question,
        fairValue,
      });

      if (localId) newCount++;
    }

    if (newCount > 0) {
      console.log(`[Context Sync] Discovered ${newCount} new markets from testnet`);
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
 * Every 2 minutes, extract trending topics from recent chat + news and search
 * Context Markets for related markets. This lets agents trade on topics they're
 * already discussing (e.g. Iran, Bitcoin, elections) without waiting for news.
 */
const searchedTopics = new Set<string>(); // avoid re-searching same topics
const SEARCHED_TOPIC_TTL_MS = 10 * 60_000; // forget after 10min
let searchedTopicTimers: ReturnType<typeof setTimeout>[] = [];

async function searchChatTopics(): Promise<void> {
  if (isCircuitBroken()) return;

  const client = getReadClient();
  if (!client) return;

  // Gather text from recent chat + news
  const recentChat = state.getRecentSocialContext(15);
  const recentNews = state.getRecentNews(10);
  const allText = [
    ...recentChat.map((l) => l),
    ...recentNews.map((n) => n.headline),
  ].join(" ");

  // Extract unique searchable topics
  const topics = extractTopicsFromText(allText);
  const newTopics = topics.filter((t) => !searchedTopics.has(t));

  if (newTopics.length === 0) return;

  // Search for up to 3 new topics per cycle
  for (const topic of newTopics.slice(0, 3)) {
    searchedTopics.add(topic);
    // Auto-expire after TTL
    const timer = setTimeout(() => searchedTopics.delete(topic), SEARCHED_TOPIC_TTL_MS);
    searchedTopicTimers.push(timer);

    try {
      const result = await client.markets.search({ q: topic, limit: 5 });
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

        if (localId) newCount++;
      }

      if (newCount > 0) {
        console.log(`[Context Search] Topic "${topic}" → ${newCount} new markets`);
        broadcast({ type: "markets_synced", count: state.getActiveMarkets().length });
      }

      recordSuccess();
    } catch {
      recordFailure();
    }
  }
}

/**
 * Extract searchable topics from a block of text (chat + news combined).
 */
function extractTopicsFromText(text: string): string[] {
  const t = text.toLowerCase();
  const found: string[] = [];

  const topicPatterns: [RegExp, string][] = [
    [/\biran\b/, "iran"],
    [/\bbitcoin|btc\b/, "bitcoin"],
    [/\bethereum|eth\b/, "ethereum"],
    [/\bsolana\b/, "solana"],
    [/\btrump\b/, "trump"],
    [/\bbiden\b/, "biden"],
    [/\belection\b/, "election"],
    [/\bfed\b|federal reserve/, "federal reserve"],
    [/\btariff\b/, "tariff"],
    [/\brecession\b/, "recession"],
    [/\binflation\b/, "inflation"],
    [/\bnvidia\b/, "nvidia"],
    [/\btesla\b/, "tesla"],
    [/\bapple\b(?!.*sauce)/, "apple"],
    [/\bgoogle\b/, "google"],
    [/\bopenai\b|chatgpt/, "openai"],
    [/\bspacex\b/, "spacex"],
    [/\bukraine\b/, "ukraine"],
    [/\brussia\b/, "russia"],
    [/\bchina\b/, "china"],
    [/\bisrael\b/, "israel"],
    [/\bnorth korea\b/, "north korea"],
    [/\bsuper bowl\b/, "super bowl"],
    [/\bmarch madness\b|ncaa tournament/, "march madness"],
    [/\bnba playoff\b/, "nba playoffs"],
    [/\bworld cup\b/, "world cup"],
    [/\bolympic\b/, "olympics"],
    [/\bai regulation\b|ai safety/, "AI regulation"],
    [/\brate cut\b|rate hike/, "interest rates"],
    [/\bceasefire\b/, "ceasefire"],
    [/\bbank.*fail\b|banking crisis/, "banking crisis"],
  ];

  for (const [regex, topic] of topicPatterns) {
    if (regex.test(t) && !found.includes(topic)) {
      found.push(topic);
    }
  }

  return found;
}

/**
 * Search Context Markets for markets related to a news headline.
 * Called when news arrives — surfaces relevant markets for agents.
 */
const SEARCH_COOLDOWN_MS = 15_000; // Don't search more than once per 15s
let lastSearchAt = 0;

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
