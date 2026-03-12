/**
 * Research action handler — fetches on-demand data for agents in the newsroom.
 *
 * Sources:
 *   sports — ESPN scores + slate for a team/league
 *   web    — Brave search
 *   x      — X/Twitter search
 *   url    — Firecrawl page scrape
 */

import type { ResearchSource } from "./actions";
import { fetchScoreboard } from "../signals/fetchers/espn";
import { braveSearch, formatSearchResults } from "../signals/fetchers/brave-search";
import { searchXPosts } from "../signals/fetchers/x-api";
import { scrapePage } from "../signals/fetchers/firecrawl";
import { state } from "../state";

export async function executeResearch(query: string, source: ResearchSource): Promise<string | null> {
  try {
    switch (source) {
      case "sports":
        return await researchSports(query);
      case "web":
        return await researchWeb(query);
      case "x":
        return await researchX(query);
      case "url":
        return await researchUrl(query);
      default:
        return null;
    }
  } catch (err) {
    console.error(`[Research] Error (${source}): ${query}`, err);
    return null;
  }
}

async function researchSports(query: string): Promise<string | null> {
  const q = query.toLowerCase();
  const parts: string[] = [];

  // Check live scores first
  if (state.liveScores.length > 0) {
    const relevant = state.liveScores.filter((g) => {
      const gText = `${g.shortName} ${g.homeTeam} ${g.awayTeam} ${g.league}`.toLowerCase();
      return q.split(/\s+/).some((w) => w.length > 2 && gText.includes(w));
    });
    if (relevant.length > 0) {
      parts.push("LIVE SCORES:");
      for (const g of relevant) {
        parts.push(`  [${g.league.toUpperCase()}] ${g.shortName}: ${g.awayScore}-${g.homeScore} (${g.statusDetail})`);
      }
    }
  }

  // Check slate
  if (state.sportsSlate.length > 0) {
    const relevant = state.sportsSlate.filter((g) => {
      const gText = `${g.shortName} ${g.homeTeam} ${g.awayTeam} ${g.league}`.toLowerCase();
      return q.split(/\s+/).some((w) => w.length > 2 && gText.includes(w));
    });
    if (relevant.length > 0) {
      parts.push("TODAY'S GAMES:");
      for (const g of relevant.slice(0, 10)) {
        const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
        const ou = g.overUnder ? ` (O/U: ${g.overUnder})` : "";
        parts.push(`  [${g.league.toUpperCase()}] ${g.shortName} — ${g.status === "pre" ? g.startTime : g.statusDetail}${odds}${ou}`);
      }
    } else {
      // No match — show full slate summary
      parts.push(`TODAY'S FULL SLATE (${state.sportsSlate.length} games):`);
      for (const g of state.sportsSlate.slice(0, 15)) {
        const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
        parts.push(`  [${g.league.toUpperCase()}] ${g.shortName} — ${g.status === "pre" ? g.startTime : g.statusDetail}${odds}`);
      }
    }
  }

  if (parts.length === 0) {
    // Fallback: fetch fresh scoreboard
    const leagues = ["nba", "ncaab", "nhl"];
    for (const league of leagues) {
      const games = await fetchScoreboard(league);
      const relevant = games.filter((g) => {
        const gText = `${g.shortName} ${g.homeTeam} ${g.awayTeam}`.toLowerCase();
        return q.split(/\s+/).some((w) => w.length > 2 && gText.includes(w));
      });
      if (relevant.length > 0) {
        parts.push(`${league.toUpperCase()} SCORES:`);
        for (const g of relevant) {
          parts.push(`  ${g.shortName}: ${g.awayScore}-${g.homeScore} (${g.statusDetail})`);
        }
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : "No sports data found for that query.";
}

async function researchWeb(query: string): Promise<string | null> {
  const results = await braveSearch(query, 5);
  const formatted = formatSearchResults(results);
  return formatted || "No web results found.";
}

async function researchX(query: string): Promise<string | null> {
  const posts = await searchXPosts(query, 15);
  if (posts.length === 0) return "No X/Twitter results found.";

  const lines: string[] = ["X/TWITTER SEARCH RESULTS:"];
  for (const p of posts.slice(0, 10)) {
    const engagement = p.likes + p.retweets;
    const engTag = engagement > 100 ? ` [${p.likes}❤ ${p.retweets}🔁]` : "";
    lines.push(`  @${p.authorUsername}: ${p.text.slice(0, 200)}${engTag}`);
  }
  return lines.join("\n");
}

async function researchUrl(query: string): Promise<string | null> {
  // Query should be a URL
  const url = query.startsWith("http") ? query : `https://${query}`;
  const page = await scrapePage(url);
  if (!page) return "Could not scrape that URL.";

  // Truncate to keep context manageable
  const content = page.markdown.slice(0, 5000);
  return `PAGE: ${page.title}\n${content}`;
}
