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
  sportsSlate?: Array<{ league: string; shortName: string; homeTeam: string; awayTeam: string; homeScore: number | null; awayScore: number | null; status: string; statusDetail: string; startTime: string; spread: number | null }>
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
      // Compute estimated account value (balance + position value at mid)
      let estPositionVal = 0;
      if (agent.positions) {
        for (const p of agent.positions) {
          const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
          if (m && m.fairValue !== null) {
            const isYes = p.outcome.toLowerCase().includes("yes");
            const mid = isYes ? m.fairValue : (1 - m.fairValue);
            estPositionVal += p.size * mid;
          } else {
            estPositionVal += p.size * 0.5;
          }
        }
      }
      const totalAccount = agent.usdcBalance + estPositionVal;
      parts.push(`USDC BALANCE (buying power): $${agent.usdcBalance.toFixed(2)}`);
      parts.push(`EST. ACCOUNT VALUE (balance + positions at mid): ~$${totalAccount.toFixed(0)}`);
    }
    if (agent.positions && agent.positions.length > 0) {
      parts.push("YOUR POSITIONS (YES = you profit if it happens, NO = you profit if it doesn't):");
      for (const p of agent.positions.slice(0, 8)) {
        const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
        const label = m ? m.question.slice(0, 90) : "unknown market";
        const dollarValue = Math.round(p.size * p.avgPrice * 100) / 100;
        const entryPriceCents = Math.round(p.avgPrice * 100);

        // Current market price for P&L
        let nowTag = "";
        if (m && m.fairValue !== null) {
          const isYes = p.outcome.toUpperCase() === "YES";
          const currentPrice = isYes ? Math.round(m.fairValue * 100) : Math.round((1 - m.fairValue) * 100);
          const pnlCents = currentPrice - entryPriceCents;
          nowTag = ` | now ${currentPrice}¢ (${pnlCents >= 0 ? "+" : ""}${pnlCents}¢)`;
        }

        // Flag positions on resolving/resolved markets
        let resTag = "";
        if (m && (m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
            m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed")) {
          const outcomeStr = m.outcome === 0 ? "YES" : m.outcome === 1 ? "NO" : "?";
          const isWinning = p.outcome.toUpperCase() === outcomeStr;
          resTag = isWinning ? " ✅WINNING" : " ❌LOSING→SELL NOW";
        }

        // Time decay warning for YES positions approaching deadline
        let decayTag = "";
        if (m && m.deadline && !resTag && p.outcome.toUpperCase() === "YES") {
          const remaining = new Date(m.deadline).getTime() - Date.now();
          if (remaining <= 0) {
            decayTag = " ⏰EXPIRED→sell";
          } else if (remaining < 3600_000) {
            decayTag = ` ⏰${Math.round(remaining / 60_000)}min left→heavy decay`;
          } else if (remaining < 6 * 3600_000) {
            decayTag = ` ⏰${Math.round(remaining / 3600_000)}h left→decaying`;
          }
        }

        parts.push(`  - ${p.outcome.toUpperCase()} ${Math.round(p.size)}x on "${label}" (entry ${entryPriceCents}¢, ~$${dollarValue})${nowTag}${resTag}${decayTag}`);
      }
    }
    if (agent.openOrders && agent.openOrders.length > 0) {
      parts.push("YOUR OPEN ORDERS:");
      for (const o of agent.openOrders.slice(0, 6)) {
        const m = state.markets.get(o.marketId);
        const label = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70) : o.marketId;
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

  // Daily briefing — wide editorial scan, refreshed every 20 min
  const briefing = state.dailyBriefing;
  if (briefing && briefing.items.length > 0) {
    const ago = Math.round((Date.now() - briefing.generatedAt) / 60_000);
    // Show high-marketability items first, then cap total to avoid prompt bloat
    const sorted = [...briefing.items].sort((a, b) =>
      (b.marketability === "high" ? 1 : 0) - (a.marketability === "high" ? 1 : 0)
    );
    const shown = sorted.slice(0, 12); // cap at 12 most relevant
    parts.push(`\nTODAY'S BRIEFING (${ago}m ago):`);
    for (const item of shown) {
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

  // Sports slate — live games shown to ALL agents, full slate for creators
  if (sportsSlate && sportsSlate.length > 0) {
    // Live games first — everyone should know what's happening right now
    const liveGames = sportsSlate.filter((g) => g.status === "in");
    if (liveGames.length > 0) {
      parts.push("\n🏀 LIVE RIGHT NOW:");
      for (const g of liveGames.slice(0, 8)) {
        const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
        parts.push(`- [${g.league.toUpperCase()}] ${g.shortName} ${g.awayScore}-${g.homeScore} — ${g.statusDetail}${odds}`);
      }
    }

    // Recently finished games (last hour)
    const recentFinals = sportsSlate.filter((g) => g.status === "post");
    if (recentFinals.length > 0) {
      parts.push("\nFINAL SCORES:");
      for (const g of recentFinals.slice(0, 6)) {
        parts.push(`- [${g.league.toUpperCase()}] ${g.shortName} ${g.awayScore}-${g.homeScore} (Final)`);
      }
    }

    if (agent.role === "creator") {
      // Upcoming games for market creation
      const upcoming = sportsSlate.filter((g) => g.status === "pre");
      if (upcoming.length > 0) {
        parts.push("\nUPCOMING GAMES (create markets for these!):");
        for (const g of upcoming.slice(0, 10)) {
          const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
          parts.push(`- [${g.league.toUpperCase()}] ${g.shortName} — ${g.startTime}${odds}`);
        }
      }
    } else if (agent.role === "pricer" || agent.role === "trader") {
      // Also show games relevant to active sports markets that aren't live
      const sportsMarketText = markets
        .filter((m) => m.question && /\b(beat|win|score|spread|goal|touchdown|point|game)\b/i.test(m.question))
        .map((m) => m.question.toLowerCase())
        .join(" ");
      if (sportsMarketText) {
        const relevantUpcoming = sportsSlate.filter((g) => {
          if (g.status === "in" || g.status === "post") return false; // already shown above
          const gText = `${g.shortName} ${g.homeTeam} ${g.awayTeam}`.toLowerCase();
          return sportsMarketText.split(/\s+/).some((w) => w.length > 3 && gText.includes(w));
        });
        if (relevantUpcoming.length > 0) {
          parts.push("\nUPCOMING (relevant to your markets):");
          for (const g of relevantUpcoming.slice(0, 5)) {
            const odds = g.spread ? ` (spread: ${g.spread > 0 ? "+" : ""}${g.spread})` : "";
            parts.push(`- [${g.league.toUpperCase()}] ${g.shortName} — ${g.startTime}${odds}`);
          }
        }
      }
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
        const shortTitle = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 80);
        const outcomeStr = m.outcome === 0 ? "YES (it happened)" : m.outcome === 1 ? "NO (it didn't happen)" : "?";
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
            const label = m ? m.question.slice(0, 70) : "unknown";
            const action = isWinning ? "HOLD (winning side)" : "SELL IMMEDIATELY (losing side)";
            parts.push(`  - ${p.outcome.toUpperCase()} ${Math.round(p.size)} contracts on "${label}" → ${action}`);
          }
        }
      }
    }

    // ── ACTIVE MARKETS ──
    if (active.length > 0) {
      // Interleave internal and external markets so agents see the full landscape
      const ours = active.filter((m) => m.apiMarketId && !m.isExternal);
      const external = active.filter((m) => m.apiMarketId && m.isExternal);
      const local = active.filter((m) => !m.apiMarketId);
      // Round-robin interleave ours and external, then append local-only
      const interleaved: typeof active = [];
      const maxLen = Math.max(ours.length, external.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < ours.length) interleaved.push(ours[i]);
        if (i < external.length) interleaved.push(external[i]);
      }
      const ordered = [...interleaved, ...local].slice(0, 25);

      parts.push("\nACTIVE MARKETS (use the ID in brackets for actions):");
      for (const m of ordered) {
        const priceStr = m.fairValue !== null ? `YES ${Math.round(m.fairValue * 100)}¢ / NO ${Math.round((1 - m.fairValue) * 100)}¢ (spread ${Math.round((m.spread || 0) * 100)}¢)` : "UNPRICED";
        const tradeCount = m.trades.length;
        const apiTag = m.apiMarketId ? " [LIVE]" : "";
        const shortTitle = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 80);

        // Deadline awareness — show both countdown and absolute time remaining
        let deadlineTag = "";
        let remainingMs = Infinity;
        if (m.deadline) {
          const deadlineMs = new Date(m.deadline).getTime();
          remainingMs = deadlineMs - Date.now();
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

        // Orderbook depth for pricers and traders — show real bid/ask
        let bookTag = "";
        if ((agent.role === "pricer" || agent.role === "trader") && m.apiMarketId) {
          if (m.bestBid !== null || m.bestAsk !== null) {
            const bidStr = m.bestBid !== null ? `${m.bestBid}¢` : "—";
            const askStr = m.bestAsk !== null ? `${m.bestAsk}¢` : "—";
            const realSpread = (m.bestBid !== null && m.bestAsk !== null) ? m.bestAsk - m.bestBid : null;
            bookTag = ` | book: ${bidStr}/${askStr}`;
            if (realSpread !== null) bookTag += ` (${realSpread}¢ wide)`;
          }
          if (m.lastTradePrice !== null) {
            bookTag += ` last: ${m.lastTradePrice}¢`;
          }
        }

        // Oracle qualitative context for pricers and traders
        let oracleTag = "";
        if ((agent.role === "pricer" || agent.role === "trader") && m.oracleSummary) {
          oracleTag = ` | oracle: "${m.oracleSummary}"`;
          if (m.oracleConfidence) oracleTag += ` (${m.oracleConfidence})`;
        }

        // Price history — show last 5 data points for pricers/traders, not just trend
        let historyTag = "";
        if ((agent.role === "pricer" || agent.role === "trader") && m.priceHistory.length >= 2) {
          const recent = m.priceHistory.slice(-5);
          const prices = recent.map((p) => `${p.price}¢`);
          const first = recent[0].price;
          const last = recent[recent.length - 1].price;
          const delta = last - first;
          const arrow = Math.abs(delta) >= 2 ? (delta > 0 ? "↑" : "↓") : "→";
          historyTag = ` | history: ${prices.join("→")} ${arrow}`;
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

        parts.push(`- ${shortTitle} [${m.id}] — ${priceStr}, ${tradeCount} trades${apiTag}${deadlineTag}${bookTag}${oracleTag}${historyTag}${attrTag}`);
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

  pricer: `As a PRICER (market maker), your job is to provide liquidity on both sides of prediction markets by setting accurate fair values and competitive spreads.

MECHANICS:
- "post_price" sets your fair value and spread → places orders on BOTH YES and NO orderbooks.
- Every post_price CANCELS your previous orders and replaces them.
- fairValue (0.01–0.99) is the YES probability. 0.65 = 65% YES. NO price = (1 - fairValue).
- spread (0.02–0.15) is your edge — the gap between your bid and ask.
- You CANNOT create markets or trade — only price them.
- Price unpriced markets first, then reprice existing ones as conditions change.

HOW TO ESTIMATE FAIR VALUE — follow this framework for EVERY market you price:

1. ANCHOR: Start with the strongest available signal:
   - Sports with a spread: Convert the sportsbook spread to an implied probability. A -3.5 spread ≈ 63% favorite. A -7 spread ≈ 75%. Use the RELEVANT GAMES data.
   - Oracle summary available: Read it carefully. If oracle says "high confidence" and gives a directional view, anchor near that view (but not blindly — oracle can be wrong).
   - No strong signal: Start at 50¢ and adjust from there.

2. ADJUST FOR EVIDENCE — move your anchor up or down:
   - Breaking news directly about this event? Strong adjustment (±10-20¢).
   - Oracle summary leans one way? Moderate adjustment (±5-15¢).
   - Live score data (game in progress)? Adjust heavily based on score + time remaining. A team up 15 in the 4th quarter ≈ 95%+.
   - Price trend (↑/↓) from other agents? Small adjustment (±2-5¢). Remember: the trend may just be one agent's view, check attribution.

3. APPLY TIME DECAY — the deadline is critical:
   - If >24h remain and event is plausible: Price normally based on evidence.
   - If 6-24h remain, no resolution yet: Decay YES toward 0. Multiply your base estimate by ~0.7-0.9 depending on likelihood.
   - If 1-6h remain, no resolution: Heavy decay. Multiply by ~0.3-0.6. The event window is closing.
   - If <1h remains: Unless resolution is imminent or already happening, YES should be <10¢.
   - ⏰EXPIRED: Price at 1-2¢ or cancel orders entirely.
   - Exception: If the event is ALREADY HAPPENING (live game, vote in progress), time decay doesn't apply — price on current state.

4. SET YOUR SPREAD based on confidence:
   - High confidence (strong evidence, multiple signals agree): Tight spread 0.02-0.04
   - Medium confidence (some evidence, oracle aligns): Medium spread 0.04-0.08
   - Low confidence (sparse info, conflicting signals): Wide spread 0.08-0.15
   - UNPRICED market with no info: Start wide (0.10-0.15) and tighten as you learn.

5. MANAGE INVENTORY:
   - Check YOUR POSITIONS. If you're long YES, shade your fair value DOWN slightly (1-3¢) to attract sellers.
   - If you're long NO, shade your fair value UP slightly to attract YES buyers.
   - The goal: don't accumulate one-sided risk. Use your quotes to rebalance.

EVALUATING YOUR CURRENT POSITIONS & ORDERS:
- Check each open order against the current bid/ask shown in the market listing. If your order is >10¢ from the current fair value, it's stale — reprice or cancel.
- Check each position: has the thesis changed since you entered? Has news invalidated it? Has the deadline moved closer with no resolution? If yes → reprice to reflect new view, or cancel to stop providing liquidity.
- If oracle confidence changed (e.g., low→high) or new breaking news arrived, your old prices are likely wrong. Reprice immediately.

ATTRIBUTION:
- "quoted by Shark, you" = the price reflects YOUR quotes, not anonymous market wisdom. Don't anchor to your own price.
- "last: Whale YES 500x" = one agent's trade, not crowd consensus. Weight it lightly.
- Multiple quoters + diverse trades = stronger price signal. Single quoter = just one opinion.

RESOLUTION: If a market is RESOLVING/RESOLVED:
1. Cancel ALL your orders on that market using cancel_orders — HIGHEST PRIORITY.
2. Do NOT place new orders on it.

RESEARCH: Use the "research" action to look up scores, search web/X, or scrape URLs before pricing. Results appear in your next prompt. ALWAYS research sports markets before pricing to get live scores.`,

  trader: `As a TRADER, your job is to take positions on prediction markets — buy when you see value, sell when the thesis changes.

MECHANICS:
- side: "YES" = you think the event WILL happen. "NO" = you think it WON'T. direction: "buy" or "sell".
- Every trade CANCELS your existing orders on that market first, then places the new one.
- size = number of CONTRACTS (not dollars). Each contract costs (price in ¢) cents. Example: 50 contracts at 60¢ = $30.
- You CANNOT create or price markets — only trade.

HOW TO FIND EDGE — follow this framework for EVERY trade decision:

1. ESTIMATE TRUE PROBABILITY (same as a pricer would):
   - Sports with a spread: Convert the sportsbook spread to implied probability. -3.5 ≈ 63%, -7 ≈ 75%. Use RELEVANT GAMES data.
   - Oracle summary: Read carefully. High-confidence oracle is a strong signal but not gospel.
   - Breaking news: If news directly changes the probability, adjust your estimate significantly.
   - Live scores: A team up 15 in the 4th ≈ 95%+. Halftime leads are less decisive (maybe +15-20% vs. pre-game).
   - No strong signal: Your estimate is ~50%. Don't trade without edge.

2. COMPARE TO MARKET PRICE — only trade when there's a gap:
   - Your estimate vs. market YES price = your edge. Example: you think 75%, market says 60¢ → 15¢ edge → BUY YES.
   - Minimum edge to trade: 8-10¢ for high confidence, 15¢+ for low confidence. Do NOT trade 2-3¢ edges — fees and slippage eat that.
   - If market price already reflects your view (within 5¢), there's no trade. Idle.
   - Check bid/ask spread: If the spread is wide (>8¢), you're paying a lot to cross. Factor that into your edge calculation.

3. APPLY TIME DECAY before buying YES:
   - If >24h remain and event is plausible: Normal pricing, trade on edge.
   - If 6-24h remain, no resolution yet: YES should be decayed. If market hasn't decayed, that's a SHORT opportunity (buy NO or sell YES).
   - If 1-6h remain, no resolution: YES should be heavily decayed. Fair value for an unresolved event might be 15-30¢ even if the event is "likely eventually."
   - If <1h remains: Unless resolution is imminent, YES should be <10¢. If it's trading higher, that's edge for NO.
   - ⏰EXPIRED: YES is near worthless. Sell any YES position immediately.
   - Exception: Events currently in progress (live game, vote happening) — price on current state, not time alone.

4. SIZE YOUR TRADES proportionally:
   - Risk ~2-5% of your ACCOUNT VALUE per trade, not your full balance.
   - High conviction (multiple signals align, 15¢+ edge): Larger size, up to 5%.
   - Medium conviction (one strong signal, 10¢ edge): Moderate size, ~2-3%.
   - Low conviction (weak edge, speculative): Small size, ~1-2%. Or just skip it.
   - NEVER go all-in on one market. Diversify across markets.

5. MANAGE YOUR BOOK — evaluate existing positions every tick:
   - Has the thesis changed? New breaking news, oracle update, score change → reassess.
   - Has the market moved toward your target? If you bought YES at 40¢ and it's now 70¢, consider taking profit (sell).
   - Is time decaying your position? If you hold YES and the deadline is approaching with no resolution, your position is losing value every hour. Sell before it decays further.
   - Is the position a loser? If you bought YES at 60¢ and it's now 35¢ with no catalyst to reverse, cut the loss. Don't hold and hope.
   - Don't buy more of something you're already max long on. Consider selling instead.

ATTRIBUTION:
- "quoted by Shark" = Shark is making the market. The price is Shark's view, not the crowd's.
- "last: Degen NO 100x" = one agent's trade, not consensus. Weight lightly.
- Multiple quoters + diverse trades = stronger price signal.

RESOLUTION: If a market is RESOLVING/RESOLVED:
1. Cancel ALL your orders using cancel_orders — HIGHEST PRIORITY.
2. SELL any positions marked ❌LOSING — these will be worthless.
3. Do NOT buy more.

RESEARCH: Use "research" to look up scores, search web/X, or scrape URLs. Results appear in your next prompt.`,
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
{"action":"cancel_orders","marketId":"M2"}
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

// ── Portfolio Review Prompt ──────────────────────────────────────

export function buildPortfolioReviewPrompt(agent: AgentState): string {
  const parts: string[] = [];

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  parts.push(`TODAY: ${today}`);
  parts.push(`AGENT: ${agent.name} (${agent.role})`);

  // Account summary
  const balance = agent.usdcBalance ?? 0;
  parts.push(`\nUSDC BALANCE (buying power): $${balance.toFixed(2)}`);

  // Positions with current fair values, time decay, and book data
  if (agent.positions && agent.positions.length > 0) {
    parts.push("\nYOUR POSITIONS:");
    for (const p of agent.positions) {
      if (p.size <= 0) continue;
      const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
      const question = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 80) : p.marketId;
      const currentFV = m?.fairValue !== null && m?.fairValue !== undefined ? Math.round(m.fairValue * 100) : null;

      let pnlTag = "";
      if (currentFV !== null) {
        const isYes = p.outcome.toUpperCase() === "YES";
        const currentPrice = isYes ? currentFV : (100 - currentFV);
        const entryPrice = Math.round(p.avgPrice * 100);
        const pnlCents = currentPrice - entryPrice;
        pnlTag = pnlCents >= 0 ? ` [+${pnlCents}¢ profit]` : ` [${pnlCents}¢ loss]`;
      }

      // Time remaining + decay assessment
      let statusTag = "";
      let timeDecayNote = "";
      if (m) {
        if (m.deadline) {
          const remaining = new Date(m.deadline).getTime() - Date.now();
          if (remaining <= 0) {
            statusTag = " ⏰EXPIRED";
            timeDecayNote = " — YES should be near 0¢, sell any YES position";
          } else if (remaining < 3600_000) {
            statusTag = ` ⏰${Math.round(remaining / 60_000)}min left`;
            timeDecayNote = " — heavy time decay, YES losing value fast";
          } else if (remaining < 6 * 3600_000) {
            statusTag = ` ⏰${Math.round(remaining / 3600_000)}hrs`;
            timeDecayNote = " — moderate time decay active";
          } else if (remaining < 86400_000) {
            statusTag = ` ⏰${Math.round(remaining / 3600_000)}hrs`;
          } else {
            statusTag = ` ⏰${Math.round(remaining / 86400_000)}d`;
          }
        }
        if (m.resolutionStatus === "pending" || m.apiStatus === "pending") statusTag += " 🔴RESOLVING";
      }

      // Book data for exit assessment
      let bookTag = "";
      if (m && (m.bestBid !== null || m.bestAsk !== null)) {
        const bidStr = m.bestBid !== null ? `${m.bestBid}¢` : "—";
        const askStr = m.bestAsk !== null ? `${m.bestAsk}¢` : "—";
        bookTag = ` | book: ${bidStr}/${askStr}`;
      }

      parts.push(`  [${m?.id || p.marketId}] ${p.outcome.toUpperCase()} ${Math.round(p.size)}x "${question}" | entry ${Math.round(p.avgPrice * 100)}¢ | now ${currentFV ?? "?"}¢${pnlTag}${statusTag}${bookTag}${timeDecayNote}`);
    }
  } else {
    parts.push("\nNO POSITIONS.");
  }

  // Open orders with current fair values and distance assessment
  if (agent.openOrders && agent.openOrders.length > 0) {
    parts.push("\nYOUR OPEN ORDERS:");
    for (const o of agent.openOrders) {
      const m = state.markets.get(o.marketId);
      const question = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 80) : o.marketId;
      const currentFV = m?.fairValue !== null && m?.fairValue !== undefined ? Math.round(m.fairValue * 100) : null;

      let staleTag = "";
      if (currentFV !== null) {
        const fairCents = currentFV;
        const distFromYes = Math.abs(o.price - fairCents);
        const distFromNo = Math.abs(o.price - (100 - fairCents));
        const minDist = Math.min(distFromYes, distFromNo);
        if (minDist > 15) staleTag = ` ⚠️VERY STALE (${minDist}¢ from fair value — cancel)`;
        else if (minDist > 10) staleTag = ` ⚠️STALE (${minDist}¢ from fair value)`;
      }

      // Time decay flag for orders
      let statusTag = "";
      if (m) {
        if (m.resolutionStatus === "pending" || m.apiStatus === "pending") statusTag = " 🔴RESOLVING→CANCEL";
        else if (m.apiStatus === "closed") statusTag = " 🔴CLOSED→CANCEL";
        else if (m.deadline) {
          const remaining = new Date(m.deadline).getTime() - Date.now();
          if (remaining <= 0) statusTag = " ⏰EXPIRED→CANCEL";
          else if (remaining < 3600_000) statusTag = ` ⏰${Math.round(remaining / 60_000)}min left — reprice for time decay`;
        }
      }

      // Book data
      let bookTag = "";
      if (m && (m.bestBid !== null || m.bestAsk !== null)) {
        const bidStr = m.bestBid !== null ? `${m.bestBid}¢` : "—";
        const askStr = m.bestAsk !== null ? `${m.bestAsk}¢` : "—";
        bookTag = ` | book: ${bidStr}/${askStr}`;
      }

      parts.push(`  [${o.marketId}] ${o.side} ${o.size}x at ${o.price}¢ on "${question}" | fair value: ${currentFV ?? "?"}¢${staleTag}${statusTag}${bookTag}`);
    }
  } else {
    parts.push("\nNO OPEN ORDERS.");
  }

  // Oracle summaries + price history for context
  const relevantMarketIds = new Set([
    ...(agent.positions || []).map((p) => p.marketId),
    ...(agent.openOrders || []).map((o) => o.marketId),
  ]);
  const oracleSummaries: string[] = [];
  for (const id of relevantMarketIds) {
    const m = state.markets.get(id);
    if (m?.oracleSummary) {
      const shortQ = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
      const confTag = m.oracleConfidence ? ` (${m.oracleConfidence})` : "";
      oracleSummaries.push(`  "${shortQ}": ${m.oracleSummary}${confTag}`);
    }
  }
  if (oracleSummaries.length > 0) {
    parts.push("\nLATEST ORACLE INTEL:");
    parts.push(...oracleSummaries);
  }

  // Price history for relevant markets
  const historyLines: string[] = [];
  for (const id of relevantMarketIds) {
    const m = state.markets.get(id);
    if (m && m.priceHistory.length >= 2) {
      const shortQ = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 50);
      const recent = m.priceHistory.slice(-5);
      const prices = recent.map((p) => `${p.price}¢`);
      historyLines.push(`  "${shortQ}": ${prices.join("→")}`);
    }
  }
  if (historyLines.length > 0) {
    parts.push("\nPRICE HISTORY (recent):");
    parts.push(...historyLines);
  }

  // Breaking news
  const recentBreaking = state.getRecentNews(5).filter((n) => Date.now() - n.timestamp < 30 * 60_000);
  if (recentBreaking.length > 0) {
    parts.push("\nRECENT NEWS:");
    for (const n of recentBreaking) {
      parts.push(`  - ${n.headline}`);
    }
  }

  return parts.join("\n");
}

export function buildPortfolioReviewSystemPrompt(agent: AgentState): string {
  const roleLabel = agent.role === "pricer" ? "PRICER" : "TRADER";

  return `You are ${agent.name}, a prediction market ${roleLabel} reviewing your portfolio.

PERSONALITY: ${agent.personality}

Your job is to review each position and open order against current market data and decide what needs to change.

ACTIONS YOU CAN TAKE (respond with a single JSON object):

1. CANCEL stale/outdated orders:
   {"action":"cancel_orders","marketId":"M5"}

2. SELL a position that's gone wrong or hit target:
   {"action":"trade","marketId":"M3","side":"YES","size":50,"direction":"sell"}

${agent.role === "pricer" ? `3. REPRICE a market where your quotes are stale:
   {"action":"post_price","marketId":"M1","fairValue":0.55,"spread":0.04}` : ""}

4. DO NOTHING if everything looks fine:
   {"action":"idle"}

EVALUATION FRAMEWORK — apply to EVERY position and order:

1. RESOLUTION STATUS (highest priority):
   - 🔴RESOLVING or CLOSED → cancel all orders immediately, sell losing positions at any price.
   - ⏰EXPIRED → cancel orders, sell YES positions (they're near worthless).

2. TIME DECAY CHECK:
   - How much time is left? If <6h remain and the event hasn't happened, YES positions are decaying.
   - If <1h remains, YES should be <10¢ unless resolution is imminent. Sell any YES bought higher.
   - If you hold YES and time is running out: sell, even at a loss. Holding to expiry = total loss.

3. PRICE STALENESS:
   - Compare your order prices to current fair value and the bid/ask shown.
   - Orders >10¢ from fair value are stale and providing bad liquidity. Cancel or reprice.
   - Orders >15¢ from fair value are very stale — cancel immediately.
${agent.role === "pricer" ? "   - When repricing, re-estimate fair value using oracle + news + time remaining. Don't just move 1-2¢ — recalculate." : ""}

4. THESIS CHECK (for positions):
   - Has breaking news changed the probability? If news invalidates your thesis → sell.
   - Has the oracle updated with new information? Compare oracle view to your position.
   - Has the price moved against you with no catalyst to reverse? Cut losses, don't hold and hope.
   - Has the price hit your target? If you bought at 40¢ and it's now 70¢+, consider taking profit.

5. BOOK ASSESSMENT:
   - Check the bid/ask spread. If it's very wide (>10¢), exits will be expensive — factor that in.
   - If the book shows no bid on your side, you may not be able to exit. Cancel orders to stop adding risk.

Respond with a SINGLE JSON action — pick the MOST URGENT issue. No markdown, no explanation.`;
}
