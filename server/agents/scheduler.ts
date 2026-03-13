import { state } from "../state";
import { isNPC } from "./npcs";
import { broadcast } from "../ws-bridge";
import { callMinimax, parseJsonAction } from "./brain";
import { buildSystemPrompt, buildUserPrompt, buildPortfolioReviewSystemPrompt, buildPortfolioReviewPrompt } from "./prompts";
import { validateAction, clampTradeSize, type AgentAction } from "./actions";
import { draftMarket, type MarketDraft } from "../market/creator";
import { runGroupChatTick, runMagnetismTick, notifyBuildingEvent } from "./group-chat";
import { isContextEnabled } from "../context-api/client";
import { submitMarket, canCreateMarket } from "../context-api/markets";
import { placePricingOrders, placeTrade, cancelOrders } from "../context-api/trading";
import { getJobGrounding } from "./grounding";
import { executeResearch } from "./research";
import { isAgentAwake, isScramblePhase } from "../sleep";
import type { AgentMarketDraft } from "../context-api/types";
import type { AgentState, Market } from "../state";

const TICK_INTERVAL_MS = 14_000; // unified tick every 14s (was 8s — reduced for cost)
const JOB_AGENTS_PER_ROLE = 1; // 1 agent per role on job duty
const MARKET_CREATION_MIN_INTERVAL = 600_000; // 10min global cooldown between market creations
const PORTFOLIO_REVIEW_EVERY_N_TICKS = 4; // every 4th tick, pricers/traders review their book

let tickInterval: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

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
  // Skip everything if agents are sleeping (no viewers)
  if (!isAgentAwake()) return;

  const now = Date.now();
  tickCount++;
  const agents = Array.from(state.agents.values());

  // Pre-tick: force cancel orders for agents with open orders on resolving markets
  forceResolveCleanup();

  // Exclude agents on active directives from job duty (unless they have a directive to fulfill)
  const onDirective = new Set(
    agents.filter((a) => a.directive && a.directiveUntil > now).map((a) => a.id)
  );
  const available = agents.filter((a) => a.cooldownUntil <= now && !isNPC(a.id));
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

  // Skip job agents when there's nothing actionable — saves LLM calls
  const now2 = Date.now();
  const activeMarkets = state.getActiveMarkets();
  const hasActiveMarkets = activeMarkets.length > 0;
  const hasUnpricedMarkets = activeMarkets.some((m) => m.fairValue === null && m.apiMarketId);
  const hasRecentNews = state.getRecentNews(3).some((n) => now2 - n.timestamp < 15 * 60_000);

  const filteredJobAgents = jobAgents.filter((a) => {
    if (a.role === "creator") {
      if (now2 - state.lastMarketCreatedAt < MARKET_CREATION_MIN_INTERVAL) {
        return false; // cooldown
      }
      if (isContextEnabled() && !canCreateMarket()) {
        return false; // daily API limit reached
      }
    }
    // Skip pricer if no active markets to price (unless they have a directive)
    if (a.role === "pricer" && !hasActiveMarkets && !a.directive) {
      return false;
    }
    // Skip trader if no priced markets to trade AND no recent news to react to
    if (a.role === "trader" && !hasActiveMarkets && !hasRecentNews && !a.directive) {
      return false;
    }
    // On odd ticks, skip pricer/trader if all markets are already priced and no breaking news
    // This halves their frequency when things are calm
    if (tickCount % 2 === 1 && !a.directive) {
      if (a.role === "pricer" && !hasUnpricedMarkets && !hasRecentNews) return false;
      if (a.role === "trader" && !hasRecentNews) return false;
    }
    return true;
  });

  // Portfolio review: every Nth tick, one pricer and one trader review their book
  // During scramble phase (wake-up), ALL pricers/traders review simultaneously
  const reviewAgents: AgentState[] = [];
  const scramble = isScramblePhase();
  if (scramble && isContextEnabled()) {
    // Scramble: every pricer and trader reviews their book
    const jobIds = new Set(filteredJobAgents.map((a) => a.id));
    for (const a of [...pricers, ...traders]) {
      if (!jobIds.has(a.id)) reviewAgents.push(a);
    }
    if (reviewAgents.length > 0) {
      console.log(`[Tick] SCRAMBLE — ${reviewAgents.length} agents reviewing positions`);
    }
  } else if (tickCount % PORTFOLIO_REVIEW_EVERY_N_TICKS === 0 && isContextEnabled()) {
    // Normal: pick one pricer + one trader NOT already on normal job duty
    const jobIds = new Set(filteredJobAgents.map((a) => a.id));
    const reviewPricers = pricers.filter((a) => !jobIds.has(a.id) && !onDirective.has(a.id));
    const reviewTraders = traders.filter((a) => !jobIds.has(a.id) && !onDirective.has(a.id));
    if (reviewPricers.length > 0) reviewAgents.push(shuffle(reviewPricers)[0]);
    if (reviewTraders.length > 0) reviewAgents.push(shuffle(reviewTraders)[0]);
  }

  const jobNames = filteredJobAgents.map((a) => `${a.name}[job]`);
  const reviewNames = reviewAgents.map((a) => `${a.name}[review]`);
  const allNames = [...jobNames, ...reviewNames];
  console.log(`[Tick] ${allNames.join(", ")} + conversations`);

  // Settle agent locations BEFORE concurrent phase — magnetism moves happen first
  // so job agents and chat both see stable locations
  runMagnetismTick();

  // Exclude job + review agents from chat this tick (they're busy working)
  const busyIds = new Set([
    ...filteredJobAgents.map((a) => a.id),
    ...reviewAgents.map((a) => a.id),
  ]);

  // Run job agents + portfolio reviews + conversation system concurrently
  await Promise.allSettled([
    ...filteredJobAgents.map((a) => runJobAgent(a.id)),
    ...reviewAgents.map((a) => runPortfolioReview(a.id)),
    runGroupChatTick(busyIds),
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

// ─── Portfolio review (periodic book review for pricers/traders) ──

async function runPortfolioReview(agentId: string): Promise<void> {
  const agent = state.agents.get(agentId);
  if (!agent) return;

  // Skip if no positions and no open orders — nothing to review
  const hasPositions = agent.positions && agent.positions.length > 0 && agent.positions.some((p) => p.size > 0);
  const hasOrders = agent.openOrders && agent.openOrders.length > 0;
  if (!hasPositions && !hasOrders) {
    console.log(`[Review:${agent.name}] No positions or orders to review — skipping`);
    return;
  }

  try {
    const systemPrompt = buildPortfolioReviewSystemPrompt(agent);
    const userPrompt = buildPortfolioReviewPrompt(agent);

    const response = await callMinimax(systemPrompt, userPrompt);
    const raw = parseJsonAction(response);
    const action = validateAction(raw, agent.role);

    console.log(`[Review:${agent.name}] ${JSON.stringify(action)}`);

    if (action.action !== "idle") {
      await processAction(agentId, action);
      agent.lastActionAt = Date.now();
      state.setAgentCooldown(agentId, 6_000);
    }
  } catch (err) {
    console.error(`[Review:${agent.name}] Error:`, err);
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
      const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 70);
      state.addAction(agentId, "priced", `${shortQ} at ${cents}¢`);
      state.setAgentCooldown(agentId, 8_000);

      // Return to lounge after cooldown
      returnToLounge(agentId, 8_000);
      break;
    }

    case "trade": {
      const market = state.markets.get(action.marketId);
      if (!market || market.fairValue === null) break;

      const isResolvingMarket = market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed" ||
          market.resolutionStatus === "pending" || market.resolutionStatus === "resolved";

      // Hard block: do not BUY on resolving/resolved markets — but ALLOW SELLS (closing positions)
      if (isResolvingMarket && action.direction !== "sell") {
        console.log(`[Scheduler] BLOCKED buy on resolving ${action.marketId}`);
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
          const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 70);
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
        const shortQ = market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 70);
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
      state.addAction(agentId, "cancelled orders", market.question.replace(/^Will /, "").replace(/\?$/, "").slice(0, 70));
      break;
    }

    case "research": {
      // Only allowed in newsroom
      if (agent.location !== "newsroom") {
        state.moveAgent(agentId, "newsroom");
        broadcast({ type: "agent_move", agentId, destination: "newsroom", reason: "Heading to newsroom to research" });
      }

      console.log(`[Research] ${agent.name} researching "${action.query}" via ${action.source}`);
      const result = await executeResearch(action.query, action.source);
      agent.researchResult = result;
      agent.researchQuery = action.query;
      state.addAction(agentId, "researched", `${action.source}: ${action.query.slice(0, 80)}`);
      state.setAgentCooldown(agentId, 4_000);
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

  if (!result || typeof result === "string") {
    console.log(`[Creator:${agent.name}] Draft rejected (no structured market) for topic: ${topic.slice(0, 60)}`);
    state.setAgentCooldown(agentId, 20_000);
    returnToLounge(agentId, 20_000);
    return;
  }

  const question = result.question;

  if (state.isDuplicateMarket(question)) {
    console.log(`[Creator:${agent.name}] Duplicate market: ${question.slice(0, 80)}`);
    state.setAgentCooldown(agentId, 10_000);
    returnToLounge(agentId, 10_000);
    return;
  }

  // Use Context API if available, otherwise local-only
  if (isContextEnabled() && canCreateMarket()) {
    const endTime = new Date(Date.now() + result.endTimeHours * 60 * 60_000);

    const draft: AgentMarketDraft = {
      formattedQuestion: question,
      shortQuestion: result.shortQuestion,
      marketType: "OBJECTIVE",
      evidenceMode: result.evidenceMode,
      sources: result.sources.map((s) => s.startsWith("@") ? `https://x.com/${s.slice(1)}` : s),
      resolutionCriteria: result.resolutionCriteria,
      endTime: `${endTime.getFullYear()}-${String(endTime.getMonth() + 1).padStart(2, "0")}-${String(endTime.getDate()).padStart(2, "0")} ${String(endTime.getHours()).padStart(2, "0")}:${String(endTime.getMinutes()).padStart(2, "0")}:00`,
      timezone: "America/New_York",
    };

    // Non-blocking submit — goes to background poller
    const submissionId = await submitMarket(agentId, draft, question);
    if (submissionId) {
      console.log(`[Creator:${agent.name}] Submitted to Context API: ${question.slice(0, 80)} (${result.endTimeHours}h, ${draft.evidenceMode})`);
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
      state.addAction(agentId, "submitted market", question.slice(0, 80));
      announceNewMarket(agentId, question);
    } else {
      console.log(`[Creator:${agent.name}] Context API submit failed, falling back to local`);
      const market = state.createMarket(question, agentId);
      state.lastMarketCreatedAt = Date.now();
      broadcast({ type: "market_spawning", marketId: market.id, question: market.question, creator: agentId, building: "workshop" });
      notifyBuildingEvent("workshop");
      notifyBuildingEvent("exchange");
      state.addAction(agentId, "created market", question.slice(0, 80));
      announceNewMarket(agentId, question);
    }
  } else {
    // Local-only creation
    const market = state.createMarket(question, agentId);
    state.lastMarketCreatedAt = Date.now();
    broadcast({ type: "market_spawning", marketId: market.id, question: market.question, creator: agentId, building: "workshop" });
    notifyBuildingEvent("workshop");
    notifyBuildingEvent("exchange");
    state.addAction(agentId, "created market", question.slice(0, 80));
    announceNewMarket(agentId, question);
  }

  state.setAgentCooldown(agentId, 20_000);
  returnToLounge(agentId, 20_000);
}

/**
 * Announce a new market as news — pricers and traders need to know.
 */
function announceNewMarket(agentId: string, question: string): void {
  const agentName = state.agents.get(agentId)?.name || agentId;
  const shortQ = question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 80);
  const headline = `New market: "${shortQ}" — created by ${agentName}. Pricers: needs fair value. Traders: watch for entry.`;
  state.addNews({ headline, snippet: question, source: "Context Markets", category: "Markets" });
  broadcast({ type: "news_alert", headline, source: "Context Markets", severity: "normal", building: "newsroom" });
  notifyBuildingEvent("newsroom");
  notifyBuildingEvent("exchange");
  notifyBuildingEvent("pit");
}

function shortTitle(question: string): string {
  let q = question.replace(/^Will\s+/i, "").replace(/\?$/, "");
  return q.length > 70 ? q.slice(0, 67) + "..." : q;
}

function describeAction(_agent: AgentState, action: AgentAction): string {
  switch (action.action) {
    case "create_market":
      return `Created market: ${action.topic.slice(0, 80)}`;
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
      return `Said: "${action.message.slice(0, 90)}"`;
    case "move":
      return `Moved to ${action.destination}`;
    case "research":
      return `Researched: ${action.query.slice(0, 80)} (${action.source})`;
    case "idle":
      return "Observing";
  }
}

// Track sell attempts to prevent infinite sell loops on resolving markets
const sellAttempts = new Map<string, number>(); // key: `${agentId}-${marketId}`
const MAX_SELL_ATTEMPTS = 3;
// Track cancel-sent so we don't spam the API every tick
const cancelSent = new Set<string>(); // key: `${agentId}-${marketId}`

/**
 * Pre-tick cleanup: for every agent with open orders on resolving/resolved markets,
 * immediately cancel those orders without waiting for the LLM to decide.
 */
function forceResolveCleanup(): void {
  const resolvingMarkets = new Map<string, Market>();
  for (const m of state.getActiveMarkets()) {
    if (m.resolutionStatus === "pending" || m.resolutionStatus === "resolved" ||
        m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed") {
      resolvingMarkets.set(m.id, m); // keyed by local ID only to avoid duplicates
    }
  }
  if (resolvingMarkets.size === 0) return;

  for (const agent of state.agents.values()) {
    // Cancel ALL orders on resolving markets — don't rely on local openOrders tracking
    if ((agent.role === "pricer" || agent.role === "trader") && isContextEnabled()) {
      for (const [, m] of resolvingMarkets) {
        if (m.apiMarketId) {
          const key = `${agent.id}-${m.id}`;
          if (!cancelSent.has(key)) {
            cancelSent.add(key);
            cancelOrders(agent.id, m.id).catch(() => {
              cancelSent.delete(key); // retry on failure
            });
          }
        }
      }
    }

    // Set directive to sell losing positions on resolving markets (max 3 attempts)
    if (agent.positions && (agent.role === "trader" || agent.role === "pricer")) {
      if (agent.directive && agent.directiveUntil > Date.now()) continue; // don't override existing directive
      for (const pos of agent.positions) {
        const m = resolvingMarkets.get(pos.marketId);
        if (!m || pos.size <= 0) continue;
        const outcomeStr = m.outcome === 1 ? "YES" : m.outcome === 0 ? "NO" : null;
        if (!outcomeStr) continue;
        const isLosing = pos.outcome.toUpperCase() !== outcomeStr;
        if (isLosing) {
          const attemptKey = `${agent.id}-${m.id}`;
          const attempts = sellAttempts.get(attemptKey) || 0;
          if (attempts >= MAX_SELL_ATTEMPTS) {
            // Already tried enough — stop looping
            continue;
          }
          sellAttempts.set(attemptKey, attempts + 1);
          const shortQ = m.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
          agent.directive = `SELL your losing ${pos.outcome.toUpperCase()} position on "${shortQ}" [${m.id}] — market resolving ${outcomeStr}`;
          agent.directiveUntil = Date.now() + 30_000;
          console.log(`[Scheduler:ForceCleanup] ${agent.name} DIRECTIVE: sell losing position on ${m.id} (attempt ${attempts + 1}/${MAX_SELL_ATTEMPTS})`);
          break; // one directive at a time
        }
      }
    }
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
