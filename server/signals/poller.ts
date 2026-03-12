/**
 * News system — two layers:
 *
 * 1. BRIEFING (every 30 min): Wide editorial scan across 18+ sources.
 *    One LLM call produces 15-25 stories. Cached in state.dailyBriefing.
 *    Agents see this as their "TODAY'S BRIEFING" in prompts.
 *
 * 2. REAL-TIME FEEDS (structured data, no LLM cost):
 *    - ESPN scores (5m) → state.liveScores, state.sportsSlate
 *    - Crypto prices (10m) → state.cryptoPrices
 *    - Odds (30m) → attached to sportsSlate
 *    These are queryable state, not news headlines.
 *
 * 3. BREAKING ALERTS (push, fires exactly once per event):
 *    - Game finals (from ESPN score change detection)
 *    - Crypto >5% moves (from CoinGecko)
 *    - @cnnbrk / @DeItaone new posts (from X timelines)
 *    - Oracle proposals (from Context Markets sync)
 *    Each breaking event is keyed and can only fire once.
 */

import { fetchScoreboard, type EspnGame } from "./fetchers/espn";
import { fetchCryptoPrices } from "./fetchers/coingecko";
import { fetchUserPosts, fetchMultiUserPosts } from "./fetchers/x-api";
import { fetchOdds } from "./fetchers/odds";
import { generateBriefing } from "./briefing";
import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { notifyBuildingEvent } from "../agents/group-chat";
import { searchMarketsForNews } from "../context-api/sync";
import { isContextEnabled } from "../context-api/client";

const timers: ReturnType<typeof setInterval>[] = [];
const timeouts: ReturnType<typeof setTimeout>[] = [];

// Track previous scores for change detection
let prevScores = new Map<string, string>();
// Track seen X post IDs (prevent re-processing same post)
const seenPostIds = new Set<string>();

export function startPoller(): void {
  console.log("[Poller] Starting news system (briefing + real-time + breaking)...");

  // ── Briefing (every 30 min) ──
  scheduleLoop("briefing", runBriefing, 5_000, 30 * 60_000);

  // ── Real-time structured feeds ──
  scheduleLoop("espn-daily-slate", refreshSportsSlate, 0, 4 * 60 * 60_000);      // every 4h
  scheduleLoop("espn-live-scores", refreshLiveScores, 30_000, 5 * 60_000);       // every 5m
  scheduleLoop("crypto-prices", refreshCryptoPrices, 60_000, 10 * 60_000);       // every 10m
  scheduleLoop("odds", refreshOdds, 90_000, 30 * 60_000);                        // every 30m

  // ── Breaking news feeds (X accounts that post breaking-only content) ──
  scheduleLoop("breaking-x", checkBreakingX, 120_000, 8 * 60_000);              // every 8m
}

export function stopPoller(): void {
  timers.forEach(clearInterval);
  timeouts.forEach(clearTimeout);
  timers.length = 0;
  timeouts.length = 0;
}

function scheduleLoop(id: string, fn: () => Promise<void>, initialDelayMs: number, intervalMs: number): void {
  const t = setTimeout(() => {
    console.log(`[Loop:${id}] Starting (interval: ${Math.round(intervalMs / 60_000)}m)`);
    fn().catch((err) => console.error(`[Loop:${id}] Error:`, err));
    const i = setInterval(() => {
      fn().catch((err) => console.error(`[Loop:${id}] Error:`, err));
    }, intervalMs);
    timers.push(i);
  }, initialDelayMs);
  timeouts.push(t);
}

// ── Breaking News Emit (fires exactly once per event) ──

function emitBreaking(key: string, headline: string, source: string, category: string): void {
  // Each breaking event can only fire ONCE — keyed by a unique identifier
  if (!state.markBreaking(key)) return;

  const item = state.addNews({ headline, snippet: "", source, category });
  if (!item) return; // dedup caught it

  broadcast({
    type: "news_alert",
    headline: item.headline,
    source: item.source,
    severity: "breaking" as const,
    building: "newsroom",
  });

  notifyBuildingEvent("newsroom");

  // Search Context Markets for related markets (non-blocking)
  if (isContextEnabled()) {
    searchMarketsForNews(headline).catch(() => {});
  }

  console.log(`[Breaking] ${headline.slice(0, 70)}`);

  // Reactive chatter: random agent reacts
  if (Math.random() < 0.5) {
    const agents = Array.from(state.agents.values());
    const reactor = agents[Math.floor(Math.random() * agents.length)];
    const shortHL = headline.length > 70 ? headline.slice(0, 67) + "..." : headline;
    const reactions = [
      `Whoa — ${shortHL}`,
      `Did you see this?! ${shortHL}`,
      `${shortHL} — this changes things`,
      `Big if true: ${shortHL}`,
    ];
    const msg = reactions[Math.floor(Math.random() * reactions.length)];
    setTimeout(() => {
      broadcast({
        type: "agent_speak",
        agentId: reactor.id,
        message: msg.slice(0, 140),
        emotion: "excited",
        building: reactor.location,
      });
    }, 1000 + Math.random() * 3000);
  }
}

// ── 1. Briefing Loop ──

async function runBriefing(): Promise<void> {
  const items = await generateBriefing();
  if (items.length === 0) return;

  state.dailyBriefing = {
    items,
    generatedAt: Date.now(),
  };

  console.log(`[Briefing] Cached ${items.length} items`);

  // Broadcast to frontend for ticker
  broadcast({
    type: "briefing_updated",
    count: items.length,
    categories: [...new Set(items.map((i) => i.category))],
  });
}

// ── 2. Real-Time Structured Feeds ──

async function refreshSportsSlate(): Promise<void> {
  const leagues = ["nba", "ncaab", "nhl"];
  const allGames: EspnGame[] = [];

  for (const league of leagues) {
    const games = await fetchScoreboard(league);
    allGames.push(...games);
  }

  if (allGames.length === 0) return;

  // Store full game data — no headlines emitted, just state
  state.sportsSlate = allGames.map((g) => ({
    ...g,
    spread: null,
    overUnder: null,
  }));

  console.log(`[Slate] ${allGames.length} games loaded`);
}

async function refreshOdds(): Promise<void> {
  const leagueKeys = ["nba", "ncaab", "nhl", "nfl", "mlb"] as const;
  const allOdds = (await Promise.all(leagueKeys.map((k) => fetchOdds(k)))).flat();
  if (allOdds.length === 0) return;

  const oddsMap = new Map(allOdds.map((o) => [`${o.awayTeam} @ ${o.homeTeam}`, o]));

  // Attach odds to existing slate
  for (const game of state.sportsSlate) {
    const odds = oddsMap.get(`${game.awayTeam} @ ${game.homeTeam}`);
    if (odds) {
      game.spread = odds.spread ?? null;
      game.overUnder = odds.overUnder ?? null;
    }
  }
}

async function refreshLiveScores(): Promise<void> {
  const leagues = ["nba", "ncaab", "nhl"];
  const allGames: EspnGame[] = [];

  for (const league of leagues) {
    const games = await fetchScoreboard(league);
    allGames.push(...games);
  }

  for (const game of allGames) {
    if (game.status === "pre") continue;

    const key = game.id;
    const scoreStr = `${game.awayScore}-${game.homeScore}`;
    const prev = prevScores.get(key);

    if (game.status === "post" && prev !== "final") {
      // Game just ended — BREAKING (fires exactly once per game ID)
      const headline = `Final: ${game.shortName} ${game.awayScore}-${game.homeScore}`;
      emitBreaking(`game-final-${game.id}`, headline, "ESPN", "Sports");
      prevScores.set(key, "final");
    } else if (game.status === "in" && prev !== scoreStr) {
      prevScores.set(key, scoreStr);
      // In-game updates stored as state only, no headlines
    }
  }

  // Update live scores state
  state.liveScores = allGames.filter((g) => g.status === "in");
}

async function refreshCryptoPrices(): Promise<void> {
  const prices = await fetchCryptoPrices();
  if (prices.length === 0) return;

  // Check for major moves BEFORE updating state (compare against previous)
  const prevPrices = new Map(state.cryptoPrices.map((p) => [p.symbol, p]));
  for (const p of prices) {
    if (Math.abs(p.change24h) >= 5) {
      const dir = p.change24h > 0 ? "up" : "down";
      const headline = `${p.symbol} ${dir} ${Math.abs(p.change24h).toFixed(1)}% — $${p.price.toLocaleString()}`;
      // Key by symbol + direction + rounded magnitude → fires once per move
      const magBucket = Math.floor(Math.abs(p.change24h) / 5) * 5;
      emitBreaking(`crypto-${p.symbol}-${dir}-${magBucket}pct`, headline, "CoinGecko", "Crypto");
    }
  }

  // Store for agent context
  state.cryptoPrices = prices;
}

// ── 3. Breaking X Feeds ──

async function checkBreakingX(): Promise<void> {
  // Only check accounts that post genuinely breaking content
  const posts = await fetchMultiUserPosts(["cnnbrk", "DeItaone"], 5);

  const cutoff = Date.now() - 2 * 60 * 60_000; // last 2 hours only
  for (const p of posts) {
    if (seenPostIds.has(p.id)) continue;
    seenPostIds.add(p.id);

    // Skip old posts
    if (p.createdAt && new Date(p.createdAt).getTime() < cutoff) continue;

    const text = p.text.replace(/https?:\/\/\S+/g, "").trim();
    if (text.length < 20) continue;

    const headline = text.length > 140 ? text.slice(0, 137) + "..." : text;
    emitBreaking(`x-${p.id}`, headline, `@${p.authorUsername}`, "News");
  }

  // Prevent seenPostIds from growing unbounded
  if (seenPostIds.size > 1000) {
    const arr = Array.from(seenPostIds);
    seenPostIds.clear();
    for (const id of arr.slice(-500)) seenPostIds.add(id);
  }
}
