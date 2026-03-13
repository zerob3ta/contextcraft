/**
 * JIT odds computation for ContextCraft analyst role.
 * Reads live data from server state (no external API calls).
 * Ported + adapted from pm-workspace JIT engine.
 */

import { state } from "../../state";
import { classifyQuestion, classifyWithLLM, type ClassifiedQuestion } from "./classify";
import { calcPriceProbability, getAnnualVolatility } from "./volatility";
import { applyAdjustments, clampProbability, getPriceAdjustments, getSportsAdjustments } from "./adjustments";
import { getChampionshipProbability, GAME_BASE_RATES, INCUMBENT_ADVANTAGE, SEASON_LENGTHS, getSnowProbability, getWeatherPhenomenonRate } from "./base-rates";
import { scaleByTimeHorizon } from "./time-scaling";

export interface ComputeResult {
  probability: number;
  confidence: "low" | "medium" | "high";
  method: string;
  category: string;
}

/**
 * Compute odds for a market question using deterministic models.
 * Always returns a result — "other" category gets a neutral 50% estimate.
 */
export async function computeOdds(
  question: string,
  deadline: string | null,
): Promise<ComputeResult> {
  // Two-tier classification: regex first, LLM fallback
  let classified: ClassifiedQuestion | null = classifyQuestion(question);
  if (!classified) {
    classified = await classifyWithLLM(question);
  }

  const daysRemaining = deadline
    ? Math.max(0, (new Date(deadline).getTime() - Date.now()) / 86_400_000)
    : 30;

  switch (classified.category) {
    case "crypto_price":
      return computeCryptoPrice(classified, daysRemaining);
    case "stock_price":
      return computeStockPrice(classified, daysRemaining);
    case "sports_game":
      return computeSportsGame(classified);
    case "sports_futures":
      return computeSportsFutures(classified, daysRemaining, question);
    case "politics":
      return computePolitics(classified);
    case "weather":
      return computeWeather(classified, daysRemaining);
    case "economic":
      return computeEconomic();
    default:
      return {
        probability: 50,
        confidence: "low",
        method: `Unclassified market — neutral 50%. Question doesn't match known models.`,
        category: classified.category || "other",
      };
  }
}

function computeCryptoPrice(classified: ClassifiedQuestion, daysRemaining: number): ComputeResult {
  const asset = classified.asset || "btc";
  const targetPrice = classified.targetPrice || 0;
  const direction = classified.direction || "above";
  const annualVol = getAnnualVolatility(asset, "crypto");

  // Read current price from state (already populated by signal loops)
  const cryptoData = state.cryptoPrices.find((c) =>
    c.symbol.toLowerCase() === asset.toLowerCase() ||
    c.name.toLowerCase() === asset.toLowerCase() ||
    c.id.toLowerCase() === asset.toLowerCase()
  );

  if (!cryptoData) {
    return {
      probability: 50,
      confidence: "low",
      method: `No price data for ${asset}. Defaulting to 50%.`,
      category: "crypto_price",
    };
  }

  const baseRate = calcPriceProbability({
    currentPrice: cryptoData.price,
    targetPrice,
    daysRemaining,
    annualVolatility: annualVol,
    direction,
  });

  const adjustments = getPriceAdjustments(cryptoData.change24h, daysRemaining);
  const finalRate = applyAdjustments(baseRate, adjustments);

  return {
    probability: finalRate,
    confidence: "medium",
    method: `Log-normal vol model: ${asset.toUpperCase()} $${cryptoData.price.toLocaleString()} → $${targetPrice.toLocaleString()} ${direction}, ${(annualVol * 100).toFixed(0)}% vol, ${Math.round(daysRemaining)}d`,
    category: "crypto_price",
  };
}

function computeStockPrice(classified: ClassifiedQuestion, daysRemaining: number): ComputeResult {
  const symbol = classified.symbol || classified.asset || "SPY";
  const targetPrice = classified.targetPrice || 0;
  const direction = classified.direction || "above";

  // No stock price data in ContextCraft state — use neutral estimate
  return {
    probability: 50,
    confidence: "low",
    method: `Stock ${symbol.toUpperCase()} target $${targetPrice} ${direction} — no live price data. Neutral 50%.`,
    category: "stock_price",
  };
}

function computeSportsGame(classified: ClassifiedQuestion): ComputeResult {
  const teamA = classified.teamA || "";
  const teamB = classified.teamB || "";

  // Try to find the game in sportsSlate
  const slate = state.sportsSlate;
  const matchedGame = slate.find((g) => {
    const gText = `${g.shortName} ${g.homeTeam} ${g.awayTeam}`.toLowerCase();
    return (
      (teamA && gText.includes(teamA.toLowerCase())) ||
      (teamB && gText.includes(teamB.toLowerCase()))
    );
  });

  if (matchedGame && matchedGame.spread !== null) {
    // Convert spread to implied probability: -3.5 ≈ 63%, -7 ≈ 75%
    const absSpread = Math.abs(matchedGame.spread);
    const impliedProb = Math.min(90, 50 + absSpread * 3.7);
    // If teamA is the favorite (negative spread for home), give them higher prob
    const teamAIsHome = matchedGame.homeTeam.toLowerCase().includes(teamA.toLowerCase());
    const teamAIsFavorite = teamAIsHome ? matchedGame.spread < 0 : matchedGame.spread > 0;
    const prob = teamAIsFavorite ? impliedProb : 100 - impliedProb;

    const adjustments = getSportsAdjustments({ isHome: teamAIsHome });
    const finalRate = applyAdjustments(Math.round(prob), adjustments);

    return {
      probability: finalRate,
      confidence: "medium",
      method: `Spread-implied: ${matchedGame.shortName}, spread ${matchedGame.spread > 0 ? "+" : ""}${matchedGame.spread}`,
      category: "sports_game",
    };
  }

  // Fallback: home team advantage
  return {
    probability: GAME_BASE_RATES.homeTeamAdvantage,
    confidence: "low",
    method: `Fallback home-team baseline (${GAME_BASE_RATES.homeTeamAdvantage}%) for ${teamA} vs ${teamB}`,
    category: "sports_game",
  };
}

function computeSportsFutures(classified: ClassifiedQuestion, daysRemaining: number, question: string): ComputeResult {
  const sport = classified.sport?.toLowerCase() || inferSportFromQuestion(question);
  const seed = classified.seed;

  if (seed && sport) {
    const historicalRate = getChampionshipProbability(sport, seed);
    if (historicalRate != null) {
      const seasonLength = getSeasonLengthDays(sport);
      const scaledRate = seasonLength
        ? historicalRate * Math.min(1, daysRemaining / seasonLength)
        : historicalRate;

      return {
        probability: clampProbability(Math.round(scaledRate)),
        confidence: "medium",
        method: `Historical ${sport.toUpperCase()} championship rate for #${seed} seed: ${historicalRate}%, ${Math.round(daysRemaining)}d remaining`,
        category: "sports_futures",
      };
    }
  }

  return {
    probability: 10,
    confidence: "low",
    method: `Generic championship base rate (10%)${classified.team ? ` for ${classified.team}` : ""}`,
    category: "sports_futures",
  };
}

function computePolitics(classified: ClassifiedQuestion): ComputeResult {
  if (classified.isIncumbent) {
    return {
      probability: INCUMBENT_ADVANTAGE,
      confidence: "medium",
      method: `Incumbent advantage base rate: ${INCUMBENT_ADVANTAGE}%`,
      category: "politics",
    };
  }

  return {
    probability: 100 - INCUMBENT_ADVANTAGE,
    confidence: "low",
    method: `Non-incumbent base rate: ${100 - INCUMBENT_ADVANTAGE}%`,
    category: "politics",
  };
}

function computeWeather(classified: ClassifiedQuestion, daysRemaining: number): ComputeResult {
  const phenomenon = classified.phenomenon || "other";

  if (phenomenon === "snow" && classified.region && classified.season) {
    const annualRate = getSnowProbability(classified.region, classified.season);
    if (annualRate != null) {
      const scaledRate = scaleByTimeHorizon(annualRate / 100, Math.max(1, daysRemaining)) * 100;
      return {
        probability: clampProbability(Math.round(scaledRate)),
        confidence: "medium",
        method: `Snow ${classified.region} in ${classified.season}: ${annualRate}% seasonal → ${Math.round(scaledRate)}% in ${Math.round(daysRemaining)}d`,
        category: "weather",
      };
    }
  }

  if (phenomenon === "hurricane") {
    const seasonalRate = getWeatherPhenomenonRate("hurricane", "us_landfall_season") ?? 65;
    const scaledRate = scaleByTimeHorizon(seasonalRate / 100, Math.min(Math.max(1, daysRemaining), SEASON_LENGTHS.hurricane_season)) * 100;
    return {
      probability: clampProbability(Math.round(scaledRate)),
      confidence: "medium",
      method: `Hurricane US landfall: ${seasonalRate}% per season → ${Math.round(scaledRate)}% in ${Math.round(daysRemaining)}d`,
      category: "weather",
    };
  }

  if (phenomenon === "tornado") {
    const monthlyRate = getWeatherPhenomenonRate("tornado", "us_monthly_peak") ?? 40;
    const scaledRate = scaleByTimeHorizon(monthlyRate / 100, Math.min(Math.max(1, daysRemaining), SEASON_LENGTHS.tornado_season)) * 100;
    return {
      probability: clampProbability(Math.round(scaledRate)),
      confidence: "low",
      method: `Tornado peak rate: ${monthlyRate}% → ${Math.round(scaledRate)}% in ${Math.round(daysRemaining)}d`,
      category: "weather",
    };
  }

  if (phenomenon === "rain") {
    const dailyRate = getWeatherPhenomenonRate("rain", "daily_us_avg") ?? 30;
    const scaledRate = scaleByTimeHorizon(dailyRate / 100, Math.max(1, daysRemaining)) * 100;
    return {
      probability: clampProbability(Math.round(scaledRate)),
      confidence: "low",
      method: `Rain avg: ${dailyRate}% daily → ${Math.round(scaledRate)}% in ${Math.round(daysRemaining)}d`,
      category: "weather",
    };
  }

  return {
    probability: 50,
    confidence: "low",
    method: "No specific weather model. Defaulting to 50%.",
    category: "weather",
  };
}

function computeEconomic(): ComputeResult {
  return {
    probability: 50,
    confidence: "low",
    method: "Economic indicator — neutral 50% (no live macro data).",
    category: "economic",
  };
}

// ── Helpers ──

function inferSportFromQuestion(question: string): string | undefined {
  const q = question.toLowerCase();
  if (q.includes("super bowl")) return "nfl";
  if (q.includes("stanley cup")) return "nhl";
  if (q.includes("world series")) return "mlb";
  if (q.includes("nba finals")) return "nba";
  if (q.includes("march madness")) return "ncaab";
  return undefined;
}

function getSeasonLengthDays(sport: string): number | null {
  switch (sport.toLowerCase()) {
    case "nba": return SEASON_LENGTHS.nba_regular;
    case "nfl": return SEASON_LENGTHS.nfl_regular;
    case "mlb": return SEASON_LENGTHS.mlb_regular;
    case "nhl": return SEASON_LENGTHS.nhl_regular;
    default: return null;
  }
}
