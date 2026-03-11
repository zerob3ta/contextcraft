/**
 * Background sync: balances, positions, and market discovery.
 * Runs periodically to keep local state in sync with Context Markets.
 */

import { getAgentClient, getReadClient } from "./client";
import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { ALL_AGENTS } from "../../src/game/config/agents";

const BALANCE_SYNC_INTERVAL_MS = 30_000; // 30s
const MARKET_SYNC_INTERVAL_MS = 60_000; // 60s

let balanceSyncTimer: ReturnType<typeof setInterval> | null = null;
let marketSyncTimer: ReturnType<typeof setInterval> | null = null;

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

  balanceSyncTimer = setInterval(syncBalances, BALANCE_SYNC_INTERVAL_MS);
  marketSyncTimer = setInterval(syncMarkets, MARKET_SYNC_INTERVAL_MS);
}

export function stopSync(): void {
  if (balanceSyncTimer) { clearInterval(balanceSyncTimer); balanceSyncTimer = null; }
  if (marketSyncTimer) { clearInterval(marketSyncTimer); marketSyncTimer = null; }
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
    const result = await client.markets.list({ status: "active", limit: 50 });
    const apiMarkets = result?.markets ?? [];

    let newCount = 0;
    for (const m of apiMarkets) {
      // Skip if we already track this market
      if (state.getMarketByApiId(m.id)) continue;

      // Add as external market
      const question = m.question || m.shortQuestion || m.id;
      // Extract yes price from outcome prices if available
      const yesPrice = m.outcomePrices?.find((op) => op.outcomeIndex === 1);
      // lastPrice is in raw units (e.g. 615000 = 61.5¢), divide by 10000 to get probability 0-1
      const fairValue = yesPrice?.lastPrice ? yesPrice.lastPrice / 10000 : null;

      const localId = state.addExternalMarket({
        apiMarketId: m.id,
        question,
        fairValue,
      });

      if (localId) newCount++;
    }

    if (newCount > 0) {
      console.log(`[Context Sync] Discovered ${newCount} new markets from testnet`);
      // Broadcast market list update
      broadcast({
        type: "markets_synced",
        count: state.getActiveMarkets().length,
      });
    }

    recordSuccess();
  } catch (err) {
    console.error("[Context Sync] Market sync failed:", err);
    recordFailure();
  }
}

/**
 * Check if the Context API circuit is healthy.
 */
export function isApiHealthy(): boolean {
  return !isCircuitBroken();
}
