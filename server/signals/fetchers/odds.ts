/** The Odds API fetcher — Vegas lines for sports */

const ODDS_BASE = "https://api.the-odds-api.com/v4/sports";

export interface GameOdds {
  homeTeam: string;
  awayTeam: string;
  spread: number | null;     // home team spread
  overUnder: number | null;
  homeML: number | null;     // moneyline
  awayML: number | null;
}

const SPORT_KEYS: Record<string, string> = {
  nba: "basketball_nba",
  ncaab: "basketball_ncaab",
  nhl: "icehockey_nhl",
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
};

export async function fetchOdds(leagueId: string): Promise<GameOdds[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];

  const sportKey = SPORT_KEYS[leagueId];
  if (!sportKey) return [];

  try {
    const url = `${ODDS_BASE}/${sportKey}/odds?apiKey=${apiKey}&regions=us&markets=spreads,totals,h2h&oddsFormat=american`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];

    const data: Array<{
      home_team: string;
      away_team: string;
      bookmakers: Array<{
        markets: Array<{
          key: string;
          outcomes: Array<{ name: string; price: number; point?: number }>;
        }>;
      }>;
    }> = await res.json();

    return data.map((game) => {
      const bookie = game.bookmakers?.[0];
      const spreads = bookie?.markets?.find((m) => m.key === "spreads");
      const totals = bookie?.markets?.find((m) => m.key === "totals");
      const h2h = bookie?.markets?.find((m) => m.key === "h2h");

      const homeSpread = spreads?.outcomes?.find((o) => o.name === game.home_team);
      const overTotal = totals?.outcomes?.find((o) => o.name === "Over");
      const homeH2h = h2h?.outcomes?.find((o) => o.name === game.home_team);
      const awayH2h = h2h?.outcomes?.find((o) => o.name === game.away_team);

      return {
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        spread: homeSpread?.point ?? null,
        overUnder: overTotal?.point ?? null,
        homeML: homeH2h?.price ?? null,
        awayML: awayH2h?.price ?? null,
      };
    });
  } catch (err) {
    console.error(`[Odds] Error fetching ${leagueId}:`, err);
    return [];
  }
}
