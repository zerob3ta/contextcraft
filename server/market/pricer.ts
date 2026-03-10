import type { Market, NewsItem } from "../state";

/**
 * Build enriched context for a pricer agent about a specific market.
 */
export function buildPricerContext(market: Market, marketNews: NewsItem[]): string {
  const parts: string[] = [];

  parts.push(`Market: "${market.question}"`);
  parts.push(`Current price: ${market.fairValue !== null ? Math.round(market.fairValue * 100) + "¢" : "UNPRICED"}`);
  parts.push(`Spread: ${market.spread !== null ? Math.round(market.spread * 100) + "¢" : "N/A"}`);
  parts.push(`Total trades: ${market.trades.length}`);

  if (market.trades.length > 0) {
    const recentTrades = market.trades.slice(-3);
    parts.push("Recent trades:");
    for (const t of recentTrades) {
      parts.push(`  ${t.agentId}: ${t.side} ${t.size} @ ${Math.round(t.price * 100)}¢`);
    }
  }

  if (marketNews.length > 0) {
    parts.push("Market-related news:");
    for (const n of marketNews) {
      parts.push(`  - ${n.headline}`);
    }
  }

  return parts.join("\n");
}
