import { config } from "dotenv";
config({ path: ".env.local" });
config(); // also load .env if present
import { startWsServer } from "./ws-bridge";
import { startPoller, stopPoller } from "./signals/poller";
import { startScheduler, stopScheduler } from "./agents/scheduler";

const WS_PORT = Number(process.env.PORT) || Number(process.env.AGENT_WS_PORT) || 8766;

console.log("╔══════════════════════════════════════╗");
console.log("║   ContextCraft Agent Server v2.0     ║");
console.log("╚══════════════════════════════════════╝");
console.log();

// Env check
const envStatus = {
  MINIMAX_API_KEY: !!process.env.MINIMAX_API_KEY,
  ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
  FIRECRAWL_API_KEY: !!process.env.FIRECRAWL_API_KEY,
  X_BEARER_TOKEN: !!process.env.X_BEARER_TOKEN,
  ODDS_API_KEY: !!process.env.ODDS_API_KEY,
};

console.log("[Config] API keys:");
for (const [key, present] of Object.entries(envStatus)) {
  console.log(`  ${present ? "✓" : "✗"} ${key}`);
}
console.log();

// 1. Start WebSocket server
startWsServer(WS_PORT);

// 2. Start news pipeline (ESPN, crypto, firecrawl, X feeds)
startPoller();

// 3. Start agent scheduler
if (envStatus.MINIMAX_API_KEY) {
  startScheduler();
} else {
  console.warn("[Scheduler] Skipping — no MINIMAX_API_KEY");
}

console.log("\n[Server] All systems go. Press Ctrl+C to stop.\n");

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  stopPoller();
  stopScheduler();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopPoller();
  stopScheduler();
  process.exit(0);
});
