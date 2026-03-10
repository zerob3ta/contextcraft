import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { callMinimax, parseJsonAction } from "./brain";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";
import { validateAction, clampTradeSize, type AgentAction } from "./actions";
import { draftMarket } from "../market/creator";
import { runSocialAgent } from "./social";
import type { AgentState } from "../state";

const TICK_INTERVAL_MS = 8_000; // unified tick every 8s
const JOB_AGENTS_PER_ROLE = 1; // 1 agent per role on job duty
const SOCIAL_AGENTS_PER_TICK = 4; // 4 agents socializing per tick

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

  // Everyone else is available for social
  const jobIds = new Set(jobAgents.map((a) => a.id));
  const socialPool = available.filter((a) => !jobIds.has(a.id));
  const socialAgents = shuffle(socialPool).slice(0, SOCIAL_AGENTS_PER_TICK);

  const jobNames = jobAgents.map((a) => `${a.name}[job]`);
  const socialNames = socialAgents.map((a) => `${a.name}[social]`);
  console.log(`[Tick] ${[...jobNames, ...socialNames].join(", ")}`);

  // Run all concurrently
  await Promise.allSettled([
    ...jobAgents.map((a) => runJobAgent(a.id)),
    ...socialAgents.map((a) => runSocialAgent(a.id)),
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
    await processAction(agentId, action);
    agent.lastActionAt = Date.now();
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
    return;
  }

  if (state.isDuplicateMarket(question)) {
    console.log(`[Creator:${agent.name}] Duplicate market: ${question.slice(0, 60)}`);
    state.setAgentCooldown(agentId, 10_000);
    return;
  }

  const market = state.createMarket(question, agentId);
  broadcast({ type: "market_spawning", marketId: market.id, question: market.question, creator: agentId });

  // Log to social context so other agents react to it
  state.addAction(agentId, "created market", question.slice(0, 60));
  state.setAgentCooldown(agentId, 20_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
