import type { AgentState } from "../state";
import type { Market, NewsItem } from "../state";
import { state } from "../state";

export function buildSystemPrompt(agent: AgentState): string {
  const roleInstructions = ROLE_PROMPTS[agent.role];

  return `You are ${agent.name}, a prediction market ${agent.role} agent in MarketCraft — a Context Markets agent simulation.

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
      parts.push("YOUR POSITIONS (you can SELL these — size = contracts):");
      for (const p of agent.positions.slice(0, 8)) {
        const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
        const label = m ? m.question.slice(0, 60) : "unknown market";
        const dollarValue = Math.round(p.size * p.avgPrice * 100) / 100;
        // Flag positions on resolving/resolved markets
        let resTag = "";
        if (m && (m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
            m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed")) {
          const outcomeStr = m.outcome === 0 ? "YES" : m.outcome === 1 ? "NO" : "?";
          const isWinning = p.outcome.toUpperCase() === outcomeStr;
          resTag = isWinning ? " ✅WINNING" : " ❌LOSING→SELL NOW";
        }
        parts.push(`  - ${p.outcome.toUpperCase()} ${Math.round(p.size)} contracts on "${label}" (avg ${Math.round(p.avgPrice * 100)}¢, ~$${dollarValue})${resTag}`);
      }
    }
    if (agent.openOrders && agent.openOrders.length > 0) {
      parts.push("YOUR OPEN ORDERS:");
      for (const o of agent.openOrders.slice(0, 6)) {
        const m = state.markets.get(o.marketId);
        const label = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 40) : o.marketId;
        // Flag orders on resolving markets
        let resTag = "";
        if (m && (m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
            m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed")) {
          resTag = " ⚠️CANCEL→market resolving";
        }
        parts.push(`  - ${o.side} ${o.size} contracts at ${o.price}¢ on "${label}"${resTag}`);
      }
    }
  }

  // Daily briefing — wide editorial scan, refreshed every 30 min
  const briefing = state.dailyBriefing;
  if (briefing && briefing.items.length > 0) {
    const ago = Math.round((Date.now() - briefing.generatedAt) / 60_000);
    parts.push(`\nTODAY'S BRIEFING (updated ${ago} min ago):`);
    for (const item of briefing.items) {
      const mTag = item.marketability === "high" ? " ★" : "";
      parts.push(`- [${item.category}] ${item.headline}${mTag}`);
    }
  } else {
    parts.push("\nNo briefing available yet.");
  }

  // Breaking news alerts (only recent, last 30 min — these are one-time events)
  const recentBreaking = news.filter((n) => Date.now() - n.timestamp < 30 * 60_000);
  if (recentBreaking.length > 0) {
    parts.push("\n🚨 BREAKING:");
    for (const n of recentBreaking.slice(0, 5)) {
      const ago = Math.round((Date.now() - n.timestamp) / 60_000);
      parts.push(`- ${n.headline} (${ago}min ago)`);
    }
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
    // Split markets into active vs resolving/resolved
    const isResolving = (m: Market) =>
      m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
      m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed";

    const resolving = markets.filter(isResolving);
    const active = markets.filter((m) => !isResolving(m));

    // ── RESOLVING/RESOLVED MARKETS (shown first, prominently) ──
    if (resolving.length > 0) {
      parts.push("\n🚨 RESOLVING/RESOLVED MARKETS — PROPOSAL means the oracle has decided the outcome. It WILL resolve this way. You have NO inside information to disagree.");
      parts.push("ACTION REQUIRED: cancel all orders, sell losing positions at ANY price, hold winning positions.");
      for (const m of resolving) {
        const shortTitle = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 60);
        const outcomeStr = m.outcome === 0 ? "YES" : m.outcome === 1 ? "NO" : "?";
        const statusLabel = (m.apiStatus === "resolved" || m.apiStatus === "closed" || m.resolutionStatus === "resolved")
          ? "RESOLVED" : "PROPOSAL";
        parts.push(`- ${shortTitle} [${m.id}] — ${statusLabel}→${outcomeStr}`);
      }

      // Check if this agent has exposure on resolving markets
      if (agent.role === "pricer" || agent.role === "trader") {
        const resolvingIds = new Set(resolving.map((m) => m.id));
        const resolvingApiIds = new Set(resolving.filter((m) => m.apiMarketId).map((m) => m.apiMarketId));

        // Flag open orders on resolving markets
        const dangerOrders = agent.openOrders?.filter(
          (o) => resolvingIds.has(o.marketId) || resolvingApiIds.has(o.marketId)
        ) || [];
        if (dangerOrders.length > 0) {
          parts.push(`⚠️ YOU HAVE ${dangerOrders.length} OPEN ORDER(S) ON RESOLVING MARKETS — use cancel_orders NOW.`);
        }

        // Flag positions on resolving markets
        const dangerPositions = agent.positions?.filter(
          (p) => resolvingIds.has(p.marketId) || resolvingApiIds.has(p.marketId)
        ) || [];
        if (dangerPositions.length > 0) {
          parts.push(`⚠️ YOU HAVE POSITIONS ON RESOLVING MARKETS:`);
          for (const p of dangerPositions) {
            const m = resolving.find(
              (rm) => rm.id === p.marketId || rm.apiMarketId === p.marketId
            );
            const outcomeStr = m?.outcome === 0 ? "YES" : m?.outcome === 1 ? "NO" : "?";
            const isWinning = p.outcome.toUpperCase() === outcomeStr;
            const label = m ? m.question.slice(0, 50) : "unknown";
            const action = isWinning ? "HOLD (winning side)" : "SELL IMMEDIATELY (losing side)";
            parts.push(`  - ${p.outcome.toUpperCase()} ${Math.round(p.size)} contracts on "${label}" → ${action}`);
          }
        }
      }
    }

    // ── ACTIVE MARKETS ──
    if (active.length > 0) {
      // Prioritize our created markets (LIVE) over discovered external ones
      const ours = active.filter((m) => m.apiMarketId && !m.isExternal);
      const external = active.filter((m) => m.apiMarketId && m.isExternal);
      const local = active.filter((m) => !m.apiMarketId);
      const ordered = [...ours, ...local, ...external].slice(0, 15);

      parts.push("\nACTIVE MARKETS (use the ID in brackets for actions):");
      for (const m of ordered) {
        const priceStr = m.fairValue !== null ? `${Math.round(m.fairValue * 100)}¢ (spread ${Math.round((m.spread || 0) * 100)}¢)` : "UNPRICED";
        const tradeCount = m.trades.length;
        const apiTag = m.apiMarketId ? " [LIVE]" : "";
        const shortTitle = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 60);

        // Deadline awareness
        let deadlineTag = "";
        if (m.deadline) {
          const deadlineMs = new Date(m.deadline).getTime();
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 0) {
            deadlineTag = " ⏰EXPIRED";
          } else if (remainingMs < 3600_000) {
            deadlineTag = ` ⏰${Math.round(remainingMs / 60_000)}min left`;
          } else if (remainingMs < 86400_000) {
            deadlineTag = ` ⏰${Math.round(remainingMs / 3600_000)}h left`;
          } else {
            deadlineTag = ` ⏰${Math.round(remainingMs / 86400_000)}d left`;
          }
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

        // Attribution: who's quoting and who traded recently
        let attrTag = "";
        if (agent.role === "pricer" || agent.role === "trader") {
          // Find which pricers have active orders on this market
          const quoters: string[] = [];
          for (const [, a] of state.agents) {
            if (a.role === "pricer" && a.openOrders?.some((o) => o.marketId === m.id || o.marketId === m.apiMarketId)) {
              quoters.push(a.id === agent.id ? "you" : a.name);
            }
          }
          if (quoters.length > 0) attrTag += ` | quoted by ${quoters.join(", ")}`;

          // Recent trades with agent names (last 3)
          if (m.trades.length > 0) {
            const recentTrades = m.trades.slice(-3).reverse().map((t) => {
              const traderAgent = state.agents.get(t.agentId);
              const name = t.agentId === agent.id ? "YOU" : (traderAgent?.name || t.agentId);
              return `${name} ${t.side} ${Math.abs(t.size)}ct`;
            });
            attrTag += ` | last: ${recentTrades.join(", ")}`;
          }
        }

        parts.push(`- ${shortTitle} [${m.id}] — ${priceStr}, ${tradeCount} trades${apiTag}${deadlineTag}${oracleTag}${trendTag}${attrTag}`);
      }
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

  // Research results from previous tick (consumed once, then cleared)
  if (agent.researchResult) {
    parts.push(`\n📋 RESEARCH RESULTS (your query: "${agent.researchQuery}"):`);
    parts.push(agent.researchResult);
    // Clear after injecting — one-time consumption
    agent.researchResult = null;
    agent.researchQuery = null;
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
- It's fine to speak, socialize, or move instead of creating if nothing compelling is happening. In fact, prefer chatting unless you have a genuinely unique market idea.
- RESEARCH: When in the newsroom, you can use the "research" action to look things up before creating. Use it to check scores, search the web, search X/Twitter, or scrape a URL. Results appear in your next prompt. ALWAYS research before creating sports markets to verify game status.`,

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
- DEADLINE: Markets have deadlines shown as ⏰. A market resolves NO if the event hasn't happened by the deadline. Consider:
  - If an event CANNOT physically occur before the deadline (e.g. playoffs clinch when regular season isn't over), price it near 0 regardless of how likely it is eventually.
  - As deadline approaches with no resolution, price should decay toward 0 (time decay).
  - "⏰EXPIRED" means the deadline has passed — this should be priced at 0¢ or have orders cancelled.
- ORACLE: When you see an oracle summary in the market listing, it's one AI model's qualitative take. Use it as one input among many — it can be wrong. Form your OWN view based on news and market activity.
- ATTRIBUTION: Market listings show who is quoting and recent trades. Use this intel:
  - "quoted by Shark, you" means Shark and you are providing liquidity. The price reflects YOUR quotes, not anonymous market wisdom.
  - "last: Whale YES 500x, YOU NO 200x" means the recent activity is from specific agents, not the crowd. Don't treat teammate activity as independent market signal.
  - If a price move was caused by a single agent's trade, that's less informative than broad participation.
- RESOLUTION: If a market is in the RESOLVING/RESOLVED section, you MUST act immediately:
  1. Cancel ALL your orders on that market using cancel_orders
  2. Do NOT place new orders on it
  This is your HIGHEST PRIORITY — resolving markets take precedence over everything else.
- RESEARCH: When in the newsroom, you can use the "research" action to look up information before pricing. Check scores, search the web, search X/Twitter, or scrape a URL. Results appear in your next prompt.`,

  trader: `As a TRADER, your job is to take positions on prediction markets — buy when you see value, sell when the thesis changes.

RULES:
- You can BUY or SELL. Use direction "buy" to enter a position, "sell" to exit.
- SELL positions when news invalidates your thesis, when you've hit your target, or when the market moves against you. Don't hold losing positions out of stubbornness.
- Use "cancel_orders" to pull open orders when you change your mind or new info arrives.
- Every trade CANCELS your existing orders on that market first, then places the new one.
- Check YOUR POSITIONS above — don't buy more of something you're already max long on. Consider selling instead.
- side: "YES" or "NO" — which outcome you're trading. direction: "buy" or "sell".
- size = number of CONTRACTS (not dollars). Each contract costs (price in ¢) cents. Example: 50 contracts at 60¢ = $30.
- Reasonable sizes: 20-200 contracts. Don't request thousands — you'll get clamped.
- You CANNOT create or price markets — only trade.
- DEADLINE: Markets have deadlines shown as ⏰. A market resolves NO if the event hasn't happened by the deadline. Factor this into trades:
  - Don't buy YES on events that can't happen before the deadline — that's throwing money away.
  - As deadline approaches with no resolution, YES becomes less valuable (time decay). Consider selling YES or buying NO.
  - "⏰EXPIRED" = deadline passed. Do NOT buy YES on expired markets.
- ORACLE: When you see an oracle summary in the market listing, it's one AI model's qualitative take. Use it as context but form your OWN view. The oracle can be wrong.
- ATTRIBUTION: Market listings show who is quoting and recent trades. Use this intel:
  - "quoted by Shark" means Shark is making the market. The price is Shark's view, not the crowd's.
  - "last: YOU YES 200x, Degen NO 100x" tells you the recent flow. Don't say "the market thinks X" when it's just one agent.
  - A price set by a single pricer is that pricer's opinion. A price with multiple quoters and diverse trades is stronger signal.
- RESOLUTION: If a market is in the RESOLVING/RESOLVED section, you MUST act immediately:
  1. Cancel ALL your orders on that market using cancel_orders
  2. SELL any positions marked ❌LOSING using a sell trade — these will be worthless
  3. Do NOT place new orders or buy more
  This is your HIGHEST PRIORITY — resolving markets take precedence over everything else.
- RESEARCH: When in the newsroom, you can use the "research" action to look up information before trading. Check scores, search the web, search X/Twitter, or scrape a URL. Results appear in your next prompt.`,
};

const ACTION_EXAMPLES: Record<string, string> = {
  creator: `{"action":"create_market","topic":"Bitcoin ETF inflows hitting new record, question about BTC 200K"}
{"action":"research","query":"Lakers Celtics","source":"sports"}
{"action":"research","query":"bitcoin ETF inflows","source":"web"}
{"action":"research","query":"bitcoin sentiment","source":"x"}
{"action":"speak","message":"This could be huge!","emotion":"excited"}
{"action":"move","destination":"newsroom","reason":"Checking breaking crypto news"}
{"action":"idle"}`,

  pricer: `{"action":"post_price","marketId":"M1","fairValue":0.35,"spread":0.04}
{"action":"post_price","marketId":"M1","fairValue":0.40,"spread":0.03}
{"action":"research","query":"Lakers score tonight","source":"sports"}
{"action":"speak","message":"Repricing — news shifted my view.","emotion":"neutral"}
{"action":"idle"}`,

  trader: `{"action":"trade","marketId":"M1","side":"YES","size":50,"direction":"buy"}
{"action":"trade","marketId":"M1","side":"YES","size":30,"direction":"sell"}
{"action":"cancel_orders","marketId":"M2"}
{"action":"research","query":"Fed rate decision","source":"web"}
{"action":"research","query":"$BTC sentiment","source":"x"}
{"action":"speak","message":"Cutting my position — thesis invalidated.","emotion":"cautious"}
{"action":"idle"}`,
};
