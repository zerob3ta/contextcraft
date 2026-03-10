/** ESPN API fetcher — public, no auth needed */

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

export interface EspnGame {
  id: string;
  name: string;        // "Lakers vs Celtics"
  shortName: string;   // "LAL vs BOS"
  status: "pre" | "in" | "post";
  statusDetail: string; // "7:30 PM ET" | "Q3 4:22" | "Final"
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  startTime: string;
  league: string;
}

interface EspnApiEvent {
  id: string;
  name: string;
  shortName: string;
  status: { type: { state: string; detail: string } };
  competitions: Array<{
    startDate: string;
    competitors: Array<{
      homeAway: string;
      team: { displayName: string };
      score: string;
    }>;
  }>;
}

const LEAGUES: Record<string, { sport: string; league: string }> = {
  nba: { sport: "basketball", league: "nba" },
  ncaab: { sport: "basketball", league: "mens-college-basketball" },
  nhl: { sport: "hockey", league: "nhl" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
};

export async function fetchScoreboard(leagueId: string): Promise<EspnGame[]> {
  const cfg = LEAGUES[leagueId];
  if (!cfg) return [];

  try {
    const url = `${ESPN_BASE}/${cfg.sport}/${cfg.league}/scoreboard`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];

    const data = await res.json();
    const events: EspnApiEvent[] = data.events || [];

    return events.map((e) => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      const away = comp?.competitors?.find((c) => c.homeAway === "away");

      return {
        id: e.id,
        name: e.name,
        shortName: e.shortName,
        status: e.status.type.state as "pre" | "in" | "post",
        statusDetail: e.status.type.detail,
        homeTeam: home?.team.displayName || "TBD",
        awayTeam: away?.team.displayName || "TBD",
        homeScore: home?.score ? parseInt(home.score) : null,
        awayScore: away?.score ? parseInt(away.score) : null,
        startTime: comp?.startDate || "",
        league: leagueId.toUpperCase(),
      };
    });
  } catch (err) {
    console.error(`[ESPN] Error fetching ${leagueId}:`, err);
    return [];
  }
}

export async function fetchEspnHeadlines(sport: string, league: string): Promise<string[]> {
  try {
    const url = `${ESPN_BASE}/${sport}/${league}/news`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];

    const data = await res.json();
    const articles: { headline: string }[] = data.articles || [];
    return articles.slice(0, 10).map((a) => a.headline);
  } catch (err) {
    console.error(`[ESPN] Error fetching headlines:`, err);
    return [];
  }
}
