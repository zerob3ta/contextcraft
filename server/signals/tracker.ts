import { callMinimax } from "../agents/brain";
import { searchSerper } from "./serper";
import { state, type NewsItem } from "../state";

const MAX_TRACKED_MARKETS = 5;
const TRACK_INTERVAL_MS = 5 * 60_000;

interface TrackedMarket {
  marketId: string;
  trackingQuery: string;
  interval: ReturnType<typeof setInterval>;
}

const trackers: Map<string, TrackedMarket> = new Map();

/**
 * Generate a tracking query for a market and start periodic searches.
 */
export async function startTrackingMarket(
  marketId: string,
  question: string,
  onNews: (item: NewsItem) => void
): Promise<void> {
  // Evict oldest if at capacity
  if (trackers.size >= MAX_TRACKED_MARKETS) {
    const oldest = trackers.keys().next().value;
    if (oldest) stopTrackingMarket(oldest);
  }

  const trackingQuery = await generateTrackingQuery(question);
  if (!trackingQuery) return;

  // Store on the market object
  const market = state.markets.get(marketId);
  if (market) market.trackingQuery = trackingQuery;

  // Do initial search
  await runTrackingSearch(marketId, trackingQuery, onNews);

  // Schedule periodic searches
  const interval = setInterval(
    () => runTrackingSearch(marketId, trackingQuery, onNews),
    TRACK_INTERVAL_MS
  );

  trackers.set(marketId, { marketId, trackingQuery, interval });
  console.log(`[Tracker] Started tracking ${marketId}: "${trackingQuery}"`);
}

export function stopTrackingMarket(marketId: string): void {
  const t = trackers.get(marketId);
  if (t) {
    clearInterval(t.interval);
    trackers.delete(marketId);
    console.log(`[Tracker] Stopped tracking ${marketId}`);
  }
}

export function stopAllTrackers(): void {
  for (const t of trackers.values()) {
    clearInterval(t.interval);
  }
  trackers.clear();
}

async function generateTrackingQuery(question: string): Promise<string | null> {
  try {
    const response = await callMinimax(
      "You generate concise Google search queries for tracking prediction market questions. Return ONLY the search query string, nothing else. No quotes.",
      `Generate a tracking search query for this market: "${question}"`,
    );
    return response.trim().replace(/^["']|["']$/g, "");
  } catch (err) {
    console.error("[Tracker] Failed to generate tracking query:", err);
    return null;
  }
}

async function runTrackingSearch(
  marketId: string,
  query: string,
  onNews: (item: NewsItem) => void
): Promise<void> {
  const results = await searchSerper(query, "qdr:h");
  for (const r of results) {
    const item = state.addNews({
      headline: r.title,
      snippet: r.snippet,
      source: r.link,
      category: `market:${marketId}`,
    });
    if (item) {
      onNews(item);
    }
  }
}
