/**
 * Smart grounding layer for agent LLM calls.
 *
 * Decides whether to use existing local context (news, scores, prices)
 * or fetch fresh web search results via Brave. Injects grounding into prompts.
 */

import { state } from "../state";
import { braveSearch, formatSearchResults } from "../signals/fetchers/brave-search";

// Rate limit: don't search the same topic within 2 minutes
const searchCache = new Map<string, { result: string; ts: number }>();
const CACHE_TTL_MS = 2 * 60_000;

// Global rate limit: max 10 searches per minute
let searchesThisMinute = 0;
let minuteResetAt = 0;
const MAX_SEARCHES_PER_MINUTE = 10;

function canSearch(): boolean {
  const now = Date.now();
  if (now > minuteResetAt) {
    searchesThisMinute = 0;
    minuteResetAt = now + 60_000;
  }
  return searchesThisMinute < MAX_SEARCHES_PER_MINUTE;
}

function recordSearch(): void {
  searchesThisMinute++;
}

/**
 * Build grounding context for a job agent (creator/pricer/trader).
 * Returns a string to inject into the user prompt, or empty if no grounding needed.
 */
export async function getJobGrounding(
  role: string,
  topic: string,
  marketQuestion?: string,
): Promise<string> {
  const parts: string[] = [];

  // Step 1: Check what local context we already have
  const localContext = getLocalContext(topic, marketQuestion);
  if (localContext) {
    parts.push(localContext);
  }

  // Step 2: Decide if we need a web search
  const searchQuery = buildSearchQuery(role, topic, marketQuestion);
  if (searchQuery && shouldWebSearch(topic, localContext)) {
    const webContext = await cachedSearch(searchQuery);
    if (webContext) {
      parts.push("\nWEB SEARCH RESULTS (use for grounding — cite facts, not opinions):");
      parts.push(webContext);
    }
  }

  if (parts.length === 0) return "";
  return "\n--- GROUNDING CONTEXT ---\n" + parts.join("\n");
}

/**
 * Build grounding context for chat messages.
 * Lighter weight — only searches when the conversation topic clearly needs it.
 */
export async function getChatGrounding(
  agentLocation: string,
  recentMessages: string[],
): Promise<string> {
  // Only ground when in newsroom, exchange, or pit (where facts matter)
  if (agentLocation !== "newsroom" && agentLocation !== "exchange" && agentLocation !== "pit") return "";

  // Extract a searchable topic from recent messages
  const combined = recentMessages.join(" ");
  const topic = extractGroundingTopic(combined);
  if (!topic) return "";

  // Check local context first
  const localContext = getLocalContext(topic);
  if (localContext) return localContext;

  // Light web search for factual grounding
  if (!shouldWebSearch(topic, null)) return "";
  const webContext = await cachedSearch(topic);
  if (!webContext) return "";

  return "\nFACT CHECK (ground your response in these):\n" + webContext;
}

// ── Local Context Assembly ──

function getLocalContext(topic: string, marketQuestion?: string): string | null {
  const t = (topic + " " + (marketQuestion || "")).toLowerCase();
  const parts: string[] = [];

  // Sports context — scores, games, odds
  if (matchesSports(t)) {
    const slate = state.sportsSlate;
    const live = state.liveScores;

    if (live.length > 0) {
      parts.push("LIVE SCORES:");
      for (const g of live.slice(0, 8)) {
        parts.push(`  ${g.shortName}: ${g.awayScore}-${g.homeScore} (${g.statusDetail})`);
      }
    }

    // Find specific game if mentioned
    const relevantGames = slate.filter((g) => {
      const gText = `${g.shortName} ${g.homeTeam} ${g.awayTeam}`.toLowerCase();
      return t.split(/\s+/).some((w) => w.length > 3 && gText.includes(w));
    });

    if (relevantGames.length > 0) {
      parts.push("RELEVANT GAMES:");
      for (const g of relevantGames.slice(0, 5)) {
        const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
        const score = g.status === "in" ? ` ${g.awayScore}-${g.homeScore}` : "";
        parts.push(`  [${g.league.toUpperCase()}] ${g.shortName}${score} — ${g.status === "pre" ? g.startTime : g.statusDetail}${odds}`);
      }
    } else if (slate.length > 0 && parts.length === 0) {
      // Show general slate
      parts.push("TODAY'S GAMES:");
      for (const g of slate.slice(0, 6)) {
        const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
        parts.push(`  [${g.league.toUpperCase()}] ${g.shortName} — ${g.status === "pre" ? g.startTime : g.statusDetail}${odds}`);
      }
    }
  }

  // Crypto context
  if (matchesCrypto(t)) {
    const prices = state.cryptoPrices;
    if (prices.length > 0) {
      parts.push("CRYPTO PRICES:");
      for (const p of prices.slice(0, 6)) {
        const dir = p.change24h > 0 ? "+" : "";
        parts.push(`  ${p.symbol}: $${p.price.toLocaleString()} (${dir}${p.change24h.toFixed(1)}% 24h)`);
      }
    }
  }

  // Oracle qualitative context for pricers/traders
  const markets = state.getActiveMarkets();
  const withOracle = markets.filter((m) => m.oracleSummary);
  if (withOracle.length > 0) {
    parts.push("ORACLE NOTES (qualitative — one model's take, not gospel):");
    for (const m of withOracle.slice(0, 5)) {
      const shortQ = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
      const confStr = m.oracleConfidence ? ` (${m.oracleConfidence})` : "";
      parts.push(`  "${shortQ}" — ${m.oracleSummary}${confStr}`);
    }
  }

  // Recent relevant news
  const news = state.getRecentNews(10);
  const relevantNews = news.filter((n) => {
    const nText = n.headline.toLowerCase();
    return t.split(/\s+/).some((w) => w.length > 3 && nText.includes(w));
  });
  if (relevantNews.length > 0) {
    parts.push("RELATED NEWS:");
    for (const n of relevantNews.slice(0, 4)) {
      const ago = Math.round((Date.now() - n.timestamp) / 60_000);
      parts.push(`  - ${n.headline} (${ago}min ago)`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

// ── Search Decision Logic ──

function shouldWebSearch(topic: string, localContext: string | null): boolean {
  if (!process.env.BRAVE_SEARCH_API_KEY) return false;
  if (!canSearch()) return false;

  // If we have rich local context, skip the search
  if (localContext && localContext.split("\n").length > 5) return false;

  // Always search for topics that need current facts
  const needsSearch = [
    /election|poll|vote|ballot/i,
    /fed|rate cut|rate hike|fomc/i,
    /war|ceasefire|invasion|strike/i,
    /regulation|bill|law|executive order/i,
    /ipo|merger|acquisition|earnings/i,
    /record|all.time|milestone|first.ever/i,
    /iran|ukraine|russia|china|israel|north korea/i,
    /scandal|resign|impeach|indict/i,
  ];

  if (needsSearch.some((r) => r.test(topic))) return true;

  // Search if we have no local context at all
  if (!localContext) return true;

  return false;
}

function buildSearchQuery(role: string, topic: string, marketQuestion?: string): string | null {
  // For creators: search the topic they want to create a market about
  if (role === "creator" && topic) {
    return `${topic} latest news 2026`;
  }

  // For pricers/traders: search the market question for current facts
  if (marketQuestion) {
    // Strip "Will" prefix and "?" suffix, add "latest"
    const cleaned = marketQuestion.replace(/^Will\s+/i, "").replace(/\?$/, "").trim();
    return `${cleaned} latest`;
  }

  // Fallback: search the raw topic
  if (topic && topic.length > 5) {
    return topic;
  }

  return null;
}

// ── Cached Search ──

async function cachedSearch(query: string): Promise<string | null> {
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  recordSearch();
  const results = await braveSearch(query, 4);
  const formatted = formatSearchResults(results);

  if (formatted) {
    searchCache.set(cacheKey, { result: formatted, ts: Date.now() });
    // Evict old cache entries
    if (searchCache.size > 50) {
      const oldest = [...searchCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) searchCache.delete(oldest[0]);
    }
  }

  return formatted || null;
}

// ── Topic Extraction ──

function extractGroundingTopic(text: string): string | null {
  const t = text.toLowerCase();

  const patterns: [RegExp, string][] = [
    [/\b(iran|iranian)\b/, "iran"],
    [/\b(ukraine|ukrainian)\b/, "ukraine"],
    [/\b(russia|russian)\b/, "russia"],
    [/\b(china|chinese)\b/, "china"],
    [/\b(israel|israeli)\b/, "israel"],
    [/\b(bitcoin|btc)\b/, "bitcoin price"],
    [/\b(ethereum|eth)\b/, "ethereum price"],
    [/\b(fed|federal reserve|fomc)\b/, "federal reserve"],
    [/\b(trump)\b/, "trump"],
    [/\b(election)\b/, "election"],
    [/\b(tariff|trade war)\b/, "tariff"],
  ];

  for (const [regex, topic] of patterns) {
    if (regex.test(t)) return topic;
  }

  return null;
}

// ── Matchers ──

function matchesSports(text: string): boolean {
  return /\b(nba|nfl|nhl|mlb|ncaa|game|score|spread|lakers|celtics|knicks|warriors|rangers|yankees|dodgers|beat|win|lose|upset|playoff)/i.test(text);
}

function matchesCrypto(text: string): boolean {
  return /\b(bitcoin|btc|ethereum|eth|crypto|solana|sol|defi|token|altcoin)/i.test(text);
}
