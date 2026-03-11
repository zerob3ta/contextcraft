/**
 * Async market creation via Context Markets agent-submit endpoint.
 * Non-blocking: submits in one tick, polls in background, finalizes later.
 */

import { contextApiFetch, getReadClient } from "./client";
import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { notifyBuildingEvent } from "../agents/group-chat";
import { isApiHealthy } from "./sync";
import type {
  AgentMarketDraft,
  AgentSubmitResponse,
  SubmissionPollResponse,
  PendingMarketCreation,
} from "./types";

// ── Rate limits ──

const DAILY_LIMIT = Number(process.env.DAILY_MARKET_LIMIT) || 20;
const MIN_SUBMIT_INTERVAL_MS = 5_000; // 5s between submissions
let lastSubmitTime = 0;

// Track daily successful creations (resets at midnight UTC)
let marketsCreatedToday = 0;
let lastResetDate = new Date().toISOString().split("T")[0];

function checkDailyReset(): void {
  const today = new Date().toISOString().split("T")[0];
  if (today !== lastResetDate) {
    marketsCreatedToday = 0;
    lastResetDate = today;
    console.log("[Context Markets] Daily creation counter reset");
  }
}

export function getMarketsCreatedToday(): number {
  checkDailyReset();
  return marketsCreatedToday;
}

export function canCreateMarket(): boolean {
  checkDailyReset();
  return marketsCreatedToday < (DAILY_LIMIT - 2) && isApiHealthy(); // buffer of 2
}

// ── Pending creation queue ──

const pendingCreations: PendingMarketCreation[] = [];
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_DURATION_MS = 180_000; // 3 min timeout
const MAX_RETRIES = 1; // one retry with revised question
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Submit a market draft to Context API. Non-blocking — adds to pending queue.
 * Returns the submission ID or null if rate-limited/failed.
 */
export async function submitMarket(
  agentId: string,
  draft: AgentMarketDraft,
  questionForDisplay: string,
): Promise<string | null> {
  if (!canCreateMarket()) {
    console.log(`[Context Markets] Daily limit reached (${marketsCreatedToday}/${DAILY_LIMIT})`);
    return null;
  }

  // Rate limit between submissions
  const now = Date.now();
  if (now - lastSubmitTime < MIN_SUBMIT_INTERVAL_MS) {
    const wait = MIN_SUBMIT_INTERVAL_MS - (now - lastSubmitTime);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastSubmitTime = Date.now();

  try {
    const { status, data } = await contextApiFetch<AgentSubmitResponse>(
      "/questions/agent-submit",
      {
        method: "POST",
        body: JSON.stringify({ market: draft }),
      },
    );

    if (status !== 200 && status !== 202) {
      console.error(`[Context Markets] agent-submit failed (${status}):`, JSON.stringify(data).slice(0, 200));
      return null;
    }

    console.log(`[Context Markets] Submitted: ${questionForDisplay.slice(0, 60)} (${data.submissionId})`);

    // Track pending creation
    pendingCreations.push({
      submissionId: data.submissionId,
      agentId,
      question: questionForDisplay,
      submittedAt: Date.now(),
      retryCount: 0,
      lastPollAt: 0,
    });

    return data.submissionId;
  } catch (err) {
    console.error("[Context Markets] Submit error:", err);
    return null;
  }
}

/**
 * Start the background poller that checks pending market creations.
 */
export function startMarketPoller(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollPendingCreations, POLL_INTERVAL_MS);
  console.log("[Context Markets] Background creation poller started");
}

export function stopMarketPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollPendingCreations(): Promise<void> {
  const now = Date.now();
  const expired: number[] = [];

  for (let i = 0; i < pendingCreations.length; i++) {
    const pending = pendingCreations[i];

    // Timeout check
    if (now - pending.submittedAt > MAX_POLL_DURATION_MS) {
      console.log(`[Context Markets] Submission ${pending.submissionId} timed out`);
      expired.push(i);
      broadcastCreationFailed(pending.agentId, pending.question, "Submission timed out");
      continue;
    }

    // Don't poll too frequently
    if (now - pending.lastPollAt < POLL_INTERVAL_MS) continue;
    // Mark as polling to prevent duplicate processing
    if ((pending as Record<string, unknown>)._processing) continue;
    pending.lastPollAt = now;

    try {
      const { data } = await contextApiFetch<SubmissionPollResponse>(
        `/questions/submissions/${pending.submissionId}`,
      );

      if (!data) continue;

      // Check for rejection
      const pollAny = data as unknown as Record<string, unknown>;
      if (pollAny.refuseToResolve) {
        const reason = String(pollAny.rejectionReason || pollAny.qualityExplanation || "Unknown rejection");
        console.log(`[Context Markets] Rejected: ${pending.question.slice(0, 60)} — ${reason}`);
        expired.push(i);

        // Broadcast rejection with reason so LLM can learn
        broadcastCreationRejected(pending.agentId, pending.question, reason);
        continue;
      }

      // Check for completion
      const status = data.status;
      if (status === "failed") {
        expired.push(i);
        broadcastCreationFailed(pending.agentId, pending.question, "Submission failed");
        continue;
      }

      if (status === "complete" || status === "completed" || status === "created") {
        // Prevent duplicate processing
        (pending as Record<string, unknown>)._processing = true;

        // If market already created
        if (data.market?.marketId) {
          expired.push(i);
          await finalizeMarketCreation(pending, data.market.marketId, data.market.url);
          continue;
        }

        // Need to call /markets/create with questionId
        if (data.questions && data.questions.length > 0) {
          const q = data.questions[0];
          const questionId = q.questionId || (q as Record<string, string>).id;

          if (questionId) {
            try {
              const client = getReadClient();
              if (client) {
                const created = await client.markets.create(questionId);
                expired.push(i);
                await finalizeMarketCreation(pending, created.marketId, (created as Record<string, unknown>).url as string | undefined);
              }
            } catch (createErr) {
              console.error(`[Context Markets] /markets/create failed for ${questionId}:`, createErr);
              expired.push(i);
              broadcastCreationFailed(pending.agentId, pending.question, "Market deployment failed");
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Context Markets] Poll error for ${pending.submissionId}:`, err);
    }
  }

  // Remove expired entries (reverse order to preserve indices)
  for (const idx of expired.reverse()) {
    pendingCreations.splice(idx, 1);
  }
}

async function finalizeMarketCreation(
  pending: PendingMarketCreation,
  apiMarketId: string,
  url?: string,
): Promise<void> {
  marketsCreatedToday++;
  console.log(`[Context Markets] Created! ${pending.question.slice(0, 60)} → ${apiMarketId} (${marketsCreatedToday}/${DAILY_LIMIT} today)`);

  // Add to local state with dual IDs
  const market = state.createMarketWithApiId(pending.question, pending.agentId, apiMarketId);

  broadcast({
    type: "market_spawning",
    marketId: market.id,
    question: market.question,
    creator: pending.agentId,
    building: "workshop",
    apiMarketId,
    url,
  });

  notifyBuildingEvent("workshop");
  notifyBuildingEvent("exchange");

  state.addAction(pending.agentId, "created market", pending.question.slice(0, 60));
}

function broadcastCreationRejected(agentId: string, question: string, reason: string): void {
  // Store rejection reason so the LLM can learn from it in the next prompt
  state.addRejection(agentId, question, reason);

  broadcast({
    type: "market_rejected",
    agentId,
    question: question.slice(0, 80),
    reason: reason.slice(0, 200),
    building: "workshop",
  });
}

function broadcastCreationFailed(agentId: string, question: string, reason: string): void {
  broadcast({
    type: "market_failed",
    agentId,
    question: question.slice(0, 80),
    reason,
    building: "workshop",
  });
}
