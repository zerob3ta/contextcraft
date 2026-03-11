import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { callMinimax, parseJsonAction } from "./brain";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";
import { validateAction, clampTradeSize, type AgentAction } from "./actions";
import { draftMarket } from "../market/creator";
import { runGroupChatTick } from "./group-chat";
import type { AgentState } from "../state";

const TICK_INTERVAL_MS = 8_000; // unified tick every 8s
const JOB_AGENTS_PER_ROLE = 1; // 1 agent per role on job duty
const MARKET_CREATION_MIN_INTERVAL = 90_000; // 90s global cooldown between market creations

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

  // Skip creator job duty if market was created recently (global cooldown)
  const now2 = Date.now();
  const filteredJobAgents = jobAgents.filter((a) => {
    if (a.role === "creator" && now2 - state.lastMarketCreatedAt < MARKET_CREATION_MIN_INTERVAL) {
      return false; // creator skips job duty, will participate in conversations instead
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
    const userPrompt = buildUserPrompt(agent, news, markets, marketNews, sportsSlate);

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
      broadcast({ type: "agent_speak", agentId, message: action.message, emotion: action.emotion });
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

      state.moveAgent(agentId, "exchange");
      broadcast({ type: "agent_move", agentId, destination: "exchange", reason: "Pricing" });

      state.updatePrice(action.marketId, action.fairValue, action.spread);
      broadcast({ type: "price_update", marketId: action.marketId, fairValue: action.fairValue, spread: action.spread });

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

      const size = clampTradeSize(agentId, action.size);
      const price = action.side === "YES"
        ? market.fairValue + (market.spread || 0.04) / 2
        : 1 - market.fairValue + (market.spread || 0.04) / 2;

      state.moveAgent(agentId, "pit");
      broadcast({ type: "agent_move", agentId, destination: "pit", reason: "Trading" });

      state.addTrade(action.marketId, agentId, action.side, size, price);
      broadcast({
        type: "trade_executed",
        agentId,
        marketId: action.marketId,
        side: action.side,
        size,
        price: Math.round(price * 100) / 100,
      });

      // Log to social context
      const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 40);
      state.addAction(agentId, `traded ${action.side}`, `$${size} on ${shortQ}`);
      state.setAgentCooldown(agentId, 6_000);

      // Return to lounge after cooldown
      returnToLounge(agentId, 6_000);
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
  const question = await draftMarket(topic, newsContext);

  if (!question) {
    console.log(`[Creator:${agent.name}] Claude returned null for topic: ${topic.slice(0, 60)}`);
    state.setAgentCooldown(agentId, 20_000);
    returnToLounge(agentId, 20_000);
    return;
  }

  if (state.isDuplicateMarket(question)) {
    console.log(`[Creator:${agent.name}] Duplicate market: ${question.slice(0, 60)}`);
    state.setAgentCooldown(agentId, 10_000);
    returnToLounge(agentId, 10_000);
    return;
  }

  const market = state.createMarket(question, agentId);
  state.lastMarketCreatedAt = Date.now();
  broadcast({ type: "market_spawning", marketId: market.id, question: market.question, creator: agentId });

  // Log to social context so other agents react to it
  state.addAction(agentId, "created market", question.slice(0, 60));
  state.setAgentCooldown(agentId, 20_000);
  returnToLounge(agentId, 20_000);
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
      return `${action.side} $${action.size} on "${shortTitle(m?.question || "market")}"`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
