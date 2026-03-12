/**
 * Batched Editorial Briefing — replaces 14 individual news loops.
 *
 * Every 30 minutes:
 * 1. Scrape ~18 URLs via Firecrawl in parallel
 * 2. Fetch X timelines from ~15 accounts + run X search queries
 * 3. Run Brave Search for trending topics
 * 4. Concatenate everything, run ONE LLM editorial call
 * 5. Cache the result as state.dailyBriefing
 *
 * Structured data (ESPN scores, crypto prices) stays as separate lightweight refreshes.
 */

import { scrapePage } from "./fetchers/firecrawl";
import { fetchMultiUserPosts, searchXPosts } from "./fetchers/x-api";
import { braveSearch, formatSearchResults } from "./fetchers/brave-search";
import { callMinimax } from "../agents/brain";
import { state } from "../state";

export interface BriefingItem {
  headline: string;
  category: string;
  summary: string;
  marketability: "high" | "medium" | "low";
}

// ── Source Configuration ──

const FIRECRAWL_SOURCES: { url: string; label: string; category: string }[] = [
  // Sports
  { url: "https://www.espn.com", label: "ESPN", category: "Sports" },
  { url: "https://theathletic.com", label: "The Athletic", category: "Sports" },
  // News/Politics
  { url: "https://www.drudgereport.com", label: "Drudge Report", category: "News" },
  { url: "https://apnews.com", label: "AP News", category: "News" },
  { url: "https://www.reuters.com", label: "Reuters", category: "News" },
  // Crypto
  { url: "https://www.coingecko.com/en/news", label: "CoinGecko News", category: "Crypto" },
  { url: "https://www.coindesk.com", label: "CoinDesk", category: "Crypto" },
  // Tech/AI
  { url: "https://news.ycombinator.com/", label: "Hacker News", category: "Tech" },
  { url: "https://www.techmeme.com/", label: "Techmeme", category: "Tech" },
  { url: "https://www.theverge.com/", label: "The Verge", category: "Tech" },
  // Culture/Entertainment
  { url: "https://www.vulture.com/", label: "Vulture", category: "Culture" },
  { url: "https://www.tmz.com/", label: "TMZ", category: "Culture" },
  // Business
  { url: "https://www.cnbc.com/", label: "CNBC", category: "Business" },
  // Science/Space
  { url: "https://www.space.com/", label: "Space.com", category: "Science" },
  // Legal
  { url: "https://www.scotusblog.com/", label: "SCOTUSblog", category: "Legal" },
  // Weather
  { url: "https://weather.com/", label: "Weather.com", category: "Weather" },
  // Global
  { url: "https://www.bbc.com/news/world", label: "BBC World", category: "Global" },
  // Gaming
  { url: "https://www.ign.com/", label: "IGN", category: "Gaming" },
];

const X_TIMELINE_ACCOUNTS: { username: string; category: string }[] = [
  // Breaking
  { username: "cnnbrk", category: "News" },
  // Finance
  { username: "unusual_whales", category: "Business" },
  { username: "DeItaone", category: "Business" },
  { username: "financialjuice", category: "Business" },
  // Sports
  { username: "espn", category: "Sports" },
  { username: "sportscenter", category: "Sports" },
  { username: "wojaborta", category: "Sports" }, // NBA insider
  { username: "ShamsCharania", category: "Sports" },
  // Crypto
  { username: "coinaborta", category: "Crypto" },
  { username: "whale_alert", category: "Crypto" },
  // Tech/AI
  { username: "OpenAI", category: "Tech" },
  { username: "AnthropicAI", category: "Tech" },
  // Politics
  { username: "AP", category: "News" },
  { username: "Reuters", category: "News" },
  // Culture
  { username: "variety", category: "Culture" },
];

const X_SEARCH_QUERIES: { query: string; category: string }[] = [
  { query: '"breaking" min_faves:1000 -is:retweet', category: "News" },
  { query: '"just announced" OR "officially" min_faves:500 -is:retweet', category: "News" },
  { query: '"IPO" OR "acquisition" OR "merger" min_faves:200 -is:retweet', category: "Business" },
  { query: '"hurricane" OR "earthquake" OR "wildfire" OR "tornado" min_faves:300 -is:retweet', category: "Weather" },
  { query: '"Supreme Court" OR "ruling" OR "verdict" min_faves:200 -is:retweet', category: "Legal" },
  { query: '"launch" ("SpaceX" OR "NASA" OR "rocket") min_faves:200 -is:retweet', category: "Science" },
];

const BRAVE_QUERIES: { query: string; category: string }[] = [
  { query: "top news today", category: "News" },
  { query: "stock market news today", category: "Business" },
  { query: "AI news today", category: "Tech" },
  { query: "box office results this weekend", category: "Culture" },
];

// ── Editorial LLM Prompt ──

function buildEditorialPrompt(date: string): string {
  return `You are the editor of a prediction market intelligence briefing. Your readers create, price, and trade prediction markets on real-world events.

Given raw content from multiple sources, produce TODAY'S BRIEFING — the top 15-25 stories across ALL categories. Cast a wide net. Your readers need to know what's happening everywhere, not just the biggest story.

For each story:
- headline (under 80 chars, factual, no clickbait)
- category (Sports, Crypto, Tech, Politics, Business, Culture, Science, Legal, Weather, Global, Gaming)
- summary (one sentence, what happened and why it matters for prediction markets)
- marketability: "high" if this has a clear yes/no outcome or deadline, "medium" if maybe, "low" if background context

RULES:
- Cover EVERY category that has news today. Don't skip categories.
- Prioritize stories with uncertainty, deadlines, or upcoming decisions — these make the best markets.
- Include upcoming events (game schedules, votes, launches, earnings) not just things that happened.
- For sports: include today's key matchups and storylines.
- For business: earnings reports, Fed decisions, economic data releases.
- For politics: scheduled votes, hearings, diplomatic meetings.
- Dedup: if multiple sources cover the same story, merge into one entry.
- Do NOT include generic listicles, opinion pieces, or "X things to know about Y" articles.
- Today's date: ${date}

Return a JSON array: [{"headline":"...","category":"...","summary":"...","marketability":"high"|"medium"|"low"}]`;
}

// ── Core Briefing Engine ──

/**
 * Generate the editorial briefing. Fetches from all sources in parallel,
 * concatenates raw content, and runs one LLM editorial call.
 */
export async function generateBriefing(): Promise<BriefingItem[]> {
  console.log("[Briefing] Starting editorial scan...");
  const startTime = Date.now();

  // Phase 1: Parallel fetch from all sources
  const [firecrawlResults, xTimelineResults, xSearchResults, braveResults] = await Promise.allSettled([
    fetchAllFirecrawl(),
    fetchAllXTimelines(),
    fetchAllXSearches(),
    fetchAllBraveSearches(),
  ]);

  // Phase 2: Concatenate raw content with source labels
  const parts: string[] = [];

  // Firecrawl content
  if (firecrawlResults.status === "fulfilled") {
    for (const { label, category, content } of firecrawlResults.value) {
      if (content) {
        parts.push(`\n=== ${label} [${category}] ===\n${content}`);
      }
    }
  }

  // X timeline posts
  if (xTimelineResults.status === "fulfilled" && xTimelineResults.value.length > 0) {
    parts.push("\n=== X/Twitter Posts ===");
    for (const post of xTimelineResults.value) {
      parts.push(`@${post.authorUsername}: ${post.text.slice(0, 150)} (${post.likes} likes)`);
    }
  }

  // X search results
  if (xSearchResults.status === "fulfilled" && xSearchResults.value.length > 0) {
    parts.push("\n=== X/Twitter Trending ===");
    for (const { category, posts } of xSearchResults.value) {
      for (const post of posts) {
        parts.push(`[${category}] @${post.authorUsername}: ${post.text.slice(0, 150)} (${post.likes} likes)`);
      }
    }
  }

  // Brave search results
  if (braveResults.status === "fulfilled") {
    for (const { category, results } of braveResults.value) {
      if (results) {
        parts.push(`\n=== Web Search: ${category} ===\n${results}`);
      }
    }
  }

  const rawContent = parts.join("\n");
  if (rawContent.length < 100) {
    console.log("[Briefing] No content fetched, skipping editorial call");
    return [];
  }

  // Phase 3: One LLM editorial call
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // Truncate to ~15k chars for LLM context
  const truncated = rawContent.slice(0, 15_000);

  try {
    const response = await callMinimax(
      buildEditorialPrompt(today),
      `Here is today's raw content from all sources:\n\n${truncated}\n\nProduce the briefing as a JSON array.`
    );

    const items = parseJsonArray(response);
    const briefing: BriefingItem[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const headline = String(obj.headline || "").trim();
      if (!headline || headline.length < 10) continue;

      briefing.push({
        headline,
        category: String(obj.category || "News"),
        summary: String(obj.summary || "").slice(0, 200),
        marketability: (obj.marketability === "high" || obj.marketability === "medium" || obj.marketability === "low")
          ? obj.marketability
          : "medium",
      });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Briefing] Generated ${briefing.length} items across ${new Set(briefing.map(b => b.category)).size} categories (${elapsed}s)`);

    return briefing;
  } catch (err) {
    console.error("[Briefing] Editorial LLM call failed:", err);
    return [];
  }
}

// ── Fetch Helpers ──

async function fetchAllFirecrawl(): Promise<{ label: string; category: string; content: string | null }[]> {
  // Scrape all URLs in parallel, truncate each to 800 chars
  const results = await Promise.allSettled(
    FIRECRAWL_SOURCES.map(async (src) => {
      const page = await scrapePage(src.url);
      return {
        label: src.label,
        category: src.category,
        content: page ? page.markdown.slice(0, 800) : null,
      };
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<{ label: string; category: string; content: string | null }> =>
      r.status === "fulfilled"
    )
    .map((r) => r.value);
}

async function fetchAllXTimelines(): Promise<{ authorUsername: string; text: string; likes: number }[]> {
  const usernames = X_TIMELINE_ACCOUNTS.map((a) => a.username);
  const posts = await fetchMultiUserPosts(usernames, 3);

  // Filter to last 6 hours only, take top 30 by engagement
  const cutoff = Date.now() - 6 * 60 * 60_000;
  return posts
    .filter((p) => !p.createdAt || new Date(p.createdAt).getTime() > cutoff)
    .sort((a, b) => (b.likes + b.retweets * 2) - (a.likes + a.retweets * 2))
    .slice(0, 30);
}

async function fetchAllXSearches(): Promise<{ category: string; posts: { authorUsername: string; text: string; likes: number }[] }[]> {
  const results = await Promise.allSettled(
    X_SEARCH_QUERIES.map(async (q) => {
      const posts = await searchXPosts(q.query, 10);
      return {
        category: q.category,
        posts: posts.slice(0, 5).map((p) => ({
          authorUsername: p.authorUsername,
          text: p.text,
          likes: p.likes,
        })),
      };
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<{ category: string; posts: { authorUsername: string; text: string; likes: number }[] }> =>
      r.status === "fulfilled"
    )
    .map((r) => r.value)
    .filter((r) => r.posts.length > 0);
}

async function fetchAllBraveSearches(): Promise<{ category: string; results: string | null }[]> {
  const results = await Promise.allSettled(
    BRAVE_QUERIES.map(async (q) => {
      const searchResults = await braveSearch(q.query, 5);
      return {
        category: q.category,
        results: searchResults.length > 0 ? formatSearchResults(searchResults) : null,
      };
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<{ category: string; results: string | null }> =>
      r.status === "fulfilled"
    )
    .map((r) => r.value);
}

// ── JSON Parsing ──

function parseJsonArray(text: string): unknown[] {
  try {
    const result = JSON.parse(text);
    if (Array.isArray(result)) return result;
  } catch { /* continue */ }

  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* continue */ }
  }
  return [];
}
