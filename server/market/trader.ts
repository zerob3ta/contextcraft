import type { Market } from "../state";

/**
 * Build trade context for a trader agent about a specific market.
 */
export function buildTradeContext(market: Market): string {
  const parts: string[] = [];

  parts.push(`Market: "${market.question}"`);
  parts.push(`Fair value: ${market.fairValue !== null ? Math.round(market.fairValue * 100) + "¢" : "N/A"}`);
  parts.push(`Spread: ${market.spread !== null ? Math.round(market.spread * 100) + "¢" : "N/A"}`);

  const volume = market.trades.reduce((sum, t) => sum + t.size, 0);
  parts.push(`Volume: ${volume} contracts`);

  if (market.trades.length > 0) {
    const yesCount = market.trades.filter((t) => t.side === "YES").reduce((s, t) => s + t.size, 0);
    const noCount = market.trades.filter((t) => t.side === "NO").reduce((s, t) => s + t.size, 0);
    parts.push(`YES volume: ${yesCount}, NO volume: ${noCount}`);

    const lastTrade = market.trades[market.trades.length - 1];
    parts.push(`Last trade: ${lastTrade.agentId} ${lastTrade.side} ${lastTrade.size}`);
  }

  return parts.join("\n");
}
