import type { AgentState } from "../state";
import type { Market, NewsItem } from "../state";
import { state } from "../state";
import { isContextEnabled } from "../context-api/client";
import { getQuotedMarkets } from "./market-maker";

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
      // Filter out positions on resolved markets — they're done
      const livePositions = agent.positions.filter((p) => {
        const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
        if (!m) return true; // unknown market, show it
        return !(m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
          m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed");
      });
      if (livePositions.length > 0) {
        parts.push("YOUR POSITIONS (YES = you profit if it happens, NO = you profit if it doesn't):");
        for (const p of livePositions.slice(0, 8)) {
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

          // Time decay warning for YES positions approaching deadline
          let decayTag = "";
          if (m && m.deadline && p.outcome.toUpperCase() === "YES") {
            const remaining = new Date(m.deadline).getTime() - Date.now();
            if (remaining <= 0) {
              decayTag = " ⏰EXPIRED→sell";
            } else if (remaining < 3600_000) {
              decayTag = ` ⏰${Math.round(remaining / 60_000)}min left→heavy decay`;
            } else if (remaining < 6 * 3600_000) {
              decayTag = ` ⏰${Math.round(remaining / 3600_000)}h left→decaying`;
            }
          }

          parts.push(`  - ${p.outcome.toUpperCase()} ${Math.round(p.size)}x on "${label}" (entry ${entryPriceCents}¢, ~$${dollarValue})${nowTag}${decayTag}`);
        }
      }
    }
    if (agent.openOrders && agent.openOrders.length > 0) {
      // Filter out orders on resolved markets
      const liveOrders = agent.openOrders.filter((o) => {
        const m = state.markets.get(o.marketId);
        if (!m) return true;
        return !(m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
          m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed");
      });
      if (liveOrders.length > 0) {
        parts.push("YOUR OPEN ORDERS:");
        for (const o of liveOrders.slice(0, 6)) {
          const m = state.markets.get(o.marketId);
          const label = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70) : o.marketId;
          parts.push(`  - ${o.side} ${o.size} contracts at ${o.price}¢ on "${label}"`);
        }
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

    // Recently finished games (last hour) — for context only, NOT for market creation
    const recentFinals = sportsSlate.filter((g) => g.status === "post");
    if (recentFinals.length > 0) {
      parts.push("\nFINAL SCORES (already finished — DO NOT create markets for these):");
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
    // Filter out resolved/resolving markets entirely — they're done, no action possible
    const isResolving = (m: Market) =>
      m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
      m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed";

    const onChain = isContextEnabled();
    const active = markets.filter((m) => {
      if (isResolving(m)) return false;
      // When on-chain, skip markets with no API backing — they're phantom/failed
      if (onChain && !m.apiMarketId) return false;
      return true;
    });

    // ── ACTIVE MARKETS ──
    if (active.length > 0) {
      let ordered: typeof active;
      const TRADE_COOLDOWN_MS = 3 * 60_000;
      if (agent.role === "trader") {
        // Exclude recently-traded markets and shuffle to prevent fixation
        const available = active.filter((m) => state.getMarketCooldownMs(agent.id, m.id) > TRADE_COOLDOWN_MS);
        ordered = [...available].sort(() => Math.random() - 0.5).slice(0, 20);
      } else {
        // Interleave internal and external markets so agents see the full landscape
        const ours = active.filter((m) => !m.isExternal);
        const external = active.filter((m) => m.isExternal);
        // Round-robin interleave ours and external
        const interleaved: typeof active = [];
        const maxLen = Math.max(ours.length, external.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < ours.length) interleaved.push(ours[i]);
          if (i < external.length) interleaved.push(external[i]);
        }
        ordered = interleaved.slice(0, 25);
      }

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

        // Analyst odds for pricers and traders — primary signal
        let analystTag = "";
        if ((agent.role === "pricer" || agent.role === "trader") && m.analystOdds) {
          const a = m.analystOdds;
          const analystName = state.agents.get(a.analystId)?.name || a.analystId;
          analystTag = ` | ANALYST: ${analystName} says ${a.probability}% (${a.confidence}) — "${a.summary}"`;
        }

        // Oracle qualitative context for pricers and traders (skip if analyst odds exist)
        let oracleTag = "";
        if ((agent.role === "pricer" || agent.role === "trader") && m.oracleSummary && !m.analystOdds) {
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

        parts.push(`- ${shortTitle} [${m.id}] — ${priceStr}, ${tradeCount} trades${apiTag}${deadlineTag}${bookTag}${analystTag}${oracleTag}${historyTag}${attrTag}`);
      }
    }
  }

  // Creator market ideas backlog
  if (agent.role === "creator" && agent.marketIdeasBacklog && agent.marketIdeasBacklog.length > 0) {
    parts.push("\nYOUR MARKET IDEAS BACKLOG (pick from these when creating, or add new ones):");
    for (const idea of agent.marketIdeasBacklog) {
      const ago = Math.round((Date.now() - idea.addedAt) / 60_000);
      parts.push(`  - "${idea.idea}" (source: ${idea.source}, ${ago}min ago)`);
    }
  }

  // Show THIS pricer's assigned markets that need attention
  // Each pricer only sees their own book — no duplication
  if (agent.role === "pricer") {
    const myMarkets = getQuotedMarkets(agent.id);
    const myNeedWork = myMarkets
      .map((mid) => state.markets.get(mid))
      .filter((m): m is NonNullable<typeof m> => !!m && (m.bestBid === null || m.bestAsk === null));

    if (myNeedWork.length > 0) {
      parts.push(`\n⚠️ YOUR MARKETS NEED PRICING (${myNeedWork.length} assigned to you):`);
      for (const m of myNeedWork.slice(0, 5)) {
        const shortTitle = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 80);
        const oracleTag = m.oracleSummary ? ` — oracle: "${m.oracleSummary}"` : "";
        const apiPrice = m.fairValue !== null ? ` — API price: ${Math.round(m.fairValue * 100)}¢` : "";
        parts.push(`  - "${shortTitle}" [${m.id}]${oracleTag}${apiPrice}`);
      }
    } else {
      parts.push(`\n✅ YOUR ${myMarkets.length} MARKETS COVERED — analysts + algo MM handling quotes. Idle unless breaking news changes your view.`);
    }
  }

  // Recent pricing events for traders
  // Trade journal — recent orders, executions, cancellations for this trader
  if (agent.role === "trader") {
    const journal = state.getTradeJournal(agent.id, 10);
    if (journal.length > 0) {
      parts.push("\nYOUR RECENT TRADE JOURNAL:");
      for (const entry of journal) {
        const m = state.markets.get(entry.marketId);
        const shortQ = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 50) : entry.marketId;
        const ago = Math.round((Date.now() - entry.ts) / 60_000);
        if (entry.type === "cancel") {
          parts.push(`  - [CANCEL] "${shortQ}" ${ago}min ago${entry.reason ? ` — ${entry.reason}` : ""}`);
        } else {
          const verb = entry.type === "order" ? "ORDER" : "EXEC";
          parts.push(`  - [${verb}] ${entry.direction} ${entry.shares} ${entry.side} "${shortQ}" at ${entry.priceCents}¢ ${ago}min ago`);
        }
      }
    }
  }

  if (agent.role === "trader" && state.recentPricingEvents.length > 0) {
    parts.push("\nRECENT PRICING EVENTS (watch for signals):");
    for (const evt of state.recentPricingEvents.slice(0, 8)) {
      const pricer = state.agents.get(evt.agentId);
      const m = state.markets.get(evt.marketId);
      if (!m) continue;
      const shortQ = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 60);
      const ago = Math.round((Date.now() - evt.ts) / 60_000);
      parts.push(`  - ${pricer?.name || evt.agentId} priced "${shortQ}" at ${Math.round(evt.fairValue * 100)}¢ (spread ${Math.round(evt.spread * 100)}¢) ${ago}min ago`);
    }
  }

  // Other traders' positions for traders
  if (agent.role === "trader") {
    const otherTraderPositions: string[] = [];
    for (const [, a] of state.agents) {
      if (a.role === "trader" && a.id !== agent.id && a.positions && a.positions.length > 0) {
        const posStr = a.positions.slice(0, 3).map((p) => {
          const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
          const label = m ? m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 40) : "?";
          return `${p.outcome.toUpperCase()} ${Math.round(p.size)}x "${label}"`;
        }).join(", ");
        otherTraderPositions.push(`  - ${a.name}: ${posStr}`);
      }
    }
    if (otherTraderPositions.length > 0) {
      parts.push("\nOTHER TRADERS' POSITIONS:");
      parts.push(...otherTraderPositions);
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
  creator: `As a CREATOR, you design prediction markets about FUTURE events. You scan news, debate ideas, and curate a backlog of market ideas.

WORKFLOW:
- Move between NEWSROOM (scanning, debating, research) and WORKSHOP (creating). That's your world.
- Use "add_idea" freely to save market ideas to your backlog. Pick from the backlog when creating.
- Use "research" to verify facts before creating — especially for sports.

CRITICAL RULES — VIOLATIONS WILL BE REJECTED:
- Markets MUST be about FUTURE events. NEVER create a market about something that already happened.
- "FINAL SCORES" in the sports slate = ALREADY HAPPENED. Do NOT create markets for finished games.
- Only create markets for games listed under "UPCOMING GAMES" — those haven't started yet.
- Markets must start with "Will..." and be specific, measurable, and time-bound.
- You CANNOT trade or price markets — only create them.
- ONE market per game/event. Check ACTIVE MARKETS — don't duplicate.
- Quality over quantity. Idle or add_idea if nothing compelling is happening.
- IMPORTANT: We are in 2026. Do NOT reference 2024 or 2025 as future.

WHAT MAKES A GOOD MARKET:
- Specific upcoming game: "Will the Lakers beat the Celtics tonight?"
- Timely news event: "Will Trump announce new tariffs this week?"
- Measurable threshold: "Will Bitcoin reach $120K by Friday?"
- NOT: vague aggregates, past events, unrealistic targets, or generic topics.

BAD MARKETS (never create these):
- Past events: "Did Kansas win?" — the game already happened
- Unrealistic: targets too far from current price to be interesting
- Vague: "Will there be upsets tonight?" — not measurable
- Duplicate: anything already in ACTIVE MARKETS`,

  pricer: `As a PRICER, you set the FIRST price on brand-new markets. Your algorithmic market maker then takes over all ongoing quoting automatically.

YOUR JOB:
- Check "NEW MARKETS — NEED INITIAL PRICE" — these have NEVER been priced. Set their first fair value + spread.
- Once you post_price, your algo MM takes over: requoting, inventory skew, time decay, everything.
- Markets already showing a price (YES/NO with ¢ values) are HANDLED. Do NOT re-price them.
- Idle when there are no new markets to price. This is the normal state — your MM is working.
- Use "cancel_orders" only if something looks seriously wrong.

CRITICAL: Only use post_price on markets listed under "NEW MARKETS — NEED INITIAL PRICE". All other markets are already managed by your algo MM. Do NOT re-price them.

HOW TO SET INITIAL FAIR VALUE:

1. ANCHOR on ANALYST ODDS (your starting point):
   - ANALYST tags show probability estimates from our quantitative analysts (Sigma & Edge).
   - Use analyst odds as your primary anchor — they use volatility models, base rates, and time scaling.
   - Only deviate from analyst odds with strong conviction (breaking news, live game state, clear error).

2. ADJUST for context: Breaking news (±10-20¢), live scores (heavy adjust), book imbalance (±5¢).

3. TIME DECAY: >24h = normal. 6-24h = multiply by 0.7-0.9. 1-6h = 0.3-0.6. <1h = YES <10¢.
   Exception: Events currently in progress — price on current state.

4. SPREAD: Analyst high confidence → 0.03-0.05, medium → 0.05-0.08, low/no analyst → 0.08-0.15.

WHAT THE ALGO HANDLES AUTOMATICALLY (you don't need to do this):
- Requoting after fills (inventory-based skew)
- Widening spread when inventory gets heavy
- Time decay spread widening as expiry approaches
- Pulling quotes on resolved/expired markets

ACTIONS:
- "post_price": Set initial fair value on a market YOU haven't quoted yet (fairValue 0.01-0.99, spread 0.02-0.15)
- "cancel_orders": Pull all liquidity from a market
- "research": Look up info before pricing
- "speak": Discuss markets in the newsroom
- "idle": All markets are quoted — nothing to do

MOVEMENT: Newsroom for research, exchange to check your book.
RESEARCH: ALWAYS research sports markets before pricing.`,

  trader: `As a TRADER, you TRADE. Your job is to take positions on markets you have a view on. You should be trading EVERY TICK unless you truly have no opinion.

MECHANICS:
- side: "YES" = you think the event WILL happen. "NO" = you think it WON'T. direction: "buy" or "sell".
- Every trade CANCELS your existing orders on that market first, then places the new one.
- size = number of CONTRACTS (not dollars). Keep size between 10-100. The system will cap it to what you can afford.
- You CANNOT create or price markets — only trade.

CRITICAL RULES:
- You MUST trade on most ticks. Only idle if you genuinely have zero conviction on any market.
- Markets you traded recently are HIDDEN — look at what's available, don't fixate.
- Spread trades across multiple markets. Diversify.
- If your order fails, do NOT retry the same trade.

FINDING EDGE:
- If analyst odds differ from market price by ≥5¢, TRADE IT. Don't overthink.
- If news just broke that affects a market, TRADE IT immediately.
- When in doubt, pick the market with the biggest gap between analyst odds and market price.
- Don't waste ticks researching — you have analyst reports and news already. ACT on them.
- Research only if you have NO information about any market and need to form a view.

RISK MANAGEMENT:
- Risk 3-5% of account per trade. Keep size 10-100 contracts.
- Cut losers: bought at 60¢ now 35¢ → sell.
- Let winners run: bought at 40¢ now 70¢ → consider profit.
- Time decay: <6h to deadline → YES decays fast, consider selling.

BIAS TOWARD ACTION: When you see a market with analyst odds significantly different from the price, your DEFAULT should be to trade, not to research or idle. You are a trader, not a researcher.

RESOLUTION: Cancel all orders, sell losing positions, do NOT buy more.

MOVEMENT: Pit for trading, newsroom for research, exchange to check prices directly.

RESEARCH: Use "research" to look up scores, search web/X. Results appear in your next prompt.`,

  analyst: `As an ANALYST, you compute fair probabilities for prediction markets using quantitative models.

YOUR JOB:
- Analyze UNANALYZED markets by computing probability estimates
- Use "post_analysis" to publish your odds — pricers use these to set initial prices
- Your models run automatically (volatility models, base rates, time scaling)
- You add qualitative color via your summary

RULES:
- You CANNOT trade, price, or create markets — only analyze
- Focus on your specialty: ${"{"}specialty{"}"}
- One market at a time. Quality over speed.
- Idle when all markets have fresh analysis.

ACTIONS:
- "post_analysis": Publish your probability estimate for a market
- "speak": Discuss findings in the newsroom
- "research": Look up additional info
- "move": Move between buildings
- "idle": Nothing needs analysis right now

MOVEMENT: Newsroom (primary), Exchange (secondary) — you're a researcher who publishes findings.`,
};

const ACTION_EXAMPLES: Record<string, string> = {
  creator: `{"action":"create_market","topic":"Upcoming Lakers vs Celtics game tonight — will Lakers win?"}
{"action":"add_idea","idea":"Will Fed cut rates at next FOMC meeting?","source":"Reuters headline about inflation"}
{"action":"add_idea","idea":"Will Rangers beat Islanders tonight?","source":"NHL slate — game at 7pm"}
{"action":"research","query":"Blackhawks Jazz tonight","source":"sports"}
{"action":"research","query":"trump tariffs latest","source":"web"}
{"action":"speak","message":"Interesting slate tonight — lots of good matchups to create markets for.","emotion":"neutral"}
{"action":"idle"}`,

  pricer: `{"action":"post_price","marketId":"M1","fairValue":0.35,"spread":0.04}
{"action":"post_price","marketId":"M1","fairValue":0.40,"spread":0.03}
{"action":"cancel_orders","marketId":"M2"}
{"action":"research","query":"Lakers score tonight","source":"sports"}
{"action":"speak","message":"Repricing — news shifted my view.","emotion":"neutral"}
{"action":"idle"}`,

  trader: `{"action":"trade","marketId":"M1","side":"YES","size":50,"direction":"buy"}
{"action":"trade","marketId":"M5","side":"NO","size":30,"direction":"buy"}
{"action":"trade","marketId":"M1","side":"YES","size":30,"direction":"sell"}
{"action":"speak","message":"Cutting my position — thesis invalidated.","emotion":"cautious"}
{"action":"research","query":"Fed rate decision","source":"web"}
{"action":"idle"}

PREFER "trade" over all other actions. Only research if you have NO information. Only idle if every market looks fairly priced.`,

  analyst: `{"action":"post_analysis","marketId":"M1","probability":72,"confidence":"high","method":"Spread-implied: LAL @ BOS, spread -5.5","category":"sports_game","summary":"Lakers favored by 5.5 at home, historical spread conversion gives 72%."}
{"action":"research","query":"BTC volatility 30d","source":"web"}
{"action":"speak","message":"My model puts this at 38% — pricers are too high.","emotion":"neutral"}
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

  // Positions with current fair values, time decay, and book data (skip resolved)
  const activePositions = (agent.positions || []).filter(p => {
    if (p.size <= 0) return false;
    const m = state.markets.get(p.marketId) || state.getMarketByApiId(p.marketId);
    if (m && (m.resolutionStatus === "pending" || m.apiStatus === "pending" || m.apiStatus === "closed")) return false;
    return true;
  });
  if (activePositions.length > 0) {
    parts.push("\nYOUR POSITIONS:");
    for (const p of activePositions) {
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

  // Open orders with current fair values and distance assessment (skip resolved)
  const activeOrders = (agent.openOrders || []).filter(o => {
    const m = state.markets.get(o.marketId);
    if (m && (m.resolutionStatus === "pending" || m.apiStatus === "pending" || m.apiStatus === "closed")) return false;
    return true;
  });
  if (activeOrders.length > 0) {
    parts.push("\nYOUR OPEN ORDERS:");
    for (const o of activeOrders) {
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
        if (m.deadline) {
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
    ...activePositions.map((p) => p.marketId),
    ...activeOrders.map((o) => o.marketId),
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
