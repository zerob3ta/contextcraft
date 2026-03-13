import { config } from "dotenv";
config({ path: ".env.local" });
config(); // also load .env if present
import { startWsServer } from "./ws-bridge";
import { startPoller, stopPoller } from "./signals/poller";
import { startScheduler, stopScheduler } from "./agents/scheduler";
import { startNPCSpawner, stopNPCSpawner } from "./agents/npcs";
import { initializeWallets, resetAllAgents, stopTopupLoop } from "./context-api/setup";
import { startSync, stopSync } from "./context-api/sync";
import { startMarketPoller, stopMarketPoller } from "./context-api/markets";
import { isContextEnabled } from "./context-api/client";
import { initSleep } from "./sleep";

const WS_PORT = Number(process.env.PORT) || Number(process.env.AGENT_WS_PORT) || 8766;

console.log("╔══════════════════════════════════════╗");
console.log("║   MarketCraft Agent Server v2.0      ║");
console.log("╚══════════════════════════════════════╝");
console.log();

// Env check
const envStatus = {
  MINIMAX_API_KEY: !!process.env.MINIMAX_API_KEY,
  ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
  FIRECRAWL_API_KEY: !!process.env.FIRECRAWL_API_KEY,
  X_BEARER_TOKEN: !!process.env.X_BEARER_TOKEN,
  ODDS_API_KEY: !!process.env.ODDS_API_KEY,
  CONTEXT_API_KEY: !!process.env.CONTEXT_API_KEY,
  AGENT_MNEMONIC: !!process.env.AGENT_MNEMONIC,
};

console.log("[Config] API keys:");
for (const [key, present] of Object.entries(envStatus)) {
  console.log(`  ${present ? "✓" : "✗"} ${key}`);
}
console.log();

// 0. Initialize sleep system — agents start asleep, wake on first connection
initSleep();

// 1. Start WebSocket server
startWsServer(WS_PORT);

// 2. Start news pipeline (ESPN, crypto, firecrawl, X feeds)
startPoller();

// 3. Initialize Context Markets wallets (if configured)
if (isContextEnabled()) {
  console.log("[Context] Resetting agents + initializing wallets...");
  resetAllAgents()
    .then(() => initializeWallets())
    .then(() => {
      startSync();
      startMarketPoller();
      console.log("[Context] API integration ready");
    })
    .catch((err) => {
      console.error("[Context] Wallet initialization failed:", err);
      console.warn("[Context] Continuing without Context Markets integration");
    });
} else {
  console.warn("[Context] Skipping — no CONTEXT_API_KEY or AGENT_MNEMONIC");
}

// 4. Start agent scheduler
if (envStatus.MINIMAX_API_KEY) {
  startScheduler();
} else {
  console.warn("[Scheduler] Skipping — no MINIMAX_API_KEY");
}

// 5. Start NPC visitor spawner
startNPCSpawner();

console.log("\n[Server] All systems go. Press Ctrl+C to stop.\n");

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  stopPoller();
  stopScheduler();
  stopNPCSpawner();
  stopSync();
  stopMarketPoller();
  stopTopupLoop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopPoller();
  stopScheduler();
  stopNPCSpawner();
  stopSync();
  stopMarketPoller();
  stopTopupLoop();
  process.exit(0);
});
