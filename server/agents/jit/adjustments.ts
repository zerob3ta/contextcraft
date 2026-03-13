/**
 * Context-aware adjustments applied after base rate computation.
 * Ported from pm-workspace JIT engine.
 */

interface Adjustment {
  name: string;
  delta: number;
}

export function clampProbability(p: number): number {
  return Math.max(1, Math.min(99, p));
}

/** Crypto/stock adjustments based on price data */
export function getPriceAdjustments(priceChangePercent24h: number | null, daysRemaining: number): Adjustment[] {
  const adjustments: Adjustment[] = [];

  if (priceChangePercent24h != null) {
    if (priceChangePercent24h > 5) {
      adjustments.push({ name: "positive_24h_momentum", delta: 3 });
    } else if (priceChangePercent24h < -5) {
      adjustments.push({ name: "negative_24h_momentum", delta: -3 });
    }
  }

  if (daysRemaining < 30) {
    adjustments.push({ name: "short_timeframe_penalty", delta: -5 });
  } else if (daysRemaining > 365) {
    adjustments.push({ name: "long_timeframe_boost", delta: 5 });
  }

  return adjustments;
}

/** Sports context adjustments */
export function getSportsAdjustments(params: {
  isHome?: boolean;
  isDefendingChamp?: boolean;
  winPct?: number;
}): Adjustment[] {
  const adjustments: Adjustment[] = [];

  if (params.isHome) {
    adjustments.push({ name: "home_advantage", delta: 3 });
  }
  if (params.isDefendingChamp) {
    adjustments.push({ name: "defending_champion", delta: 3 });
  }
  if (params.winPct != null) {
    if (params.winPct > 0.65) {
      adjustments.push({ name: "hot_team", delta: 2 });
    } else if (params.winPct < 0.4) {
      adjustments.push({ name: "struggling_team", delta: -2 });
    }
  }

  return adjustments;
}

/** Apply adjustments to a base rate and clamp */
export function applyAdjustments(baseRate: number, adjustments: Adjustment[]): number {
  const totalDelta = adjustments.reduce((sum, a) => sum + a.delta, 0);
  return clampProbability(Math.round(baseRate + totalDelta));
}
