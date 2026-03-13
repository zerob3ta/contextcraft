/**
 * Log-normal volatility model for price target probability estimation.
 * Ported from pm-workspace JIT engine for deterministic analyst pricing.
 */

/** Annual volatility constants for major crypto assets */
const CRYPTO_VOLATILITY: Record<string, number> = {
  btc: 0.6,
  bitcoin: 0.6,
  eth: 0.7,
  ethereum: 0.7,
  sol: 0.9,
  solana: 0.9,
};

const DEFAULT_CRYPTO_VOLATILITY = 0.7;

/** Annual volatility for major index ETFs */
const INDEX_VOLATILITY: Record<string, number> = {
  spy: 0.15,
  dia: 0.15,
  qqq: 0.2,
  iwm: 0.25,
};

const STOCK_VOL_HIGH = new Set([
  "tsla", "nvda", "amd", "coin", "pltr", "rivn", "mara", "riot", "mstr",
  "snow", "dkng", "lcid", "sofi", "upst", "afrm",
]);

const STOCK_VOL_MID = new Set([
  "meta", "amzn", "googl", "goog", "nflx", "crm", "shop", "sq", "pypl",
  "uber", "abnb", "dash",
]);

const STOCK_VOL_LOW = new Set([
  "aapl", "msft", "jnj", "pg", "ko", "pep", "jpm", "v", "ma", "unh",
  "hd", "wmt", "cost",
]);

export function getAnnualVolatility(symbol: string, assetType: "crypto" | "stock"): number {
  const s = symbol.toLowerCase();
  if (assetType === "crypto") {
    return CRYPTO_VOLATILITY[s] ?? DEFAULT_CRYPTO_VOLATILITY;
  }
  if (INDEX_VOLATILITY[s] !== undefined) return INDEX_VOLATILITY[s];
  if (STOCK_VOL_HIGH.has(s)) return 0.55;
  if (STOCK_VOL_MID.has(s)) return 0.4;
  if (STOCK_VOL_LOW.has(s)) return 0.25;
  return 0.35;
}

/** Standard normal CDF approximation (Abramowitz & Stegun) */
export function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

/** Calculate probability that price will reach a target using log-normal model */
export function calcPriceProbability(params: {
  currentPrice: number;
  targetPrice: number;
  daysRemaining: number;
  annualVolatility: number;
  direction: "above" | "below";
}): number {
  const { currentPrice, targetPrice, daysRemaining, annualVolatility, direction } = params;

  if (daysRemaining <= 0) {
    if (direction === "above") return currentPrice >= targetPrice ? 100 : 0;
    return currentPrice <= targetPrice ? 100 : 0;
  }

  if (direction === "above" && currentPrice >= targetPrice) return 100;
  if (direction === "below" && currentPrice <= targetPrice) return 100;

  const periodVolatility = (annualVolatility / Math.sqrt(365)) * Math.sqrt(daysRemaining);

  if (direction === "above") {
    const z = Math.log(targetPrice / currentPrice) / periodVolatility;
    return Math.round(Math.max(0, Math.min(100, (1 - normalCdf(z)) * 100)));
  }

  const z = Math.log(currentPrice / targetPrice) / periodVolatility;
  return Math.round(Math.max(0, Math.min(100, (1 - normalCdf(z)) * 100)));
}

/** Calculate probability that price will land within a range */
export function calcPriceRangeProbability(params: {
  currentPrice: number;
  lowerBound: number;
  upperBound: number;
  daysRemaining: number;
  annualVolatility: number;
}): number {
  const { currentPrice, lowerBound, upperBound, daysRemaining, annualVolatility } = params;

  if (daysRemaining <= 0) {
    return currentPrice >= lowerBound && currentPrice <= upperBound ? 100 : 0;
  }

  const periodVolatility = (annualVolatility / Math.sqrt(365)) * Math.sqrt(daysRemaining);
  const zLower = Math.log(lowerBound / currentPrice) / periodVolatility;
  const zUpper = Math.log(upperBound / currentPrice) / periodVolatility;
  return Math.round(Math.max(0, Math.min(100, (normalCdf(zUpper) - normalCdf(zLower)) * 100)));
}
