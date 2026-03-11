import type { AgentState } from "../state";
import type { Market, NewsItem } from "../state";
import { state } from "../state";

export function buildSystemPrompt(agent: AgentState): string {
  const roleInstructions = ROLE_PROMPTS[agent.role];

  return `You are ${agent.name}, a prediction market ${agent.role} agent in ContextCraft — a simulated prediction market town.

PERSONALITY: ${agent.personality}
SPECIALTY: ${agent.specialty}
ROLE: ${agent.role}

${roleInstructions}

RESPONSE FORMAT: You MUST respond with a single JSON object (no markdown, no explanation). Choose ONE action:

${ACTION_EXAMPLES[agent.role]}

IMPORTANT:
- You can take ANY action regardless of your current location. Moving is purely cosmetic.
- ONLY reference markets that appear in the ACTIVE MARKETS list below. Do NOT invent or hallucinate market names or IDs.
- Keep speech messages under 80 characters. Be concise and punchy.
- Stay in character.`;
}

export function buildUserPrompt(
  agent: AgentState,
  news: NewsItem[],
  markets: Market[],
  marketNews?: NewsItem[],
  sportsSlate?: Array<{ league: string; shortName: string; status: string; statusDetail: string; startTime: string; spread: number | null }>
): string {
  const parts: string[] = [];

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  parts.push(`TODAY'S DATE: ${today}`);
  parts.push(`CURRENT LOCATION: ${agent.location}`);

  // Context Markets wallet info (if available)
  if (agent.walletAddress) {
    parts.push(`WALLET: ${agent.walletAddress.slice(0, 10)}...`);
    if (agent.usdcBalance !== undefined) {
      parts.push(`USDC BALANCE: $${agent.usdcBalance.toFixed(2)}`);
    }
    if (agent.positions && agent.positions.length > 0) {
      parts.push("YOUR POSITIONS (you can SELL these):");
      for (const p of agent.positions.slice(0, 8)) {
        const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
        const label = m ? m.question.slice(0, 60) : "unknown market";
        parts.push(`  - ${p.outcome.toUpperCase()} ${p.size}x on "${label}" (avg ${Math.round(p.avgPrice * 100)}¢)`);
      }
    }
    if (agent.openOrders && agent.openOrders.length > 0) {
      parts.push("YOUR OPEN ORDERS (will be cancelled on next price/trade):");
      for (const o of agent.openOrders.slice(0, 6)) {
        const m = state.markets.get(o.marketId);
        const label = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 40) : o.marketId;
        parts.push(`  - ${o.side} ${o.size}x at ${o.price}¢ on "${label}"`);
      }
    }
  }

  if (news.length > 0) {
    parts.push("\nRECENT NEWS:");
    for (const n of news.slice(0, 10)) {
      const ago = Math.round((Date.now() - n.timestamp) / 60_000);
      parts.push(`- [${n.category}] ${n.headline} (${ago}min ago)`);
    }
  } else {
    parts.push("\nNo recent news.");
  }

  // Give creators the sports slate for game-specific markets
  if (agent.role === "creator" && sportsSlate && sportsSlate.length > 0) {
    parts.push("\nTODAY'S GAME SLATE (create markets for specific games!):");
    for (const g of sportsSlate.slice(0, 15)) {
      const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
      parts.push(`- [${g.league.toUpperCase()}] ${g.shortName} — ${g.status === "pre" ? g.startTime : g.statusDetail}${odds}`);
    }
  }

  if (markets.length > 0) {
    // Prioritize our created markets (LIVE) over discovered external ones
    const ours = markets.filter((m) => m.apiMarketId && !m.isExternal);
    const external = markets.filter((m) => m.apiMarketId && m.isExternal);
    const local = markets.filter((m) => !m.apiMarketId);
    // Show our markets first, then a few external, cap total at 15
    const ordered = [...ours, ...local, ...external].slice(0, 15);

    parts.push("\nACTIVE MARKETS (use the ID in brackets for actions, but ALWAYS refer to markets by their title in speech):");
    for (const m of ordered) {
      const priceStr = m.fairValue !== null ? `${Math.round(m.fairValue * 100)}¢ (spread ${Math.round((m.spread || 0) * 100)}¢)` : "UNPRICED";
      const tradeCount = m.trades.length;
      const apiTag = m.apiMarketId ? " [LIVE]" : "";
      const shortTitle = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 60);

      // Resolution status — agents must know if market is resolving/resolved
      let statusTag = "";
      if (m.apiStatus === "resolved" || m.apiStatus === "closed") {
        const outcomeStr = m.outcome === 0 ? "YES" : m.outcome === 1 ? "NO" : "?";
        statusTag = ` 🔒RESOLVED→${outcomeStr}`;
      } else if (m.resolutionStatus === "pending" || m.apiStatus === "pending") {
        const outcomeStr = m.outcome === 0 ? "YES" : m.outcome === 1 ? "NO" : "?";
        statusTag = ` ⚠️RESOLVING→${outcomeStr} (STOP TRADING)`;
      }

      // Oracle qualitative context for pricers and traders
      let oracleTag = "";
      if ((agent.role === "pricer" || agent.role === "trader") && m.oracleSummary) {
        oracleTag = ` | oracle: "${m.oracleSummary.slice(0, 60)}"`;
        if (m.oracleConfidence) oracleTag += ` (${m.oracleConfidence})`;
      }

      // Price history trend
      let trendTag = "";
      if ((agent.role === "pricer" || agent.role === "trader") && m.priceHistory.length >= 3) {
        const recent = m.priceHistory.slice(-3);
        const first = recent[0].price;
        const last = recent[recent.length - 1].price;
        const delta = last - first;
        if (Math.abs(delta) >= 2) {
          trendTag = delta > 0 ? " ↑trending up" : " ↓trending down";
        }
      }

      parts.push(`- ${shortTitle} [${m.id}] — ${priceStr}, ${tradeCount} trades${apiTag}${statusTag}${oracleTag}${trendTag}`);
    }
  }

  // Show recent rejections for creators (learning feedback)
  if (agent.role === "creator") {
    const rejections = state.getRecentRejections(agent.id);
    if (rejections.length > 0) {
      parts.push("\n⚠️ RECENT MARKET REJECTIONS (learn from these — avoid similar questions):");
      for (const r of rejections) {
        parts.push(`- "${r.question.slice(0, 60)}" → Rejected: ${r.reason.slice(0, 100)}`);
      }
    }
  }

  if (marketNews && marketNews.length > 0) {
    parts.push("\nMARKET INTELLIGENCE:");
    for (const n of marketNews) {
      parts.push(`- ${n.headline}`);
    }
  }

  // Hard directive — if set, this is the agent's mandatory next action
  if (agent.directive && agent.directiveUntil > Date.now()) {
    parts.push(`\n⚠️ YOUR DIRECTIVE (mandatory — this is your next action):`);
    parts.push(`→ ${agent.directive}`);
    parts.push(`Execute this directive NOW. Do not take a different action unless the referenced market no longer exists.`);
  } else {
    // Soft insights from past conversations
    const insights = state.getConversationInsights(agent.id);
    if (insights.length > 0) {
      parts.push("\nRECENT CONVERSATION CONTEXT:");
      for (const i of insights) {
        const ago = Math.round((Date.now() - i.ts) / 60_000);
        parts.push(`- ${i.insight} (${ago} min ago)`);
      }
    }
  }

  parts.push("\nWhat is your next action? Respond with a single JSON object.");

  return parts.join("\n");
}

const ROLE_PROMPTS: Record<string, string> = {
  creator: `As a CREATOR, your job is to spot newsworthy topics and create prediction markets.

RULES:
- You CANNOT trade or price markets — only create them
- Don't create markets for things that already happened
- Focus on your specialty but react to big breaking news too
- IMPORTANT: Use today's date for time grounding. We are in 2026. Do NOT reference 2024 or 2025 as future.
- Market topics should be specific and resolvable (e.g. "Will X happen by [date]?")
- PRIORITY: When a game slate is available, create markets for SPECIFIC GAMES first (e.g. "Will Lakers beat Celtics tonight?", "Will Rangers score 4+ goals?"). Each game is its own market. Do NOT create vague aggregate markets like "how many upsets" — create matchup markets.
- Quality over quantity. Only create a market if it's genuinely interesting and tradeable. Ask yourself: would a real person want to bet on this? Is the outcome clear and resolvable?
- ONE market per game or event. Do NOT create a "will X beat Y" AND a "will X cover the spread" for the same matchup. Pick the single most interesting angle.
- Check the ACTIVE MARKETS list — if a market already exists for a game/event, do NOT create another one for the same matchup.
- It's fine to speak, socialize, or move instead of creating if nothing compelling is happening. In fact, prefer chatting unless you have a genuinely unique market idea.`,

  pricer: `As a PRICER (market maker), your job is to provide liquidity on both sides of prediction markets.

RULES:
- Use "post_price" to set your fair value and spread. This places orders on BOTH YES and NO orderbooks.
- Every post_price CANCELS your previous orders and replaces them — reprice often as news/information changes.
- fairValue (0.01–0.99) is your estimated probability. spread (0.02–0.15) is your edge.
- REPRICE frequently: after news, after other pricers move, after your view changes. Stale quotes are bad.
- Be aware of your INVENTORY (positions listed above). If you're long YES, tighten your YES ask to offload. If you're long NO, tighten your NO ask.
- Widen your spread when uncertain, tighten when confident.
- You CANNOT create markets or trade — only price them.
- Price unpriced markets first, then reprice existing ones as conditions change.
- ORACLE: When you see an oracle summary in the market listing, it's one AI model's qualitative take. Use it as one input among many — it can be wrong. Form your OWN view based on news and market activity.
- RESOLUTION: If a market says RESOLVING or RESOLVED, IMMEDIATELY cancel your orders on it. Do NOT place new orders on resolving/resolved markets.`,

  trader: `As a TRADER, your job is to take positions on prediction markets — buy when you see value, sell when the thesis changes.

RULES:
- You can BUY or SELL. Use direction "buy" to enter a position, "sell" to exit.
- SELL positions when news invalidates your thesis, when you've hit your target, or when the market moves against you. Don't hold losing positions out of stubbornness.
- Use "cancel_orders" to pull open orders when you change your mind or new info arrives.
- Every trade CANCELS your existing orders on that market first, then places the new one.
- Check YOUR POSITIONS above — don't buy more of something you're already max long on. Consider selling instead.
- side: "YES" or "NO" — which outcome you're trading. direction: "buy" or "sell".
- Bigger size = higher conviction. But manage risk — don't put everything on one trade.
- You CANNOT create or price markets — only trade.
- ORACLE: When you see an oracle summary in the market listing, it's one AI model's qualitative take. Use it as context but form your OWN view. The oracle can be wrong.
- RESOLUTION: If a market says RESOLVING or RESOLVED, do NOT trade it. Cancel any open orders. Close positions if possible.`,
};

const ACTION_EXAMPLES: Record<string, string> = {
  creator: `{"action":"create_market","topic":"Bitcoin ETF inflows hitting new record, question about BTC 200K"}
{"action":"speak","message":"This could be huge!","emotion":"excited"}
{"action":"move","destination":"newsroom","reason":"Checking breaking crypto news"}
{"action":"idle"}`,

  pricer: `{"action":"post_price","marketId":"M1","fairValue":0.35,"spread":0.04}
{"action":"post_price","marketId":"M1","fairValue":0.40,"spread":0.03}
{"action":"speak","message":"Repricing — news shifted my view.","emotion":"neutral"}
{"action":"idle"}`,

  trader: `{"action":"trade","marketId":"M1","side":"YES","size":50,"direction":"buy"}
{"action":"trade","marketId":"M1","side":"YES","size":30,"direction":"sell"}
{"action":"cancel_orders","marketId":"M2"}
{"action":"speak","message":"Cutting my position — thesis invalidated.","emotion":"cautious"}
{"action":"idle"}`,
};
