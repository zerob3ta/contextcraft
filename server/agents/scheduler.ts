import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { callMinimax, parseJsonAction } from "./brain";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";
import { validateAction, clampTradeSize, type AgentAction } from "./actions";
import { draftMarket, type MarketDraft } from "../market/creator";
import { runGroupChatTick, notifyBuildingEvent } from "./group-chat";
import { isContextEnabled } from "../context-api/client";
import { submitMarket, canCreateMarket } from "../context-api/markets";
import { placePricingOrders, placeTrade, cancelOrders } from "../context-api/trading";
import { getJobGrounding } from "./grounding";
import type { AgentMarketDraft } from "../context-api/types";
import type { AgentState } from "../state";

const TICK_INTERVAL_MS = 8_000; // unified tick every 8s
const JOB_AGENTS_PER_ROLE = 1; // 1 agent per role on job duty
const MARKET_CREATION_MIN_INTERVAL = 600_000; // 10min global cooldown between market creations

let tickInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  console.log("[Scheduler] Starting unified scheduler (job + social, 8s ticks)...");
  setTimeout(() => {
    runTick();
    tickInterval = setInterval(runTick, TICK_INTERVAL_MS);
  }, 10_000);
}

export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

async function runTick(): Promise<void> {
  const now = Date.now();
  const agents = Array.from(state.agents.values());

  // Exclude agents on active directives from job duty (unless they have a directive to fulfill)
  const onDirective = new Set(
    agents.filter((a) => a.directive && a.directiveUntil > now).map((a) => a.id)
  );
  const available = agents.filter((a) => a.cooldownUntil <= now);
  if (available.length === 0) return;

  // Split by role
  const creators = available.filter((a) => a.role === "creator");
  const pricers = available.filter((a) => a.role === "pricer");
  const traders = available.filter((a) => a.role === "trader");

  // Pick 1 from each role for job duty
  const shuffle = <T>(arr: T[]) => arr.sort(() => Math.random() - 0.5);
  const jobAgents: AgentState[] = [];
  if (creators.length > 0) jobAgents.push(shuffle(creators)[0]);
  if (pricers.length > 0) jobAgents.push(shuffle(pricers)[0]);
  if (traders.length > 0) jobAgents.push(shuffle(traders)[0]);

  // Skip creator job duty if market was created recently (global cooldown) or daily limit reached
  const now2 = Date.now();
  const filteredJobAgents = jobAgents.filter((a) => {
    if (a.role === "creator") {
      if (now2 - state.lastMarketCreatedAt < MARKET_CREATION_MIN_INTERVAL) {
        return false; // cooldown
      }
      if (isContextEnabled() && !canCreateMarket()) {
        return false; // daily API limit reached
      }
    }
    return true;
  });

  const jobNames = filteredJobAgents.map((a) => `${a.name}[job]`);
  console.log(`[Tick] ${jobNames.join(", ")} + conversations`);

  // Run job agents + conversation system concurrently
  await Promise.allSettled([
    ...filteredJobAgents.map((a) => runJobAgent(a.id)),
    runGroupChatTick(),
  ]);
}

// ─── Job agents (create/price/trade) ──────────────────────────────

async function runJobAgent(agentId: string): Promise<void> {
  const agent = state.agents.get(agentId);
  if (!agent) return;

  try {
    const news = state.getRecentNews(15);
    const markets = state.getActiveMarkets();
    const marketNews = agent.role === "pricer" || agent.role === "trader"
      ? markets.flatMap((m) => state.getMarketNews(m.id))
      : undefined;

    const systemPrompt = buildSystemPrompt(agent);
    const sportsSlate = agent.role === "creator" ? state.sportsSlate : undefined;
    let userPrompt = buildUserPrompt(agent, news, markets, marketNews, sportsSlate);

    // Smart grounding: inject web search or local context where it helps
    const groundingTopic = extractGroundingTopic(agent, markets);
    const marketQ = agent.directive?.match(/"([^"]+)"/)?.[1] || undefined;
    const grounding = await getJobGrounding(agent.role, groundingTopic, marketQ);
    if (grounding) {
      userPrompt += "\n" + grounding;
    }

    const response = await callMinimax(systemPrompt, userPrompt);
    const raw = parseJsonAction(response);
    const action = validateAction(raw, agent.role);

    console.log(`[Job:${agent.name}] ${JSON.stringify(action)}`);
    const hadDirective = agent.directive;
    await processAction(agentId, action);
    agent.lastActionAt = Date.now();

    // Clear directive after fulfilling a job action and broadcast fulfillment
    if (hadDirective) {
      const result = describeAction(agent, action);
      broadcast({
        type: "directive_fulfilled",
        agentId: agent.id,
        agentName: agent.name,
        directive: hadDirective,
        result,
        building: agent.location,
      });
      agent.directive = null;
      agent.directiveUntil = 0;
    }
  } catch (err) {
    console.error(`[Scheduler] Agent ${agentId} error:`, err);
  }
}

async function processAction(agentId: string, action: AgentAction): Promise<void> {
  const agent = state.agents.get(agentId);
  if (!agent) return;

  switch (action.action) {
    case "move": {
      state.moveAgent(agentId, action.destination);
      broadcast({ type: "agent_move", agentId, destination: action.destination, reason: action.reason });
      state.setAgentCooldown(agentId, 5_000);
      break;
    }

    case "speak": {
      broadcast({ type: "agent_speak", agentId, message: action.message, emotion: action.emotion, building: agent.location });
      agent.lastSpoke = action.message;
      state.addSpeech(agentId, action.message);
      break;
    }

    case "create_market": {
      await runMarketCreationFlow(agentId, action.topic);
      break;
    }

    case "post_price": {
      const market = state.markets.get(action.marketId);
      if (!market) break;

      // Hard block: do not price resolving/resolved markets
      if (market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed" ||
          market.resolutionStatus === "pending" || market.resolutionStatus === "resolved") {
        console.log(`[Scheduler] BLOCKED pricing on ${action.marketId} (status: ${market.apiStatus}, resolution: ${market.resolutionStatus})`);
        // Auto-cancel any open orders on this market
        if (isContextEnabled() && market.apiMarketId) {
          cancelOrders(agentId, action.marketId).catch(() => {});
        }
        break;
      }

      state.moveAgent(agentId, "exchange");
      broadcast({ type: "agent_move", agentId, destination: "exchange", reason: "Pricing" });

      // Use real API if available, otherwise local state
      if (isContextEnabled() && market.apiMarketId) {
        const fairCents = Math.round(action.fairValue * 100);
        const spreadCents = Math.round(action.spread * 100);
        const success = await placePricingOrders(agentId, action.marketId, fairCents, spreadCents);
        if (!success) {
          // Fall back to local pricing
          state.updatePrice(action.marketId, action.fairValue, action.spread);
          broadcast({ type: "price_update", marketId: action.marketId, fairValue: action.fairValue, spread: action.spread, building: "exchange" });
          notifyBuildingEvent("exchange");
          notifyBuildingEvent("pit");
        }
      } else {
        state.updatePrice(action.marketId, action.fairValue, action.spread);
        broadcast({ type: "price_update", marketId: action.marketId, fairValue: action.fairValue, spread: action.spread, building: "exchange" });
        notifyBuildingEvent("exchange");
        notifyBuildingEvent("pit");
      }

      // Log to social context so other agents can react
      const cents = Math.round(action.fairValue * 100);
      const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40);
      state.addAction(agentId, "priced", `${shortQ} at ${cents}¢`);
      state.setAgentCooldown(agentId, 8_000);

      // Return to lounge after cooldown
      returnToLounge(agentId, 8_000);
      break;
    }

    case "trade": {
      const market = state.markets.get(action.marketId);
      if (!market || market.fairValue === null) break;

      // Hard block: do not trade resolving/resolved markets
      if (market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed" ||
          market.resolutionStatus === "pending" || market.resolutionStatus === "resolved") {
        console.log(`[Scheduler] BLOCKED trade on ${action.marketId} (status: ${market.apiStatus}, resolution: ${market.resolutionStatus})`);
        // Auto-cancel any open orders on this market
        if (isContextEnabled() && market.apiMarketId) {
          cancelOrders(agentId, action.marketId).catch(() => {});
        }
        break;
      }

      const size = clampTradeSize(agentId, action.size);
      const dir = action.direction;

      state.moveAgent(agentId, "pit");
      broadcast({ type: "agent_move", agentId, destination: "pit", reason: dir === "sell" ? "Selling" : "Trading" });

      if (isContextEnabled() && market.apiMarketId) {
        const success = await placeTrade(agentId, action.marketId, action.side, size, dir);
        if (!success) {
          // Fall back to local
          const price = action.side === "YES"
            ? market.fairValue + (market.spread || 0.04) / 2
            : 1 - market.fairValue + (market.spread || 0.04) / 2;
          const localSize = Math.min(size, 100);
          const cost = Math.round(localSize * price * 100) / 100;
          state.addTrade(action.marketId, agentId, action.side, dir === "sell" ? -localSize : localSize, price);
          broadcast({
            type: "trade_executed", agentId, marketId: action.marketId,
            side: action.side, size: localSize,
            price: Math.round(price * 100) / 100, building: "pit", question: market.question,
          });
          notifyBuildingEvent("pit");
          const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40);
          state.addAction(agentId, `${dir === "sell" ? "sold" : "bought"} ${action.side}`, `$${cost} on ${shortQ}`);
        }
      } else {
        const price = action.side === "YES"
          ? market.fairValue + (market.spread || 0.04) / 2
          : 1 - market.fairValue + (market.spread || 0.04) / 2;
        const localSize = Math.min(size, 100);
        const cost = Math.round(localSize * price * 100) / 100;
        state.addTrade(action.marketId, agentId, action.side, dir === "sell" ? -localSize : localSize, price);
        broadcast({
          type: "trade_executed", agentId, marketId: action.marketId,
          side: action.side, size: localSize,
          price: Math.round(price * 100) / 100, building: "pit", question: market.question,
        });
        notifyBuildingEvent("pit");
        const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40);
        state.addAction(agentId, `${dir === "sell" ? "sold" : "bought"} ${action.side}`, `$${cost} on ${shortQ}`);
      }

      state.setAgentCooldown(agentId, 6_000);
      returnToLounge(agentId, 6_000);
      break;
    }

    case "cancel_orders": {
      const market = state.markets.get(action.marketId);
      if (!market) break;

      if (isContextEnabled() && market.apiMarketId) {
        await cancelOrders(agentId, action.marketId);
      }
      state.addAction(agentId, "cancelled orders", market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40));
      break;
    }

    case "idle":
      break;
  }
}

// ─── Market creation flow ──────────────────────────────────────────

async function runMarketCreationFlow(agentId: string, topic: string): Promise<void> {
  const agent = state.agents.get(agentId);
  if (!agent) return;

  state.moveAgent(agentId, "workshop");
  broadcast({ type: "agent_move", agentId, destination: "workshop", reason: "Creating market" });

  await sleep(1500);

  const news = state.getRecentNews(5);
  const newsContext = news.map((n) => `- ${n.headline}: ${n.snippet}`).join("\n");
  const result = await draftMarket(topic, newsContext);

  if (!result) {
    console.log(`[Creator:${agent.name}] Claude returned null for topic: ${topic.slice(0, 60)}`);
    state.setAgentCooldown(agentId, 20_000);
    returnToLounge(agentId, 20_000);
    return;
  }

  // Extract question string from result (structured MarketDraft or plain string)
  const question = typeof result === "string" ? result : result.question;

  if (state.isDuplicateMarket(question)) {
    console.log(`[Creator:${agent.name}] Duplicate market: ${question.slice(0, 60)}`);
    state.setAgentCooldown(agentId, 10_000);
    returnToLounge(agentId, 10_000);
    return;
  }

  // Use Context API if available, otherwise local-only
  if (isContextEnabled() && canCreateMarket()) {
    // Build structured draft for agent-submit — use MarketDraft fields if available
    const isStructured = typeof result !== "string";
    const endTimeHours = isStructured ? result.endTimeHours : 24;
    const endTime = new Date(Date.now() + endTimeHours * 60 * 60_000);

    const draft: AgentMarketDraft = {
      formattedQuestion: question,
      shortQuestion: isStructured ? result.shortQuestion : (question.length > 200 ? question.slice(0, 197) + "..." : question),
      marketType: "OBJECTIVE",
      evidenceMode: isStructured ? result.evidenceMode : "web_enabled",
      sources: isStructured
        ? result.sources.map((s) => s.startsWith("@") ? `https://x.com/${s.slice(1)}` : s)
        : inferSources(question, topic),
      resolutionCriteria: isStructured
        ? result.resolutionCriteria
        : `This market resolves YES if the event described in the question occurs before the end time. Otherwise it resolves NO. Resolution is determined by official sources and credible news reporting.`,
      endTime: `${endTime.getFullYear()}-${String(endTime.getMonth() + 1).padStart(2, "0")}-${String(endTime.getDate()).padStart(2, "0")} ${String(endTime.getHours()).padStart(2, "0")}:${String(endTime.getMinutes()).padStart(2, "0")}:00`,
      timezone: "America/New_York",
    };

    // Non-blocking submit — goes to background poller
    const submissionId = await submitMarket(agentId, draft, question);
    if (submissionId) {
      console.log(`[Creator:${agent.name}] Submitted to Context API: ${question.slice(0, 60)} (${endTimeHours}h, ${draft.evidenceMode})`);
      const market = state.createMarket(question, agentId);
      state.lastMarketCreatedAt = Date.now();
      broadcast({
        type: "market_spawning",
        marketId: market.id,
        question: market.question,
        creator: agentId,
        building: "workshop",
      });
      notifyBuildingEvent("workshop");
      notifyBuildingEvent("exchange");
      state.addAction(agentId, "submitted market", question.slice(0, 60));
      announceNewMarket(agentId, question);
    } else {
      console.log(`[Creator:${agent.name}] Context API submit failed, falling back to local`);
      const market = state.createMarket(question, agentId);
      state.lastMarketCreatedAt = Date.now();
      broadcast({ type: "market_spawning", marketId: market.id, question: market.question, creator: agentId, building: "workshop" });
      notifyBuildingEvent("workshop");
      notifyBuildingEvent("exchange");
      state.addAction(agentId, "created market", question.slice(0, 60));
      announceNewMarket(agentId, question);
    }
  } else {
    // Local-only creation
    const market = state.createMarket(question, agentId);
    state.lastMarketCreatedAt = Date.now();
    broadcast({ type: "market_spawning", marketId: market.id, question: market.question, creator: agentId, building: "workshop" });
    notifyBuildingEvent("workshop");
    notifyBuildingEvent("exchange");
    state.addAction(agentId, "created market", question.slice(0, 60));
    announceNewMarket(agentId, question);
  }

  state.setAgentCooldown(agentId, 20_000);
  returnToLounge(agentId, 20_000);
}

/**
 * Infer resolution sources from the question topic.
 * Context API expects X account URLs (https://x.com/handle) or web URLs.
 */
function inferSources(question: string, topic: string): string[] {
  const q = (question + " " + topic).toLowerCase();
  const sources: string[] = [];

  // Sports — use well-known verified X accounts
  if (q.match(/nba|nfl|nhl|ncaa|laker|celtics|cavalier|knick|spread|game.*tonight|win.*tonight|beat|cover/)) {
    sources.push("https://x.com/espn");
    sources.push("https://x.com/sportscenter");
  }
  // Crypto
  if (q.match(/btc|eth|bitcoin|crypto|token|solana|defi/)) {
    sources.push("https://x.com/coindesk");
    sources.push("https://x.com/coingecko");
  }
  // Politics
  if (q.match(/trump|congress|president|fed|election|senate|house|vote/)) {
    sources.push("https://x.com/ap");
    sources.push("https://x.com/reuters");
  }
  // Tech
  if (q.match(/apple|google|openai|ai|nvidia|tesla|spacex|tech/)) {
    sources.push("https://x.com/reuters");
    sources.push("https://x.com/techcrunch");
  }

  // Always include at least one general source
  if (sources.length === 0) {
    sources.push("https://x.com/ap");
    sources.push("https://x.com/reuters");
  }

  return sources.slice(0, 5);
}

/**
 * Announce a new market as news — pricers and traders need to know.
 */
function announceNewMarket(agentId: string, question: string): void {
  const agentName = state.agents.get(agentId)?.name || agentId;
  const shortQ = question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 60);
  const headline = `New market: "${shortQ}" — created by ${agentName}. Pricers: needs fair value. Traders: watch for entry.`;
  state.addNews({ headline, snippet: question, source: "Context Markets", category: "Markets" });
  broadcast({ type: "news_alert", headline, source: "Context Markets", severity: "normal", building: "newsroom" });
  notifyBuildingEvent("newsroom");
  notifyBuildingEvent("exchange");
  notifyBuildingEvent("pit");
}

function shortTitle(question: string): string {
  let q = question.replace(/^Will\s+/i, "").replace(/\?$/, "");
  return q.length > 30 ? q.slice(0, 28) + ".." : q;
}

function describeAction(_agent: AgentState, action: AgentAction): string {
  switch (action.action) {
    case "create_market":
      return `Created market: ${action.topic.slice(0, 50)}`;
    case "post_price": {
      const m = state.markets.get(action.marketId);
      return `Priced "${shortTitle(m?.question || "market")}" at ${Math.round(action.fairValue * 100)}¢`;
    }
    case "trade": {
      const m = state.markets.get(action.marketId);
      return `${action.direction === "sell" ? "Sold" : "Bought"} ${action.side} $${action.size} on "${shortTitle(m?.question || "market")}"`;
    }
    case "cancel_orders": {
      const m = state.markets.get(action.marketId);
      return `Cancelled orders on "${shortTitle(m?.question || "market")}"`;
    }
    case "speak":
      return `Said: "${action.message.slice(0, 40)}"`;
    case "move":
      return `Moved to ${action.destination}`;
    case "idle":
      return "Observing";
  }
}

function returnToLounge(agentId: string, delayMs: number): void {
  setTimeout(() => {
    const agent = state.agents.get(agentId);
    if (!agent) return;
    // Only return if not on a new directive
    if (agent.directive && agent.directiveUntil > Date.now()) return;
    if (agent.location === "lounge") return;
    state.moveAgent(agentId, "lounge");
    broadcast({ type: "agent_move", agentId, destination: "lounge", reason: "Returning to lounge" });
  }, delayMs);
}

/**
 * Extract a grounding topic from the agent's current context.
 * Uses directive, recent news, and market questions to decide what to search.
 */
function extractGroundingTopic(agent: AgentState, markets: ReturnType<typeof state.getActiveMarkets>): string {
  // If agent has a directive, extract the topic from it
  if (agent.directive) {
    return agent.directive;
  }

  // For creators: use recent news topics
  if (agent.role === "creator") {
    const news = state.getRecentNews(3);
    if (news.length > 0) {
      return news[0].headline;
    }
  }

  // For pricers/traders: use the first unpriced or recently active market
  if (agent.role === "pricer") {
    const unpriced = markets.find((m) => m.fairValue === null && m.apiMarketId);
    if (unpriced) return unpriced.question;
    const recent = markets[0];
    if (recent) return recent.question;
  }

  if (agent.role === "trader") {
    const recent = markets.find((m) => m.trades.length > 0);
    if (recent) return recent.question;
    if (markets[0]) return markets[0].question;
  }

  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
