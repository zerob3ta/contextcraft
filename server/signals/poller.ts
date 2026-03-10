/**
 * News loop runner — manages all 14 loops from the news-loops config.
 * Each loop fetches from its source, runs through quality gate, and emits headlines.
 */

import { fetchScoreboard, type EspnGame } from "./fetchers/espn";
import { fetchCryptoPrices } from "./fetchers/coingecko";
import { scrapePage } from "./fetchers/firecrawl";
import { fetchUserPosts, fetchMultiUserPosts } from "./fetchers/x-api";
import { fetchOdds } from "./fetchers/odds";
import { qualityGate, directHeadline } from "./quality-gate";
import { state, type NewsItem } from "../state";
import { broadcast } from "../ws-bridge";

const timers: ReturnType<typeof setInterval>[] = [];
const timeouts: ReturnType<typeof setTimeout>[] = [];

// Track previous scores for change detection
let prevScores = new Map<string, string>();
// Track seen X post IDs
const seenPostIds = new Set<string>();

export function startPoller(): void {
  console.log("[Poller] Starting news loops...");

  // Stagger loop starts to avoid thundering herd
  scheduleLoop("espn-daily-slate", loop1_dailySlate, 0, 4 * 60 * 60_000);     // every 4h, start immediately
  scheduleLoop("espn-live-scores", loop2_liveScores, 30_000, 15 * 60_000);     // every 15m
  scheduleLoop("espn-headlines", loop3_espnHeadlines, 60_000, 22 * 60_000);    // every 22m
  scheduleLoop("drudge", loop4_drudge, 90_000, 60 * 60_000);                   // every 1h
  scheduleLoop("cnn-breaking", loop5_cnnBreaking, 120_000, 30 * 60_000);       // every 30m
  scheduleLoop("crypto-prices", loop6_cryptoPrices, 150_000, 15 * 60_000);     // every 15m (background)
  scheduleLoop("crypto-news", loop7_cryptoNews, 180_000, 60 * 60_000);         // every 1h
  scheduleLoop("finance-x", loop8_financeX, 210_000, 15 * 60_000);            // every 15m
  scheduleLoop("cnn-culture", loop9_cnnCulture, 240_000, 60 * 60_000);        // every 1h
  scheduleLoop("vulture", loop10_vulture, 270_000, 60 * 60_000);              // every 1h
  scheduleLoop("ew", loop11_ew, 300_000, 60 * 60_000);                        // every 1h
  scheduleLoop("weather", loop12_weather, 330_000, 6 * 60 * 60_000);          // every 6h
  scheduleLoop("hackernews", loop13_hackernews, 360_000, 60 * 60_000);        // every 1h
  scheduleLoop("techmeme", loop14_techmeme, 390_000, 60 * 60_000);            // every 1h
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

function emitHeadline(headline: string, source: string, category: string, severity: "breaking" | "normal"): void {
  const item = state.addNews({ headline, snippet: "", source, category });
  if (!item) return; // duplicate

  broadcast({
    type: "news_alert",
    headline: item.headline,
    source: item.source,
    severity,
  });
  console.log(`[News:${severity}] ${headline.slice(0, 70)}`);

  // Reactive chatter: random agent reacts to breaking news
  if (severity === "breaking" && Math.random() < 0.6) {
    const agents = Array.from(state.agents.values());
    const reactor = agents[Math.floor(Math.random() * agents.length)];
    const shortHL = headline.length > 40 ? headline.slice(0, 37) + "..." : headline;
    const reactions = [
      `Whoa — ${shortHL}`,
      `${shortHL}! Market implications...`,
      `Did you see this?! ${shortHL}`,
      `${shortHL} — this changes things`,
      `Breaking! ${shortHL}`,
      `Big if true: ${shortHL}`,
    ];
    const msg = reactions[Math.floor(Math.random() * reactions.length)];
    setTimeout(() => {
      broadcast({
        type: "agent_speak",
        agentId: reactor.id,
        message: msg.slice(0, 90),
        emotion: "excited",
      });
    }, 1000 + Math.random() * 3000);
  }
}

// ─── Loop 1: ESPN Daily Slate ──────────────────────────────────────

async function loop1_dailySlate(): Promise<void> {
  const leagues = ["nba", "ncaab", "nhl"];
  const allGames: EspnGame[] = [];

  for (const league of leagues) {
    const games = await fetchScoreboard(league);
    allGames.push(...games);
  }

  if (allGames.length === 0) return;

  // Fetch odds for NBA
  const nbaOdds = await fetchOdds("nba");
  const oddsMap = new Map(nbaOdds.map((o) => [`${o.awayTeam} @ ${o.homeTeam}`, o]));

  // Build a single "today's slate" headline
  const preGames = allGames.filter((g) => g.status === "pre");
  if (preGames.length > 0) {
    const count = preGames.length;
    const leagues = [...new Set(preGames.map((g) => g.league))].join(", ");
    const headline = `Today's slate: ${count} games across ${leagues}`;
    emitHeadline(headline, "ESPN", "Sports", "normal");
  }

  // Store full game data in state for agent context
  state.sportsSlate = allGames.map((g) => {
    const odds = oddsMap.get(`${g.awayTeam} @ ${g.homeTeam}`);
    return {
      ...g,
      spread: odds?.spread ?? null,
      overUnder: odds?.overUnder ?? null,
    };
  });
}

// ─── Loop 2: ESPN Live Scores ──────────────────────────────────────

async function loop2_liveScores(): Promise<void> {
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
      // Game just ended — breaking
      const headline = `Final: ${game.shortName} ${game.awayScore}-${game.homeScore}`;
      emitHeadline(headline, "ESPN", "Sports", "breaking");
      prevScores.set(key, "final");
    } else if (game.status === "in" && prev !== scoreStr) {
      // Score changed — normal update (stored for agents, not always broadcast)
      prevScores.set(key, scoreStr);
      // Only broadcast if significant (e.g. halftime, end of quarter)
      if (game.statusDetail.includes("Half") || game.statusDetail.includes("End")) {
        const headline = `${game.shortName}: ${game.awayScore}-${game.homeScore} (${game.statusDetail})`;
        emitHeadline(headline, "ESPN", "Sports", "normal");
      }
    }
  }

  // Update state for agent context
  state.liveScores = allGames.filter((g) => g.status === "in");
}

// ─── Loop 3: ESPN Headlines (Firecrawl) ────────────────────────────

async function loop3_espnHeadlines(): Promise<void> {
  const page = await scrapePage("https://www.espn.com");
  if (!page) return;

  const headlines = await qualityGate(page.markdown, "Sports", "ESPN homepage — look for breaking sports news only");
  for (const h of headlines) {
    emitHeadline(h.headline, "ESPN", "Sports", h.severity);
  }
}

// ─── Loop 4: Drudge Report (Firecrawl) ─────────────────────────────

async function loop4_drudge(): Promise<void> {
  const page = await scrapePage("https://www.drudgereport.com");
  if (!page) return;

  const headlines = await qualityGate(page.markdown, "News", "Drudge Report front page — grab major news headlines");
  for (const h of headlines) {
    emitHeadline(h.headline, "Drudge Report", "News", h.severity);
  }
}

// ─── Loop 5: CNN Breaking (X API) ──────────────────────────────────

async function loop5_cnnBreaking(): Promise<void> {
  const posts = await fetchUserPosts("cnnbrk", 5);
  const cutoff = Date.now() - 2 * 60 * 60_000; // only posts from last 2 hours
  for (const p of posts) {
    if (seenPostIds.has(p.id)) continue;
    seenPostIds.add(p.id);

    // Skip old posts
    if (p.createdAt && new Date(p.createdAt).getTime() < cutoff) continue;

    const text = p.text.replace(/https?:\/\/\S+/g, "").trim();
    if (text.length < 20) continue;

    const headline = text.length > 80 ? text.slice(0, 77) + "..." : text;
    emitHeadline(headline, "@cnnbrk", "News", "breaking");
  }
}

// ─── Loop 6: Crypto Prices (Background) ────────────────────────────

async function loop6_cryptoPrices(): Promise<void> {
  const prices = await fetchCryptoPrices();
  if (prices.length === 0) return;

  // Store for agent context — no headlines broadcast
  state.cryptoPrices = prices;

  // But DO broadcast if major move (>5% in 24h)
  for (const p of prices) {
    if (Math.abs(p.change24h) >= 5) {
      const dir = p.change24h > 0 ? "up" : "down";
      const headline = `${p.symbol} ${dir} ${Math.abs(p.change24h).toFixed(1)}% — $${p.price.toLocaleString()}`;
      emitHeadline(headline, "CoinGecko", "Crypto", "breaking");
    }
  }
}

// ─── Loop 7: Crypto News (Firecrawl) ───────────────────────────────

async function loop7_cryptoNews(): Promise<void> {
  const page = await scrapePage("https://www.coingecko.com/en/news");
  if (!page) return;

  const headlines = await qualityGate(page.markdown, "Crypto", "CoinGecko news page — top crypto stories");
  for (const h of headlines) {
    emitHeadline(h.headline, "CoinGecko", "Crypto", h.severity);
  }
}

// ─── Loop 8: Finance X Feeds ───────────────────────────────────────

async function loop8_financeX(): Promise<void> {
  const posts = await fetchMultiUserPosts(
    ["unusual_whales", "DeItaone", "financialjuice"],
    5
  );

  const cutoff = Date.now() - 2 * 60 * 60_000;
  for (const p of posts) {
    if (seenPostIds.has(p.id)) continue;
    seenPostIds.add(p.id);

    if (p.createdAt && new Date(p.createdAt).getTime() < cutoff) continue;

    const text = p.text.replace(/https?:\/\/\S+/g, "").trim();
    if (text.length < 20) continue;

    const headline = text.length > 80 ? text.slice(0, 77) + "..." : text;
    emitHeadline(headline, `@${p.authorUsername}`, "Stocks", "breaking");
  }
}

// ─── Loops 9-11: Culture (Firecrawl) ───────────────────────────────

async function loop9_cnnCulture(): Promise<void> {
  const page = await scrapePage("https://www.cnn.com/entertainment");
  if (!page) return;
  const headlines = await qualityGate(page.markdown, "Culture", "CNN Entertainment — 1-3 noteworthy headlines");
  for (const h of headlines) {
    emitHeadline(h.headline, "CNN", "Culture", h.severity);
  }
}

async function loop10_vulture(): Promise<void> {
  const page = await scrapePage("https://www.vulture.com/");
  if (!page) return;
  const headlines = await qualityGate(page.markdown, "Culture", "Vulture — 1-3 noteworthy entertainment headlines");
  for (const h of headlines) {
    emitHeadline(h.headline, "Vulture", "Culture", h.severity);
  }
}

async function loop11_ew(): Promise<void> {
  const page = await scrapePage("https://ew.com/");
  if (!page) return;
  const headlines = await qualityGate(page.markdown, "Culture", "Entertainment Weekly — 1-3 noteworthy headlines");
  for (const h of headlines) {
    emitHeadline(h.headline, "EW", "Culture", h.severity);
  }
}

// ─── Loop 12: Weather (Firecrawl) ──────────────────────────────────

async function loop12_weather(): Promise<void> {
  const page = await scrapePage("https://weather.com/");
  if (!page) return;
  const headlines = await qualityGate(page.markdown, "Weather", "Weather.com — only breaking weather events (storms, extremes, disasters)");
  for (const h of headlines) {
    emitHeadline(h.headline, "Weather.com", "Weather", h.severity);
  }
}

// ─── Loops 13-14: Tech (Firecrawl) ────────────────────────────────

async function loop13_hackernews(): Promise<void> {
  const page = await scrapePage("https://news.ycombinator.com/");
  if (!page) return;
  const headlines = await qualityGate(page.markdown, "Tech", "Hacker News front page — only genuinely breaking tech news, not Show HN or Ask HN");
  for (const h of headlines) {
    emitHeadline(h.headline, "Hacker News", "Tech", h.severity);
  }
}

async function loop14_techmeme(): Promise<void> {
  const page = await scrapePage("https://www.techmeme.com/");
  if (!page) return;
  const headlines = await qualityGate(page.markdown, "Tech", "Techmeme — top 1-3 breaking tech stories");
  for (const h of headlines) {
    emitHeadline(h.headline, "Techmeme", "Tech", h.severity);
  }
}
