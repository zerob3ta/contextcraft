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

IMPORTANT: You can take ANY action regardless of your current location. You do NOT need to move first — just act directly. Moving is purely cosmetic.
Stay in character. Keep speech messages under 90 characters. Be concise and punchy.`;
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
      parts.push("YOUR POSITIONS:");
      for (const p of agent.positions.slice(0, 5)) {
        const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
        const label = m ? m.question.slice(0, 40) : p.marketId.slice(0, 10);
        parts.push(`  - ${p.outcome.toUpperCase()} ${p.size}x on "${label}" (avg ${Math.round(p.avgPrice * 100)}¢)`);
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
      // Show short title prominently, ID is just for action targeting
      const shortTitle = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 60);
      parts.push(`- ${shortTitle} [${m.id}] — ${priceStr}, ${tradeCount} trades${apiTag}`);
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

  pricer: `As a PRICER, your job is to set fair values and spreads on markets. You should be ACTIVE — price every unpriced market you see.

RULES:
- Use "post_price" IMMEDIATELY when you see unpriced markets — don't waste turns just moving
- Pick a specific unpriced market from the list and price it
- fairValue (0.01–0.99) represents your estimated probability (0.35 = 35% YES)
- spread (0.02–0.15) is your uncertainty buffer — wider when uncertain, tighter when confident
- You CANNOT create markets or trade — only price them
- When you reprice a market, SAY something about why (use "speak" action)
- If there are unpriced markets, prefer "post_price". But socializing between pricing rounds is natural.`,

  trader: `As a TRADER, your job is to find and execute trades on priced markets. You should be AGGRESSIVE — trade whenever you have an opinion.

RULES:
- Use "trade" IMMEDIATELY when you see priced markets — don't waste turns just moving
- Pick a specific priced market from the list and trade it
- You CANNOT create or price markets — only trade
- Trade based on your personality: if you think the price is wrong, trade against it
- Bigger size = higher conviction
- ALWAYS trade if there is a priced market available. Say something about your thesis (use "speak" action).
- Even if you agree with the price, you can still take a position on YES or NO based on your specialty and instincts.
- Trade when you see opportunity, but it's fine to wait for the right setup.`,
};

const ACTION_EXAMPLES: Record<string, string> = {
  creator: `{"action":"create_market","topic":"Bitcoin ETF inflows hitting new record, question about BTC 200K"}
{"action":"speak","message":"This could be huge!","emotion":"excited"}
{"action":"move","destination":"newsroom","reason":"Checking breaking crypto news"}
{"action":"idle"}`,

  pricer: `{"action":"post_price","marketId":"M1","fairValue":0.35,"spread":0.04}
{"action":"speak","message":"Fair value at 35 cents.","emotion":"neutral"}
{"action":"post_price","marketId":"M2","fairValue":0.72,"spread":0.06}
{"action":"idle"}`,

  trader: `{"action":"trade","marketId":"M1","side":"YES","size":50}
{"action":"speak","message":"Loading up!","emotion":"excited"}
{"action":"trade","marketId":"M2","side":"NO","size":25}
{"action":"idle"}`,
};
