/**
 * Background sync: balances, positions, and market discovery.
 * Runs periodically to keep local state in sync with Context Markets.
 */

import { getAgentClient, getReadClient } from "./client";
import { state, type Market } from "../state";
import { broadcast } from "../ws-bridge";
import { ALL_AGENTS } from "../../src/game/config/agents";
import { notifyBuildingEvent } from "../agents/group-chat";
import { sweepStaleOrders } from "./trading";


/**
 * Derive human-readable outcome string from API fields.
 * Context Markets: outcome 0 = NO, outcome 1 = YES.
 * Falls back to payoutPcts when outcome is null (e.g. during proposals).
 */
function inferOutcomeStr(
  apiOutcome: number | null | undefined,
  payoutPcts: number[] | null | undefined,
  market?: { oracleSummary?: string | null }
): string {
  // Direct outcome field (most reliable when present)
  if (apiOutcome === 0) return "NO";
  if (apiOutcome === 1) return "YES";

  // Derive from payoutPcts: the index with 1000000 (100%) is the winning outcome
  if (payoutPcts && payoutPcts.length >= 2) {
    if (payoutPcts[1] === 1000000) return "YES";
    if (payoutPcts[0] === 1000000) return "NO";
    // Partial payouts — pick the higher one
    if (payoutPcts[1] > payoutPcts[0]) return "YES";
    if (payoutPcts[0] > payoutPcts[1]) return "NO";
  }

  return "pending";
}

const BALANCE_SYNC_INTERVAL_MS = 30_000; // 30s
const MARKET_SYNC_INTERVAL_MS = 60_000; // 60s
const TOPIC_SEARCH_INTERVAL_MS = 120_000; // 2min — search based on chat topics
const ORACLE_SYNC_INTERVAL_MS = 90_000; // 90s — oracle + quotes for active markets
const EXPOSURE_CHECK_INTERVAL_MS = 45_000; // 45s — check resolution status of markets agents have positions in
const STALE_ORDER_SWEEP_INTERVAL_MS = 120_000; // 2min — cancel orders far from fair value

let balanceSyncTimer: ReturnType<typeof setInterval> | null = null;
let marketSyncTimer: ReturnType<typeof setInterval> | null = null;
let topicSearchTimer: ReturnType<typeof setInterval> | null = null;
let oracleSyncTimer: ReturnType<typeof setInterval> | null = null;
let exposureCheckTimer: ReturnType<typeof setInterval> | null = null;
let staleOrderSweepTimer: ReturnType<typeof setInterval> | null = null;

// Circuit breaker
let consecutiveFailures = 0;
const MAX_FAILURES = 5;
const CIRCUIT_BREAK_MS = 60_000;
let circuitBrokenUntil = 0;

function isCircuitBroken(): boolean {
  if (circuitBrokenUntil > Date.now()) return true;
  return false;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    circuitBrokenUntil = Date.now() + CIRCUIT_BREAK_MS;
    console.warn(`[Context Sync] Circuit breaker tripped — pausing API calls for ${CIRCUIT_BREAK_MS / 1000}s`);
    consecutiveFailures = 0;
  }
}

/**
 * Start background sync loops.
 */
export function startSync(): void {
  console.log("[Context Sync] Starting balance + market sync loops");

  // Initial sync after a short delay
  setTimeout(() => syncBalances(), 5_000);
  setTimeout(() => syncMarkets(), 10_000);
  setTimeout(() => searchChatTopics(), 30_000);
  setTimeout(() => syncOracleData(), 20_000);
  setTimeout(() => checkExposedMarkets(), 15_000);
  setTimeout(() => sweepStaleOrders(), 60_000); // first sweep after 1 min

  balanceSyncTimer = setInterval(syncBalances, BALANCE_SYNC_INTERVAL_MS);
  marketSyncTimer = setInterval(syncMarkets, MARKET_SYNC_INTERVAL_MS);
  topicSearchTimer = setInterval(searchChatTopics, TOPIC_SEARCH_INTERVAL_MS);
  oracleSyncTimer = setInterval(syncOracleData, ORACLE_SYNC_INTERVAL_MS);
  exposureCheckTimer = setInterval(checkExposedMarkets, EXPOSURE_CHECK_INTERVAL_MS);
  staleOrderSweepTimer = setInterval(sweepStaleOrders, STALE_ORDER_SWEEP_INTERVAL_MS);
}

export function stopSync(): void {
  if (balanceSyncTimer) { clearInterval(balanceSyncTimer); balanceSyncTimer = null; }
  if (marketSyncTimer) { clearInterval(marketSyncTimer); marketSyncTimer = null; }
  if (topicSearchTimer) { clearInterval(topicSearchTimer); topicSearchTimer = null; }
  if (oracleSyncTimer) { clearInterval(oracleSyncTimer); oracleSyncTimer = null; }
  if (exposureCheckTimer) { clearInterval(exposureCheckTimer); exposureCheckTimer = null; }
  if (staleOrderSweepTimer) { clearInterval(staleOrderSweepTimer); staleOrderSweepTimer = null; }
}

/**
 * Sync balances and positions for all trading agents.
 */
async function syncBalances(): Promise<void> {
  if (isCircuitBroken()) return;

  const tradingAgents = ALL_AGENTS.filter((a) => a.role === "pricer" || a.role === "trader");

  for (const agentCfg of tradingAgents) {
    const client = getAgentClient(agentCfg.id);
    const agent = state.agents.get(agentCfg.id);
    if (!client || !agent) continue;

    try {
      // Fetch balance
      const balance = await client.portfolio.balance();
      agent.usdcBalance = parseFloat(String(balance?.usdc?.balance ?? "0"));

      // Fetch positions
      const portfolio = await client.portfolio.get();
      const positions = portfolio?.portfolio ?? [];
      agent.positions = positions.map((p) => ({
        marketId: p.marketId,
        outcome: p.outcomeName || `index-${p.outcomeIndex}`,
        size: parseFloat(String(p.balance ?? "0")),
        avgPrice: parseFloat(String(p.netInvestment ?? "0")) / Math.max(1, parseFloat(String(p.balance ?? "1"))),
      }));

      recordSuccess();
    } catch {
      recordFailure();
    }
  }
}

/**
 * Discover active markets from Context Markets testnet.
 * Merges with locally tracked markets.
 */
async function syncMarkets(): Promise<void> {
  if (isCircuitBroken()) return;

  const client = getReadClient();
  if (!client) return;

  try {
    // Fetch markets with multiple strategies — cast a wide net across the testnet
    const [defaultResult, trendingResult, recentResult, pendingResult, resolvedResult] = await Promise.allSettled([
      client.markets.list({ status: "active", limit: 50 }),
      client.markets.list({ status: "active", limit: 30, sortBy: "volume" }),
      client.markets.list({ status: "active", limit: 30, sortBy: "new" }),
      client.markets.list({ status: "pending", limit: 20 }),
      client.markets.list({ status: "resolved", limit: 20 }),
    ]);

    const defaultMarkets = defaultResult.status === "fulfilled" ? (defaultResult.value?.markets ?? []) : [];
    const trendingMarkets = trendingResult.status === "fulfilled" ? (trendingResult.value?.markets ?? []) : [];
    const recentMarkets = recentResult.status === "fulfilled" ? (recentResult.value?.markets ?? []) : [];
    const pendingMarkets = pendingResult.status === "fulfilled" ? (pendingResult.value?.markets ?? []) : [];
    const resolvedMarkets = resolvedResult.status === "fulfilled" ? (resolvedResult.value?.markets ?? []) : [];

    // Merge and deduplicate
    const seen = new Set<string>();
    const apiMarkets: typeof defaultMarkets = [];
    for (const m of [...defaultMarkets, ...trendingMarkets, ...recentMarkets, ...pendingMarkets, ...resolvedMarkets]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        apiMarkets.push(m);
      }
    }

    let newCount = 0;
    for (const m of apiMarkets) {
      const question = m.question || m.shortQuestion || m.id;
      const yesPrice = m.outcomePrices?.find((op) => op.outcomeIndex === 0);
      // Debug price data (only when values look wrong — > 1.0 after scaling)
      if (yesPrice?.lastPrice && yesPrice.lastPrice / 1_000_000 > 1.0) {
        console.log(`[Sync:Price:WARN] "${question.slice(0, 70)}" lastPrice=${yesPrice.lastPrice} → ${yesPrice.lastPrice / 1_000_000} (>1.0!)`);
      }
      // lastPrice is in raw units (PRICE_MULTIPLIER=10000, so 65¢ = 650000): divide by 1M for 0-1
      const fairValue = yesPrice?.lastPrice ? yesPrice.lastPrice / 1_000_000 : null;

      // Read resolution status directly from SDK market object
      const apiStatus = m.status;  // "active" | "pending" | "resolved" | "closed"
      const resolutionStatus = m.resolutionStatus;  // "none" | "pending" | "resolved"
      const proposedAt = m.proposedAt;
      const resolvedAt = m.resolvedAt;
      const apiOutcome = m.outcome;
      const payoutPcts = m.payoutPcts;
      const deadline = (m as Record<string, unknown>).deadline as string | undefined;

      // Check if we already track this market
      const existing = state.getMarketByApiId(m.id);
      if (existing) {
        // Log resolution fields for debugging
        if (apiStatus !== "active" || resolutionStatus !== "none") {
          console.log(`[Sync] ${existing.id} resolution: status=${apiStatus}, resStatus=${resolutionStatus}, outcome=${apiOutcome}, proposedAt=${proposedAt}`);
        }
        // Update resolution status
        const prevStatus = existing.apiStatus;
        if (apiStatus) existing.apiStatus = apiStatus as Market["apiStatus"];
        if (resolutionStatus) existing.resolutionStatus = resolutionStatus as Market["resolutionStatus"];
        if (proposedAt) existing.proposedAt = new Date(proposedAt).getTime();
        if (resolvedAt) existing.resolvedAt = new Date(resolvedAt).getTime();
        if (apiOutcome !== undefined) existing.outcome = apiOutcome;
        if (payoutPcts) existing.payoutPcts = payoutPcts;
        if (deadline) existing.deadline = deadline;

        // Detect status transitions — proposals are BREAKING, resolution is normal
        if (apiStatus && apiStatus !== prevStatus) {
          const shortQ = question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);

          if (resolutionStatus === "pending" || apiStatus === "pending") {
            // Oracle PROPOSAL — this is breaking news (fires once per market)
            const outcomeStr = inferOutcomeStr(apiOutcome, payoutPcts, existing);
            const headline = `⚠️ RESOLUTION PROPOSED: "${shortQ}" → ${outcomeStr}. Pricers: pull your orders. Traders: close positions.`;
            if (state.markBreaking(`proposal-${existing.id}`)) {
              state.addNews({ headline, snippet: "", source: "Resolution", category: "Markets" });
              broadcast({ type: "news_alert", headline, source: "Resolution", severity: "breaking", building: "newsroom" });
              notifyBuildingEvent("newsroom");
              notifyBuildingEvent("exchange");
              notifyBuildingEvent("pit");
            }
          }

          if (apiStatus === "resolved" || apiStatus === "closed") {
            // Resolution finalized — informational, not breaking (agents already know from proposal)
            const outcomeStr = inferOutcomeStr(apiOutcome, payoutPcts, existing);
            const headline = `RESOLVED: "${shortQ}" → ${outcomeStr}. Market is closed.`;
            state.addNews({ headline, snippet: "", source: "Resolution", category: "Markets" });
            notifyBuildingEvent("exchange");
            notifyBuildingEvent("pit");
          }
        }

        // Update price if it changed significantly (>3pt move)
        if (fairValue !== null && existing.fairValue !== null) {
          const oldPct = Math.round(existing.fairValue * 100);
          const newPct = Math.round(fairValue * 100);
          const delta = Math.abs(newPct - oldPct);
          if (delta >= 3) {
            state.updatePrice(existing.id, fairValue, existing.spread || 0);
            const shortQ = question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
            const dir = newPct > oldPct ? "up" : "down";
            const headline = `Market update: "${shortQ}" moved ${dir} to ${newPct}% (was ${oldPct}%)`;
            state.addNews({ headline, snippet: "", source: "Market Data", category: "Markets" });
            broadcast({ type: "news_alert", headline, source: "Market Data", severity: "normal", building: "newsroom" });
            notifyBuildingEvent("newsroom");
            notifyBuildingEvent("exchange");
          }
        } else if (fairValue !== null && existing.fairValue === null) {
          state.updatePrice(existing.id, fairValue, existing.spread || 0);
        }
        continue;
      }

      // Add as external market
      const localId = state.addExternalMarket({
        apiMarketId: m.id,
        question,
        fairValue,
      });

      if (localId) {
        // Store deadline from API
        const mDeadline = (m as Record<string, unknown>).deadline as string | undefined;
        if (mDeadline) {
          const market = state.markets.get(localId);
          if (market) market.deadline = mDeadline;
        }
        newCount++;
      }
    }

    if (newCount > 0) {
      console.log(`[Context Sync] Discovered ${newCount} new markets from testnet`);
      broadcast({
        type: "markets_synced",
        count: state.getActiveMarkets().length,
      });
    }

    // Auto-cancel all agent orders on resolving/resolved markets
    const resolvingMarkets = state.getActiveMarkets().filter((m) =>
      m.apiMarketId && (
        m.apiStatus === "pending" || m.apiStatus === "resolved" || m.apiStatus === "closed" ||
        m.resolutionStatus === "pending" || m.resolutionStatus === "resolved"
      )
    );
    if (resolvingMarkets.length > 0) {
      const { cancelOrders } = await import("./trading");
      for (const market of resolvingMarkets) {
        // Cancel orders for ALL agents — don't rely on local openOrders tracking
        for (const agent of state.agents.values()) {
          if (agent.role === "pricer" || agent.role === "trader") {
            cancelOrders(agent.id, market.id).catch(() => {});
          }
        }
      }
    }

    // Detect finished games and locally resolve matching markets
    detectGameResults();

    recordSuccess();
  } catch (err) {
    console.error("[Context Sync] Market sync failed:", err);
    recordFailure();
  }
}

/**
 * Position exposure check: individually fetch the status of every market where
 * agents have positions or open orders. This catches resolution status changes
 * that the batch list calls miss (e.g., a market that moved from "active" to
 * "resolved" between list fetches, or one that never appeared in the pending list).
 *
 * This is the MOST IMPORTANT sync for agent safety — agents must always know
 * when a market they're exposed to is resolving.
 */
async function checkExposedMarkets(): Promise<void> {
  if (isCircuitBroken()) return;

  const client = getReadClient();
  if (!client) return;

  // Collect all API market IDs where agents have positions or open orders
  const exposedApiIds = new Set<string>();
  for (const agent of state.agents.values()) {
    if (agent.positions) {
      for (const p of agent.positions) {
        // Position marketId from portfolio API is the API market ID
        const localMarket = state.markets.get(p.marketId);
        const apiId = localMarket?.apiMarketId || p.marketId;
        // Verify this looks like an API ID (not a local M1, M2 ID)
        if (apiId && !apiId.startsWith("M")) {
          exposedApiIds.add(apiId);
        }
      }
    }
    if (agent.openOrders) {
      for (const o of agent.openOrders) {
        const localMarket = state.markets.get(o.marketId);
        const apiId = localMarket?.apiMarketId || o.marketId;
        if (apiId && !apiId.startsWith("M")) {
          exposedApiIds.add(apiId);
        }
      }
    }
  }

  if (exposedApiIds.size === 0) return;

  // Check up to 5 markets per cycle to avoid rate limits
  const toCheck = Array.from(exposedApiIds).slice(0, 5);

  for (const apiMarketId of toCheck) {
    try {
      const m = await client.markets.get(apiMarketId);
      if (!m) continue;

      const existing = state.getMarketByApiId(apiMarketId);
      if (!existing) continue;

      const apiStatus = m.status;
      const resolutionStatus = m.resolutionStatus;
      const apiOutcome = m.outcome;

      // Always log what we see for exposed markets
      if (apiStatus !== "active" || (resolutionStatus && resolutionStatus !== "none")) {
        console.log(`[ExposureCheck] ${existing.id} "${existing.question.slice(0, 70)}" — status=${apiStatus}, resStatus=${resolutionStatus}, outcome=${apiOutcome}`);
      }

      // Update resolution fields
      const prevStatus = existing.apiStatus;
      const prevResStatus = existing.resolutionStatus;
      if (apiStatus) existing.apiStatus = apiStatus as Market["apiStatus"];
      if (resolutionStatus) existing.resolutionStatus = resolutionStatus as Market["resolutionStatus"];
      if (m.proposedAt) existing.proposedAt = new Date(m.proposedAt).getTime();
      if (m.resolvedAt) existing.resolvedAt = new Date(m.resolvedAt).getTime();
      if (apiOutcome !== undefined && apiOutcome !== null) existing.outcome = apiOutcome;
      if (m.payoutPcts) existing.payoutPcts = m.payoutPcts;
      const mDeadline = (m as Record<string, unknown>).deadline as string | undefined;
      if (mDeadline) existing.deadline = mDeadline;

      // Detect status transitions and alert
      if (apiStatus && apiStatus !== prevStatus && prevStatus !== null) {
        const question = existing.question;
        const shortQ = question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);

        if (resolutionStatus === "pending" || apiStatus === "pending") {
          // Oracle PROPOSAL — breaking, fires once per market
          const outcomeStr = inferOutcomeStr(apiOutcome, m.payoutPcts, existing);
          const headline = `⚠️ RESOLUTION PROPOSED: "${shortQ}" → ${outcomeStr}. Pricers: pull your orders. Traders: close positions.`;
          if (state.markBreaking(`proposal-${existing.id}`)) {
            state.addNews({ headline, snippet: "", source: "Resolution", category: "Markets" });
            broadcast({ type: "news_alert", headline, source: "Resolution", severity: "breaking", building: "newsroom" });
            notifyBuildingEvent("newsroom");
            notifyBuildingEvent("exchange");
            notifyBuildingEvent("pit");
          }
        }

        if (apiStatus === "resolved" || apiStatus === "closed") {
          // Resolution finalized — informational, not breaking
          const outcomeStr = inferOutcomeStr(apiOutcome, m.payoutPcts, existing);
          const headline = `RESOLVED: "${shortQ}" → ${outcomeStr}. Market is closed.`;
          state.addNews({ headline, snippet: "", source: "Resolution", category: "Markets" });
          notifyBuildingEvent("exchange");
          notifyBuildingEvent("pit");
        }
      }

      // Also detect resolutionStatus transition even without apiStatus change
      // (market can be status:"active" but resolutionStatus:"pending")
      if (resolutionStatus === "pending" && prevResStatus !== "pending" && apiStatus === prevStatus) {
        const shortQ = existing.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
        const outcomeStr = inferOutcomeStr(apiOutcome, m.payoutPcts, existing);
        const headline = `⚠️ RESOLUTION PROPOSED: "${shortQ}" → ${outcomeStr}. Cancel orders, close losing positions.`;
        if (state.markBreaking(`proposal-${existing.id}`)) {
          state.addNews({ headline, snippet: "", source: "Resolution", category: "Markets" });
          broadcast({ type: "news_alert", headline, source: "Resolution", severity: "breaking", building: "newsroom" });
          notifyBuildingEvent("newsroom");
          notifyBuildingEvent("exchange");
          notifyBuildingEvent("pit");
        }
      }

      // Auto-cancel orders on this market if it's resolving — cancel for ALL agents
      if (apiStatus === "pending" || apiStatus === "resolved" || apiStatus === "closed" ||
          resolutionStatus === "pending" || resolutionStatus === "resolved") {
        const { cancelOrders } = await import("./trading");
        for (const agent of state.agents.values()) {
          if (agent.role === "pricer" || agent.role === "trader") {
            cancelOrders(agent.id, existing.id).catch(() => {});
          }
        }
      }

      recordSuccess();
    } catch {
      recordFailure();
    }
  }
}

/**
 * Cross-reference finished game scores with active markets.
 * Locally marks markets as resolving when the game they reference is final.
 * This fills the gap when the Context Markets API hasn't processed resolution yet.
 */
function detectGameResults(): void {
  const finishedGames = [
    ...state.liveScores.filter((g) => g.status === "post"),
    ...state.sportsSlate.filter((g) => g.status === "post"),
  ];
  if (finishedGames.length === 0) return;

  for (const market of state.getActiveMarkets()) {
    // Skip already-resolved markets
    if (market.resolutionStatus === "pending" || market.resolutionStatus === "resolved") continue;
    if (market.apiStatus === "pending" || market.apiStatus === "resolved" || market.apiStatus === "closed") continue;

    const q = market.question.toLowerCase();
    // Only match sports "Will X beat Y" markets
    if (!/beat|cover|score|win/i.test(q)) continue;

    for (const game of finishedGames) {
      // Extract team names from game and check if market references both
      const teams = [game.homeTeam, game.awayTeam].map((t) => t.toLowerCase());
      const shortParts = game.shortName.toLowerCase().split(/\s+(?:vs?\.?|@)\s+/);

      const matchesTeam = (team: string) => {
        // Check full team name or abbreviation in shortName
        return q.includes(team) || shortParts.some((p) => p.length >= 3 && q.includes(p));
      };

      if (!teams.some(matchesTeam)) continue;

      // Game is finished and matches this market — determine outcome
      const homeWon = (game.homeScore ?? 0) > (game.awayScore ?? 0);

      // Figure out which team the market is about (the subject of "Will X beat Y")
      // Check both full team names and short abbreviations from the shortName
      const homeTeamLower = game.homeTeam.toLowerCase();
      const awayTeamLower = game.awayTeam.toLowerCase();
      // shortName is like "SMU VS LOU" — extract parts as team abbreviations
      const [awayAbbr, homeAbbr] = shortParts.length >= 2
        ? [shortParts[0], shortParts[shortParts.length - 1]]
        : ["", ""];

      // Find first mention position of each team in the question
      const findFirst = (needles: string[]) => {
        let best = -1;
        for (const n of needles) {
          if (n.length < 3) continue;
          const idx = q.indexOf(n);
          if (idx >= 0 && (best === -1 || idx < best)) best = idx;
        }
        return best;
      };

      const homeIdx = findFirst([homeTeamLower, homeAbbr, ...homeTeamLower.split(/\s+/).filter(w => w.length > 3)]);
      const awayIdx = findFirst([awayTeamLower, awayAbbr, ...awayTeamLower.split(/\s+/).filter(w => w.length > 3)]);

      // The team mentioned first is typically the subject ("Will SMU beat Louisville")
      let subjectIsHome = true;
      if (homeIdx === -1 && awayIdx >= 0) subjectIsHome = false;
      else if (awayIdx === -1 && homeIdx >= 0) subjectIsHome = true;
      else if (awayIdx >= 0 && homeIdx >= 0) subjectIsHome = homeIdx < awayIdx;
      else continue; // Can't determine subject team — skip

      // For "beat"/"win" markets: YES if subject team won
      const subjectWon = subjectIsHome ? homeWon : !homeWon;
      const outcome = subjectWon ? 1 : 0; // 0=NO, 1=YES (Context Markets convention)

      // Mark as locally resolving
      market.resolutionStatus = "pending";
      market.outcome = outcome;

      const outcomeStr = outcome === 1 ? "YES" : "NO";
      const shortQ = market.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
      const scoreStr = `${game.awayScore}-${game.homeScore}`;
      const headline = `GAME OVER: ${game.shortName} final ${scoreStr}. "${shortQ}" → ${outcomeStr}. Cancel all orders.`;

      console.log(`[Sync:GameResult] ${market.id} "${shortQ}" → ${outcomeStr} (${game.shortName} ${scoreStr}, subject=${subjectIsHome ? "home" : "away"}, homeWon=${homeWon})`);

      // Fire once per game-market combo
      if (state.markBreaking(`game-result-${market.id}-${game.id}`)) {
        state.addNews({ headline, snippet: "", source: "Game Result", category: "Markets" });
        broadcast({ type: "news_alert", headline, source: "Game Result", severity: "breaking", building: "newsroom" });
        notifyBuildingEvent("newsroom");
        notifyBuildingEvent("exchange");
        notifyBuildingEvent("pit");
      }

      break; // One game per market
    }
  }
}

/**
 * Sync oracle data + quotes for tracked markets.
 * Detects oracle-vs-market divergence and emits as trading signals.
 */
async function syncOracleData(): Promise<void> {
  if (isCircuitBroken()) return;

  const client = getReadClient();
  if (!client) return;

  const markets = state.getActiveMarkets().filter((m) => m.apiMarketId);
  if (markets.length === 0) return;

  // Round-robin: process 10 markets per cycle, prioritizing those without oracle data
  const noOracle = markets.filter((m) => !m.oracleSummary);
  const stale = markets.filter((m) => m.oracleSummary && (!m.oracleUpdatedAt || Date.now() - m.oracleUpdatedAt > 120_000));
  const batch = [...noOracle, ...stale, ...markets].slice(0, 10);

  for (const market of batch) {
    // Skip if recently updated (within 60s)
    if (market.oracleUpdatedAt && Date.now() - market.oracleUpdatedAt < 60_000) continue;

    try {
      // Fetch oracle summary — qualitative reasoning only, no numeric probability
      let confidence: string | null = null;
      let summary: string | null = null;
      let decision: string | null = null;

      const oracleResult = await client.markets.oracle(market.apiMarketId!);
      const oracleData = oracleResult?.oracle;
      if (oracleData) {
        decision = oracleData.summary?.decision || null;
        summary = oracleData.summary?.shortSummary || oracleData.summary?.expandedSummary || null;
        confidence = oracleData.confidenceLevel || null;
      }

      {
        const prevSummary = market.oracleSummary;
        market.oracleProb = null;  // no longer tracking numeric probability
        market.oracleConfidence = confidence;
        market.oracleSummary = summary;
        market.oracleDivergence = null;  // no longer tracking divergence
        market.oracleUpdatedAt = Date.now();

        const shortQ = market.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);

        // Oracle updates are stored on the market object but no longer published as news.
        // Agents see oracle summaries in their market context (prompts.ts and group-chat.ts newsroom intel).
      }

      // Fetch quotes — SDK returns { yes: { bid, ask, last }, no: { bid, ask, last }, spread }
      const quotes = await client.markets.quotes(market.apiMarketId!);
      if (quotes) {
        market.bestBid = quotes.yes?.bid ?? null;
        market.bestAsk = quotes.yes?.ask ?? null;
        market.lastTradePrice = quotes.yes?.last ?? null;
      }

      // Fetch price history — SDK returns { prices: [{ time, price }] }
      try {
        const history = await client.markets.priceHistory(market.apiMarketId!, { timeframe: "1h" });
        if (history?.prices && Array.isArray(history.prices)) {
          market.priceHistory = history.prices
            .slice(-10)
            .map((p: { time: number; price: number }) => ({
              time: p.time || Date.now(),
              price: p.price || 0,
            }));
        }
      } catch {
        // Price history is optional — don't fail the whole sync
      }

      recordSuccess();
    } catch {
      recordFailure();
    }
  }
}

/**
 * Every 2 minutes, extract trending topics from recent chat + news and search
 * Context Markets for related markets. This lets agents trade on topics they're
 * already discussing (e.g. Iran, Bitcoin, elections) without waiting for news.
 */
const searchedTopics = new Set<string>(); // avoid re-searching same topics
const SEARCHED_TOPIC_TTL_MS = 10 * 60_000; // forget after 10min
let searchedTopicTimers: ReturnType<typeof setTimeout>[] = [];

async function searchChatTopics(): Promise<void> {
  if (isCircuitBroken()) return;

  const client = getReadClient();
  if (!client) return;

  // Gather text from recent chat + news
  const recentChat = state.getRecentSocialContext(15);
  const recentNews = state.getRecentNews(10);
  const allText = [
    ...recentChat.map((l) => l),
    ...recentNews.map((n) => n.headline),
  ].join(" ");

  // Extract unique searchable topics
  const topics = extractTopicsFromText(allText);
  const newTopics = topics.filter((t) => !searchedTopics.has(t));

  if (newTopics.length === 0) return;

  // Search for up to 5 new topics per cycle
  for (const topic of newTopics.slice(0, 5)) {
    searchedTopics.add(topic);
    // Auto-expire after TTL
    const timer = setTimeout(() => searchedTopics.delete(topic), SEARCHED_TOPIC_TTL_MS);
    searchedTopicTimers.push(timer);

    try {
      const result = await client.markets.search({ q: topic, limit: 5 });
      const found = result?.markets ?? [];

      let newCount = 0;
      for (const m of found) {
        if (state.getMarketByApiId(m.id)) continue;
        if (!m.status || m.status !== "active") continue;

        const question = m.question || m.shortQuestion || m.id;
        const yesPrice = m.outcomePrices?.find((op: { outcomeIndex: number }) => op.outcomeIndex === 0);
        const fairValue = yesPrice?.lastPrice ? yesPrice.lastPrice / 1_000_000 : null;

        const localId = state.addExternalMarket({
          apiMarketId: m.id,
          question,
          fairValue,
        });

        if (localId) newCount++;
      }

      if (newCount > 0) {
        console.log(`[Context Search] Topic "${topic}" → ${newCount} new markets`);
        broadcast({ type: "markets_synced", count: state.getActiveMarkets().length });
      }

      recordSuccess();
    } catch {
      recordFailure();
    }
  }
}

/**
 * Extract searchable topics from a block of text (chat + news combined).
 */
function extractTopicsFromText(text: string): string[] {
  const t = text.toLowerCase();
  const found: string[] = [];

  const topicPatterns: [RegExp, string][] = [
    [/\biran\b/, "iran"],
    [/\bbitcoin|btc\b/, "bitcoin"],
    [/\bethereum|eth\b/, "ethereum"],
    [/\bsolana\b/, "solana"],
    [/\btrump\b/, "trump"],
    [/\bbiden\b/, "biden"],
    [/\belection\b/, "election"],
    [/\bfed\b|federal reserve/, "federal reserve"],
    [/\btariff\b/, "tariff"],
    [/\brecession\b/, "recession"],
    [/\binflation\b/, "inflation"],
    [/\bnvidia\b/, "nvidia"],
    [/\btesla\b/, "tesla"],
    [/\bapple\b(?!.*sauce)/, "apple"],
    [/\bgoogle\b/, "google"],
    [/\bopenai\b|chatgpt/, "openai"],
    [/\bspacex\b/, "spacex"],
    [/\bukraine\b/, "ukraine"],
    [/\brussia\b/, "russia"],
    [/\bchina\b/, "china"],
    [/\bisrael\b/, "israel"],
    [/\bnorth korea\b/, "north korea"],
    [/\bsuper bowl\b/, "super bowl"],
    [/\bmarch madness\b|ncaa tournament/, "march madness"],
    [/\bnba playoff\b/, "nba playoffs"],
    [/\bworld cup\b/, "world cup"],
    [/\bolympic\b/, "olympics"],
    [/\bai regulation\b|ai safety/, "AI regulation"],
    [/\brate cut\b|rate hike/, "interest rates"],
    [/\bceasefire\b/, "ceasefire"],
    [/\bbank.*fail\b|banking crisis/, "banking crisis"],
  ];

  for (const [regex, topic] of topicPatterns) {
    if (regex.test(t) && !found.includes(topic)) {
      found.push(topic);
    }
  }

  return found;
}

/**
 * Search Context Markets for markets related to a news headline.
 * Called when news arrives — surfaces relevant markets for agents.
 */
const SEARCH_COOLDOWN_MS = 15_000; // Don't search more than once per 15s
let lastSearchAt = 0;

export async function searchMarketsForNews(headline: string): Promise<void> {
  if (isCircuitBroken()) return;
  if (Date.now() - lastSearchAt < SEARCH_COOLDOWN_MS) return;
  lastSearchAt = Date.now();

  const client = getReadClient();
  if (!client) return;

  // Extract 1-2 keywords from headline for search
  const keywords = extractSearchKeywords(headline);
  if (!keywords) return;

  try {
    const result = await client.markets.search({ q: keywords, limit: 5 });
    const found = result?.markets ?? [];

    let newCount = 0;
    for (const m of found) {
      if (state.getMarketByApiId(m.id)) continue;
      if (!m.status || m.status !== "active") continue;

      const question = m.question || m.shortQuestion || m.id;
      const yesPrice = m.outcomePrices?.find((op: { outcomeIndex: number }) => op.outcomeIndex === 0);
      const fairValue = yesPrice?.lastPrice ? yesPrice.lastPrice / 1_000_000 : null;

      const localId = state.addExternalMarket({
        apiMarketId: m.id,
        question,
        fairValue,
      });

      if (localId) {
        newCount++;
        // Add as news-linked market so agents see it
        state.addMarketNews(localId, `📰 Related to: ${headline.slice(0, 80)}`);
      }
    }

    if (newCount > 0) {
      console.log(`[Context Search] "${keywords}" → ${newCount} new markets from news`);
      broadcast({ type: "markets_synced", count: state.getActiveMarkets().length });
    }

    recordSuccess();
  } catch (err) {
    console.error(`[Context Search] Failed for "${keywords}":`, err);
    recordFailure();
  }
}

/**
 * Extract 1-2 meaningful search keywords from a news headline.
 * The Context Markets search API works best with simple queries.
 */
function extractSearchKeywords(headline: string): string | null {
  const h = headline.toLowerCase();

  // Known entity patterns — extract the most searchable term
  type ExtractFn = string | ((m: RegExpMatchArray) => string);
  const patterns: [RegExp, ExtractFn][] = [
    [/\b(bitcoin|btc)\b/, "bitcoin"],
    [/\b(ethereum|eth)\b/, "ethereum"],
    [/\b(solana|sol)\b/, "solana"],
    [/\b(trump)\b/, "trump"],
    [/\b(fed|federal reserve)\b/, "federal reserve"],
    [/\b(openai|chatgpt)\b/, "openai"],
    [/\b(nvidia)\b/, "nvidia"],
    [/\b(tesla)\b/, "tesla"],
    [/\b(apple)\b/, "apple"],
    [/\b(google)\b/, "google"],
    [/\b(spacex)\b/, "spacex"],
    [/\b(nba|nfl|nhl|ncaab?|mlb)\b/i, (m: RegExpMatchArray) => m[1].toUpperCase()],
    [/\b(lakers|celtics|cavaliers|knicks|warriors|clippers|rockets|nuggets|heat|bucks)\b/, (m: RegExpMatchArray) => m[1]],
    [/\b(ukraine|russia|china|iran|israel)\b/, (m: RegExpMatchArray) => m[1]],
    [/\b(tariff|trade war)\b/, "tariff"],
    [/\b(recession|inflation|rate cut|rate hike)\b/, (m: RegExpMatchArray) => m[0]],
  ];

  for (const [regex, extract] of patterns) {
    const match = h.match(regex);
    if (match) {
      return typeof extract === "function" ? extract(match) : extract;
    }
  }

  // Fallback: grab the first significant noun (skip common words)
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "will", "has", "have", "had", "been", "be", "do", "does", "did", "not", "no", "yes", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about", "into", "over", "after", "new", "says", "report", "reports", "just", "now", "today", "breaking", "update", "news"]);
  const words = headline.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w.toLowerCase()));

  if (words.length > 0) {
    return words[0]; // Single keyword works best with the API
  }

  return null;
}

/**
 * Check if the Context API circuit is healthy.
 */
export function isApiHealthy(): boolean {
  return !isCircuitBroken();
}
