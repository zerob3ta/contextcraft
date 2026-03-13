/**
 * Break Rotation System — ensures exactly 2 agents per role are on break
 * in the lounge at any time, with staggered swaps.
 */

import { state } from "../state";
import { broadcast } from "../ws-bridge";
import type { AgentRole, Building } from "../../src/game/config/agents";

interface BreakState {
  onBreak: boolean;
  breakStart: number;   // tick when break started
  breakEnd: number;     // tick when break should end
  lastBreakEndedAt: number; // tick when last break ended (for fairness)
}

const BREAK_MIN_TICKS = 8;   // ~2 min at 14s/tick
const BREAK_MAX_TICKS = 16;  // ~4 min at 14s/tick
const AGENTS_ON_BREAK_PER_ROLE: Record<AgentRole, number> = {
  creator: 2,
  pricer: 2,
  trader: 2,
  analyst: 1, // Only 2 analysts total, max 1 on break
  bartender: 0,
};

const breakStates = new Map<string, BreakState>();
let breakTickCount = 0;
let initialized = false;

/** Initialize break rotation — assign initial breaks staggered across roles */
export function initBreakRotation(): void {
  const agents = Array.from(state.agents.values());
  const roles: AgentRole[] = ["creator", "pricer", "trader", "analyst"];

  for (const role of roles) {
    const roleAgents = agents.filter((a) => a.role === role);
    const breakCount = AGENTS_ON_BREAK_PER_ROLE[role] || 0;
    if (breakCount === 0 || roleAgents.length === 0) continue;
    // Pick random agents per role to start on break
    const shuffled = roleAgents.sort(() => Math.random() - 0.5);
    const onBreak = shuffled.slice(0, breakCount);
    const working = shuffled.slice(breakCount);

    for (const agent of onBreak) {
      const duration = randomBreakDuration();
      breakStates.set(agent.id, {
        onBreak: true,
        breakStart: 0,
        breakEnd: duration,
        lastBreakEndedAt: 0,
      });
      // Move to lounge
      state.moveAgent(agent.id, "lounge");
      broadcast({ type: "agent_move", agentId: agent.id, destination: "lounge", reason: "Taking a break" });
    }

    for (const agent of working) {
      breakStates.set(agent.id, {
        onBreak: false,
        breakStart: 0,
        breakEnd: 0,
        lastBreakEndedAt: 0,
      });
    }
  }

  initialized = true;
  console.log("[Breaks] Break rotation initialized");
}

/** Called each tick — manages break expiry and replacement swaps */
export function tickBreakRotation(): void {
  if (!initialized) initBreakRotation();

  breakTickCount++;
  const roles: AgentRole[] = ["creator", "pricer", "trader", "analyst"];

  for (const role of roles) {
    const agents = Array.from(state.agents.values()).filter((a) => a.role === role);
    const roleBreaks = agents.map((a) => {
      let bs = breakStates.get(a.id);
      if (!bs) {
        bs = { onBreak: false, breakStart: 0, breakEnd: 0, lastBreakEndedAt: 0 };
        breakStates.set(a.id, bs);
      }
      return { agent: a, bs };
    });
    if (roleBreaks.length === 0) continue;

    // Check for expired breaks
    const onBreak = roleBreaks.filter((r) => r.bs?.onBreak);
    let swappedThisTick = false;

    for (const { agent, bs } of onBreak) {
      if (breakTickCount >= bs.breakEnd && !swappedThisTick) {
        // Break expired — end it
        bs.onBreak = false;
        bs.lastBreakEndedAt = breakTickCount;
        console.log(`[Breaks] ${agent.name} (${role}) break ended`);

        // Find replacement: agent who has been working longest since last break
        const working = roleBreaks
          .filter((r) => !r.bs.onBreak && r.agent.id !== agent.id)
          .sort((a, b) => a.bs.lastBreakEndedAt - b.bs.lastBreakEndedAt);

        if (working.length > 0) {
          const replacement = working[0];
          const duration = randomBreakDuration();
          replacement.bs.onBreak = true;
          replacement.bs.breakStart = breakTickCount;
          replacement.bs.breakEnd = breakTickCount + duration;

          state.moveAgent(replacement.agent.id, "lounge");
          broadcast({
            type: "agent_move",
            agentId: replacement.agent.id,
            destination: "lounge",
            reason: "Taking a break",
          });
          console.log(`[Breaks] ${replacement.agent.name} (${role}) starting break (${duration} ticks)`);
        }

        swappedThisTick = true; // Only swap ONE per role per tick
      }
    }

    // Ensure we have the right number on break (startup catch-up)
    const currentOnBreak = roleBreaks.filter((r) => r.bs?.onBreak).length;
    const targetBreakCount = AGENTS_ON_BREAK_PER_ROLE[role] || 0;
    if (currentOnBreak < targetBreakCount && !swappedThisTick) {
      const working = roleBreaks
        .filter((r) => !r.bs.onBreak)
        .sort((a, b) => a.bs.lastBreakEndedAt - b.bs.lastBreakEndedAt);

      if (working.length > 0) {
        const toBreak = working[0];
        const duration = randomBreakDuration();
        toBreak.bs.onBreak = true;
        toBreak.bs.breakStart = breakTickCount;
        toBreak.bs.breakEnd = breakTickCount + duration;

        state.moveAgent(toBreak.agent.id, "lounge");
        broadcast({
          type: "agent_move",
          agentId: toBreak.agent.id,
          destination: "lounge",
          reason: "Taking a break",
        });
        console.log(`[Breaks] ${toBreak.agent.name} (${role}) filling break slot (${duration} ticks)`);
      }
    }
  }
}

/** Check if an agent is currently on break */
export function isOnBreak(agentId: string): boolean {
  return breakStates.get(agentId)?.onBreak ?? false;
}

function randomBreakDuration(): number {
  return BREAK_MIN_TICKS + Math.floor(Math.random() * (BREAK_MAX_TICKS - BREAK_MIN_TICKS + 1));
}
