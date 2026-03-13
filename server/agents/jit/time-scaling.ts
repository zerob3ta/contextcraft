/**
 * Time horizon scaling for probability estimates.
 * Ported from pm-workspace JIT engine.
 */

/**
 * Scale an annual probability to a specific number of days.
 * Rare events (<20%): linear scaling.
 * Common events (>=20%): exponential complement scaling.
 */
export function scaleByTimeHorizon(annualProbability: number, days: number): number {
  if (days <= 0) return 0;
  if (days >= 365) return annualProbability;

  if (annualProbability < 0.2) {
    return annualProbability * (days / 365);
  }

  const dailyRate = 1 - Math.pow(1 - annualProbability, 1 / 365);
  return 1 - Math.pow(1 - dailyRate, days);
}
