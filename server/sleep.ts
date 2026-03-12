/**
 * Sleep/wake system — agents sleep when nobody's watching.
 *
 * SLEEP: When all WebSocket connections close, agents go to sleep after a short grace period.
 * WAKE: When any connection opens, all agents wake up with a scramble phase.
 *
 * During sleep: scheduler and group chat stop ticking. Pollers (news, scores, prices) keep running
 * so state is fresh when agents wake up.
 */

import { broadcast } from "./ws-bridge";
import { state } from "./state";

// ── Config ──

const SLEEP_GRACE_MS = 5 * 60_000;    // 5min grace after last disconnect before sleeping
const SCRAMBLE_DURATION_MS = 30_000;  // 30s scramble phase on wake

// ── State ──

let isAwake = false;
let sleepGraceTimer: ReturnType<typeof setTimeout> | null = null;
let lastWakeAt = 0;
let scrambleUntil = 0;

// Callbacks
let onWakeCallback: (() => void) | null = null;
let onSleepCallback: (() => void) | null = null;

export function onWake(cb: () => void): void { onWakeCallback = cb; }
export function onSleep(cb: () => void): void { onSleepCallback = cb; }

export function isAgentAwake(): boolean {
  return isAwake;
}

export function isScramblePhase(): boolean {
  return Date.now() < scrambleUntil;
}

export function getAwakeDuration(): number {
  return isAwake ? Date.now() - lastWakeAt : 0;
}

/**
 * Called by ws-bridge when a client connects.
 * Any connection wakes all agents.
 */
export function notifyConnect(clientCount: number): void {
  // Cancel any pending sleep
  if (sleepGraceTimer) {
    clearTimeout(sleepGraceTimer);
    sleepGraceTimer = null;
  }

  if (!isAwake) {
    wake();
  }
}

/**
 * Called by ws-bridge when a client disconnects.
 * Only sleep if ALL connections are gone.
 */
export function notifyDisconnect(clientCount: number): void {
  if (clientCount === 0) {
    // Start grace period — sleep if no one reconnects
    if (sleepGraceTimer) clearTimeout(sleepGraceTimer);
    sleepGraceTimer = setTimeout(() => {
      sleepGraceTimer = null;
      sleep("all clients disconnected");
    }, SLEEP_GRACE_MS);
  }
}

function wake(): void {
  isAwake = true;
  lastWakeAt = Date.now();
  scrambleUntil = Date.now() + SCRAMBLE_DURATION_MS;

  console.log("[Sleep] ☀️ WAKING UP — agents scrambling to check positions...");

  // Broadcast wake event to frontend
  broadcast({
    type: "news_alert",
    headline: "Agents waking up — scrambling to check markets and positions",
    source: "System",
    severity: "normal",
  });

  // Set directives for all pricers/traders to review their book immediately
  for (const agent of state.agents.values()) {
    if (agent.role === "pricer" || agent.role === "trader") {
      agent.directive = "WAKE UP: Review ALL your positions and open orders immediately. Markets may have moved while you were asleep. Reprice stale orders, sell losing positions, cancel orders on resolved markets.";
      agent.directiveUntil = Date.now() + SCRAMBLE_DURATION_MS;
      // Clear cooldowns so they can act immediately
      agent.cooldownUntil = 0;
    }
  }

  if (onWakeCallback) onWakeCallback();
}

function sleep(reason: string): void {
  if (!isAwake) return;

  isAwake = false;
  scrambleUntil = 0;

  const awakeMins = Math.round((Date.now() - lastWakeAt) / 60_000);
  console.log(`[Sleep] 😴 SLEEPING — ${reason} (was awake ${awakeMins}min)`);

  broadcast({
    type: "news_alert",
    headline: `Agents going to sleep — ${reason}`,
    source: "System",
    severity: "normal",
  });

  if (onSleepCallback) onSleepCallback();
}

/**
 * Force wake (e.g., for manual override or API trigger).
 */
export function forceWake(): void {
  if (!isAwake) wake();
}

/**
 * Initialize — start asleep, wake on first connection.
 */
export function initSleep(): void {
  isAwake = false;
  console.log("[Sleep] Initialized — agents sleeping until a client connects");
}
