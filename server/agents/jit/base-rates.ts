/**
 * Static base rate lookup tables derived from historical data.
 * Ported from pm-workspace JIT engine.
 */

/** Championship win probability by seed (historical 1984-2024) */
export const CHAMPIONSHIP_BY_SEED: Record<string, readonly number[]> = {
  nba: [30, 18, 15, 12, 8, 5, 2, 0.5],
  nfl: [22, 18, 12, 10, 8, 6, 4],
  mlb: [18, 15, 12, 10, 8, 7],
  ncaab: [25, 15, 10, 8, 6, 5, 4, 3, 2, 1.5, 1, 0.8, 0.5, 0.3, 0.1, 0.05],
  nhl: [20, 15, 12, 10, 8, 7, 5, 4],
};

/** Sports game outcome base rates */
export const GAME_BASE_RATES = {
  higherRankedWins: 68,
  betterRecordWins: 64,
  homeTeamAdvantage: 57,
};

export function getChampionshipProbability(sport: string, seed: number): number | null {
  const rates = CHAMPIONSHIP_BY_SEED[sport.toLowerCase()];
  if (!rates) return null;
  if (seed < 1 || seed > rates.length) return null;
  return rates[seed - 1];
}

/** Politics base rates */
export const INCUMBENT_ADVANTAGE = 70;

/** Snow probability by region and season (%) */
export const SNOW_PROBABILITY: Record<string, Record<string, number>> = {
  northern: { winter: 70, spring_fall: 25, summer: 1 },
  mid_atlantic: { winter: 35, spring_fall: 10, summer: 0 },
  southern: { winter: 5, spring_fall: 1, summer: 0 },
};

export function getSnowProbability(region: string, season: string): number | null {
  const regionData = SNOW_PROBABILITY[region];
  if (!regionData) return null;
  return regionData[season] ?? null;
}

export const SEASON_LENGTHS = {
  nba_regular: 170,
  nba_playoffs: 60,
  nfl_regular: 120,
  nfl_playoffs: 35,
  mlb_regular: 180,
  nhl_regular: 180,
  hurricane_season: 180,
  tornado_season: 90,
};

/** Weather phenomenon base rates by qualifier (%) */
export const WEATHER_BASE_RATES: Record<string, Record<string, number>> = {
  rain: { daily_us_avg: 30 },
  hurricane: {
    us_landfall_season: 65,
    major_cat3_season: 25,
    named_to_hurricane: 40,
    florida_season: 8,
    texas_season: 3,
  },
  tornado: { us_daily_peak: 5, us_monthly_peak: 40 },
};

export function getWeatherPhenomenonRate(phenomenon: string, qualifier: string): number | null {
  const rates = WEATHER_BASE_RATES[phenomenon];
  if (!rates) return null;
  return rates[qualifier] ?? null;
}
