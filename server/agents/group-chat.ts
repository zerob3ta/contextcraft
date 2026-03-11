/**
 * Group Chat system — replaces paired conversations.
 * All agents chat in a shared channel. Conviction builds from chat + news,
 * triggering directives that send agents to work buildings.
 */

import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { callMinimax, parseJsonAction } from "./brain";
import type { Building } from "../../src/game/config/agents";
import type { AgentState } from "../state";

// ── Types ──

export type AgentMood = "bullish" | "bearish" | "uncertain" | "confident" | "scared" | "manic" | "neutral";

export interface ChatMessage {
  id: string;
  agentId: string;
  agentName: string;
  role: string;
  message: string;
  mood: AgentMood;
  replyTo: string | null; // message ID being replied to
  building: string; // which building this message was sent from
  timestamp: number;
}

export interface Conviction {
  marketId: string;
  marketName: string;
  direction: "bullish" | "bearish";
  strength: number; // 0-100
  updatedAt: number;
}

// ── Constants ──

const SPEAKERS_PER_TICK = 3;
const MAX_CHAT_LOG = 50;
const CONVICTION_DIRECTIVE_THRESHOLD = 60;
const CONVICTION_DECAY_PER_TICK = 3;
const MOOD_DECAY_TICKS = 15; // extreme moods decay after 15 ticks without reinforcement
const MAX_MESSAGE_LENGTH = 200;

// Where each role goes to fulfill directives
const ROLE_WORK_BUILDINGS: Record<string, Building> = {
  creator: "workshop",
  pricer: "exchange",
  trader: "pit",
};

const BUILDING_DISPLAY_NAMES: Record<string, string> = {
  lounge: "The Lounge",
  newsroom: "The Newsroom",
  workshop: "The Workshop",
  exchange: "The Exchange",
  pit: "The Trading Pit",
};

const BUILDING_CHAT_CONTEXT: Record<string, string> = {
  newsroom: "Talk about breaking news and its market implications. React to headlines.",
  workshop: "Discuss which markets should be created. Debate market design and questions.",
  exchange: "Talk about pricing, fair values, spreads. Debate whether markets are mispriced.",
  pit: "Talk about trades, positions, and market moves. Trash-talk other traders' positions.",
};

// ── State ──

let chatLog: ChatMessage[] = [];
let nextMsgId = 1;
let agentMoods: Map<string, { mood: AgentMood; since: number; ticksSinceReinforced: number }> = new Map();
let agentConvictions: Map<string, Conviction[]> = new Map();
let lastSpeakTick: Map<string, number> = new Map(); // agentId -> tick number when they last spoke
let tickCount = 0;
// Track agents that recently arrived at a building (for gossip-on-arrival)
const recentArrivals: Map<string, { from: string; to: string; tick: number }> = new Map();

// ── Public API ──

export function getChatLog(): ChatMessage[] {
  return chatLog;
}

export function getAgentMood(agentId: string): AgentMood {
  return agentMoods.get(agentId)?.mood || "neutral";
}

export function getAgentConvictions(agentId: string): Conviction[] {
  return agentConvictions.get(agentId) || [];
}

/**
 * Called each scheduler tick. Picks 3-4 agents to speak, runs them through LLM,
 * broadcasts messages, checks for conviction-driven directives.
 */
export async function runGroupChatTick(): Promise<void> {
  tickCount++;

  // Decay convictions
  for (const [agentId, convictions] of agentConvictions) {
    for (let i = convictions.length - 1; i >= 0; i--) {
      convictions[i].strength -= CONVICTION_DECAY_PER_TICK;
      if (convictions[i].strength <= 0) {
        convictions.splice(i, 1);
      }
    }
  }

  // Decay extreme moods toward neutral
  for (const [agentId, moodState] of agentMoods) {
    const extreme = ["manic", "scared", "confident"].includes(moodState.mood);
    if (extreme) {
      moodState.ticksSinceReinforced++;
      if (moodState.ticksSinceReinforced >= MOOD_DECAY_TICKS) {
        // Decay: manic -> bullish, scared -> bearish, confident -> bullish
        const decayTo: Record<string, AgentMood> = {
          manic: "bullish",
          scared: "bearish",
          confident: "bullish",
        };
        const newMood = decayTo[moodState.mood] || "neutral";
        setMood(agentId, newMood);
      }
    }
  }

  // Build available pool (not on directive, not on cooldown)
  const agents = Array.from(state.agents.values());
  const now = Date.now();
  const available = agents.filter(
    (a) => a.cooldownUntil <= now && !(a.directive && a.directiveUntil > now)
  );

  if (available.length === 0) return;

  // Magnetism: attract agents to buildings based on recent events
  updateAgentMagnetism(available);

  // Select speakers from all occupied buildings, weighted by occupancy
  const speakers = selectSpeakersAcrossBuildings(available, SPEAKERS_PER_TICK);

  // Check if we should inject a contrarian (every 4th tick)
  if (tickCount % 4 === 0 && speakers.length > 0) {
    const currentSentiment = getConsensusSentiment();
    if (currentSentiment) {
      const contrarian = available.find(
        (a: AgentState) =>
          !speakers.includes(a) &&
          getAgentMood(a.id) !== currentSentiment &&
          getAgentMood(a.id) !== "neutral"
      );
      if (contrarian) {
        // Replace last speaker with contrarian
        speakers[speakers.length - 1] = contrarian;
      }
    }
  }

  // Generate messages concurrently
  const results = await Promise.allSettled(
    speakers.map((agent) => generateMessage(agent))
  );

  // Process results
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const { agent, message, mood, replyTo, conviction } = result.value;

      // Add to chat log
      const chatMsg = addMessage(agent, message, mood, replyTo);

      // Update mood if changed
      if (mood !== getAgentMood(agent.id)) {
        const oldMood = getAgentMood(agent.id);
        setMood(agent.id, mood);
        broadcast({
          type: "mood_change",
          agentId: agent.id,
          agentName: agent.name,
          oldMood,
          newMood: mood,
          building: agent.location,
        });
      }

      // Process conviction
      if (conviction) {
        updateConviction(agent.id, conviction);
        checkDirectiveTrigger(agent);
      }

      // Broadcast chat message
      broadcast({
        type: "chat_message",
        id: chatMsg.id,
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        message: chatMsg.message,
        mood: chatMsg.mood,
        replyTo: chatMsg.replyTo,
        replyPreview: chatMsg.replyTo ? getReplyPreview(chatMsg.replyTo) : null,
        building: agent.location,
      });

      state.addSpeech(agent.id, message);
      lastSpeakTick.set(agent.id, tickCount);

      console.log(`[Chat] ${agent.name} (${mood}): "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`);
    }
  }
}

// ── Agent Magnetism ──
// Agents are attracted to buildings based on recent events and their role.
// This creates natural waves of activity: buildings light up when events happen,
// then quiet down as agents drift back to the lounge.

// Track when buildings last had notable events
const buildingEventTimestamps: Record<string, number> = {
  newsroom: 0, workshop: 0, exchange: 0, pit: 0, lounge: 0,
};

// How long an event keeps a building "hot" (attracts agents)
const MAGNETISM_DECAY_MS = 40_000; // 40s

// Track per-agent how many ticks they've been at a non-lounge building
const agentBuildingTicks: Map<string, number> = new Map();

/** Called by external systems when a notable event happens at a building */
export function notifyBuildingEvent(building: string): void {
  buildingEventTimestamps[building] = Date.now();
}

/** Role → which buildings attract them */
const ROLE_AFFINITIES: Record<string, string[]> = {
  creator: ["newsroom", "workshop"],
  pricer: ["exchange", "newsroom"],
  trader: ["pit", "exchange"],
};

function updateAgentMagnetism(available: AgentState[]): void {
  const now = Date.now();

  for (const agent of available) {
    const currentLoc = agent.location;
    const ticks = agentBuildingTicks.get(agent.id) || 0;

    // If agent is at a non-lounge building, increment their stay counter
    if (currentLoc !== "lounge") {
      agentBuildingTicks.set(agent.id, ticks + 1);

      // After 3-5 ticks at a work building, drift back to lounge
      const maxStay = 3 + Math.floor(Math.random() * 3);
      if (ticks >= maxStay) {
        const fromBuilding = agent.location;
        agentBuildingTicks.set(agent.id, 0);
        state.moveAgent(agent.id, "lounge");
        broadcast({ type: "agent_move", agentId: agent.id, destination: "lounge", reason: "Heading back" });
        // Track for gossip-on-arrival
        recentArrivals.set(agent.id, { from: fromBuilding, to: "lounge", tick: tickCount });
        continue;
      }
    }

    // If agent is in lounge, check if any hot building should attract them
    if (currentLoc === "lounge") {
      const affinities = ROLE_AFFINITIES[agent.role] || [];
      let bestBuilding: string | null = null;
      let bestScore = 0;

      for (const building of affinities) {
        const lastEvent = buildingEventTimestamps[building] || 0;
        const age = now - lastEvent;
        if (age > MAGNETISM_DECAY_MS) continue;

        // Score: fresher events = higher pull, primary affinity = higher
        const freshness = 1 - age / MAGNETISM_DECAY_MS;
        const affinityBonus = affinities.indexOf(building) === 0 ? 1.5 : 1.0;
        const score = freshness * affinityBonus;

        if (score > bestScore) {
          bestScore = score;
          bestBuilding = building;
        }
      }

      // Probability check: higher score = more likely to move
      if (bestBuilding && Math.random() < bestScore * 0.4) {
        // Don't overcrowd: max 4 agents per non-lounge building
        const atBuilding = available.filter((a) => a.location === bestBuilding).length;
        if (atBuilding < 4) {
          const fromBuilding = agent.location;
          agentBuildingTicks.set(agent.id, 0);
          state.moveAgent(agent.id, bestBuilding as Building);
          broadcast({
            type: "agent_move",
            agentId: agent.id,
            destination: bestBuilding,
            reason: getBuildingPullReason(agent.role, bestBuilding),
          });
          // Track for gossip-on-arrival
          recentArrivals.set(agent.id, { from: fromBuilding, to: bestBuilding, tick: tickCount });
        }
      }
    }
  }
}

function getBuildingPullReason(role: string, building: string): string {
  const reasons: Record<string, Record<string, string[]>> = {
    creator: {
      newsroom: ["Checking the feeds", "Something's happening", "News alert"],
      workshop: ["Drafting ideas", "New market brewing"],
    },
    pricer: {
      exchange: ["Running models", "Price check", "Updating fair values"],
      newsroom: ["Checking impact", "Data review"],
    },
    trader: {
      pit: ["Looking for trades", "Market's moving", "Opportunity spotted"],
      exchange: ["Checking prices", "Spread analysis"],
    },
  };
  const options = reasons[role]?.[building] || ["Heading over"];
  return options[Math.floor(Math.random() * options.length)];
}

// ── Cross-Building Speaker Selection ──

function selectSpeakersAcrossBuildings(pool: AgentState[], totalCount: number): AgentState[] {
  // Group available agents by building
  const byBuilding = new Map<string, AgentState[]>();
  for (const agent of pool) {
    const loc = agent.location;
    if (!byBuilding.has(loc)) byBuilding.set(loc, []);
    byBuilding.get(loc)!.push(agent);
  }

  // Allocate speaker slots proportional to occupancy, but every building with 2+ agents gets at least 1
  const speakers: AgentState[] = [];
  const buildings = Array.from(byBuilding.entries()).filter(([, agents]) => agents.length >= 2);

  if (buildings.length === 0) {
    // Fallback: just pick from wherever has agents
    const allAgents = Array.from(byBuilding.values()).flat();
    return selectSpeakers(allAgents, totalCount);
  }

  // Weight by occupancy
  const totalAgents = buildings.reduce((sum, [, agents]) => sum + agents.length, 0);
  let slotsRemaining = totalCount;

  for (const [, agents] of buildings) {
    const share = Math.max(1, Math.round((agents.length / totalAgents) * totalCount));
    const slots = Math.min(share, slotsRemaining);
    if (slots <= 0) break;

    const selected = selectSpeakers(agents, slots);
    speakers.push(...selected);
    slotsRemaining -= selected.length;
  }

  return speakers;
}

// ── Speaker Selection ──

function selectSpeakers(pool: AgentState[], count: number): AgentState[] {
  const scored = pool.map((agent) => {
    let score = 0;

    // Recency cooldown — agents who spoke recently get suppressed
    const lastSpoke = lastSpeakTick.get(agent.id) || 0;
    const ticksSinceSpoke = tickCount - lastSpoke;
    if (ticksSinceSpoke <= 1) score -= 100; // hard suppress if spoke last tick
    else if (ticksSinceSpoke <= 2) score -= 30;
    else score += Math.min(ticksSinceSpoke * 5, 30); // gradually increase

    // Mood intensity — extreme moods make agents chattier
    const mood = getAgentMood(agent.id);
    if (mood === "manic") score += 25;
    else if (mood === "scared") score += 15;
    else if (mood === "confident") score += 10;
    else if (mood === "bullish" || mood === "bearish") score += 5;

    // Topic relevance — check if recent messages touch agent's specialty
    const recentMsgs = chatLog.slice(0, 5);
    const specialtyWords = agent.specialty.toLowerCase().split(/\s+/);
    for (const msg of recentMsgs) {
      const msgLower = msg.message.toLowerCase();
      if (specialtyWords.some((w) => w.length > 3 && msgLower.includes(w))) {
        score += 15;
        break;
      }
    }

    // Personality weight — some agents are naturally louder
    const loudAgents = ["degen", "spark", "blitz", "volt"];
    const quietAgents = ["whale", "ghost", "echo", "anchor"];
    if (loudAgents.includes(agent.id)) score += 8;
    if (quietAgents.includes(agent.id)) score -= 5;

    // Noise factor
    score += Math.random() * 20 - 10;

    return { agent, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.agent);
}

function getConsensusSentiment(): AgentMood | null {
  const moods = Array.from(state.agents.values()).map((a) => getAgentMood(a.id));
  const bullish = moods.filter((m) => ["bullish", "manic", "confident"].includes(m)).length;
  const bearish = moods.filter((m) => ["bearish", "scared"].includes(m)).length;
  const total = moods.length;

  if (bullish / total > 0.6) return "bullish";
  if (bearish / total > 0.6) return "bearish";
  return null;
}

// ── Message Generation ──

interface GenerateResult {
  agent: AgentState;
  message: string;
  mood: AgentMood;
  replyTo: string | null;
  conviction: { marketId: string; marketName: string; direction: "bullish" | "bearish"; strength: number } | null;
}

async function generateMessage(agent: AgentState): Promise<GenerateResult | null> {
  // Build per-agent attention window: last 8 messages + any mentioning this agent
  const window = buildAttentionWindow(agent);
  const marketContext = buildMarketContext();
  const currentMood = getAgentMood(agent.id);

  const buildingName = BUILDING_DISPLAY_NAMES[agent.location] || agent.location;
  const buildingContext = agent.location === "lounge"
    ? "You are chatting in the Lounge — the main hangout where agents from all roles argue and discuss."
    : `You are in the ${buildingName}. ${BUILDING_CHAT_CONTEXT[agent.location] || ""}`;

  const system = `You are ${agent.name}, a ${agent.role} in a prediction market town.
PERSONALITY: ${agent.personality}
SPECIALTY: ${agent.specialty}
CURRENT MOOD: ${currentMood}
LOCATION: ${buildingName}

${buildingContext} This is a group chat — be natural, reference others by name, agree or disagree.

MOOD AFFECTS YOUR TONE:
- bullish: optimistic, forward-looking, "I like this setup"
- bearish: skeptical, contrarian, "I'm not buying it"
- uncertain: hedging, questions, "on the other hand..."
- confident: declarative, authoritative, large conviction
- scared: short cautious messages, "maybe we should wait"
- manic: intense, ALL CAPS moments, aggressive takes
- neutral: balanced, observational

RULES:
- Keep it SHORT. 1-2 sentences max. Think Twitter, not blog post.
- Be direct — make your point and stop. No preamble, no hedging filler.
- Reference markets or agents by name when relevant.
- No emojis. Casual but sharp.
- If replying to someone, include their message ID in replyTo.

Respond with JSON:
{
  "message": "your message",
  "mood": "bullish|bearish|uncertain|confident|scared|manic|neutral",
  "replyTo": "msg-id or null",
  "conviction": { "marketId": "market-1", "marketName": "short name", "direction": "bullish|bearish", "strength": 0-100 } or null
}

Only include conviction if this conversation has genuinely shifted your view on a specific market. strength 0-40 = mild opinion, 40-70 = forming a thesis, 70-100 = ready to act.`;

  const parts: string[] = [];
  if (marketContext) parts.push(marketContext);

  // Recent news
  const news = state.getRecentNews(5);
  if (news.length > 0) {
    parts.push("\nRECENT NEWS:");
    for (const n of news.slice(0, 3)) {
      const ago = Math.round((Date.now() - n.timestamp) / 60_000);
      parts.push(`- [${n.category}] ${n.headline} (${ago}min ago)`);
    }
  }

  if (window.length > 0) {
    parts.push("\nCHAT HISTORY:");
    for (const msg of window) {
      const replyPrefix = msg.replyTo ? `(replying to ${getReplyAuthor(msg.replyTo)}) ` : "";
      const bldgTag = msg.building !== agent.location ? ` [from ${BUILDING_DISPLAY_NAMES[msg.building] || msg.building}]` : "";
      parts.push(`[${msg.id}] ${msg.agentName} (${msg.mood})${bldgTag}: ${replyPrefix}"${msg.message}"`);
    }
  } else {
    parts.push("\nChat is quiet. Start a conversation about something interesting.");
  }

  // Gossip-on-arrival: if agent just moved here, suggest they bring news from where they came
  const arrival = recentArrivals.get(agent.id);
  if (arrival && arrival.tick >= tickCount - 1) {
    const fromName = BUILDING_DISPLAY_NAMES[arrival.from] || arrival.from;
    // Get recent messages from the building they came from
    const fromMsgs = chatLog
      .filter((m) => m.building === arrival.from)
      .slice(0, 3)
      .map((m) => `${m.agentName}: "${m.message}"`)
      .join(", ");
    if (fromMsgs) {
      parts.push(`\nYou just came from ${fromName}. What you heard there: ${fromMsgs}. Reference this naturally in your message.`);
    }
    // Clear so they only gossip once
    recentArrivals.delete(agent.id);
  }

  parts.push("\nJSON only.");

  try {
    const response = await callMinimax(system, parts.join("\n"));
    const raw = parseJsonAction(response) as {
      message?: string;
      mood?: string;
      replyTo?: string;
      conviction?: { marketId?: string; marketName?: string; direction?: string; strength?: number };
    } | null;

    if (!raw?.message) return null;

    const message = raw.message.trim();

    const validMoods: AgentMood[] = ["bullish", "bearish", "uncertain", "confident", "scared", "manic", "neutral"];
    const mood = validMoods.includes(raw.mood as AgentMood) ? (raw.mood as AgentMood) : currentMood;

    // Validate replyTo
    let replyTo: string | null = null;
    if (raw.replyTo && chatLog.some((m) => m.id === raw.replyTo)) {
      replyTo = raw.replyTo;
    }

    // Validate conviction
    let conviction: GenerateResult["conviction"] = null;
    if (raw.conviction?.marketId && raw.conviction?.direction && typeof raw.conviction?.strength === "number") {
      const market = state.markets.get(raw.conviction.marketId);
      if (market) {
        conviction = {
          marketId: raw.conviction.marketId,
          marketName: raw.conviction.marketName || shortMarketTitle(market.question),
          direction: raw.conviction.direction === "bearish" ? "bearish" : "bullish",
          strength: Math.max(0, Math.min(100, raw.conviction.strength)),
        };
      }
    }

    return { agent, message, mood, replyTo, conviction };
  } catch {
    return null;
  }
}

// ── Attention Window ──

function buildAttentionWindow(agent: AgentState): ChatMessage[] {
  const window: ChatMessage[] = [];
  const seen = new Set<string>();

  // Prioritize messages from the same building (last 6)
  const sameBuilding = chatLog.filter((m) => m.building === agent.location);
  for (const msg of sameBuilding.slice(0, 6)) {
    if (!seen.has(msg.id)) {
      window.push(msg);
      seen.add(msg.id);
    }
  }

  // Also include recent messages from other buildings (last 3, for cross-pollination)
  for (const msg of chatLog.slice(0, 15)) {
    if (!seen.has(msg.id) && msg.building !== agent.location) {
      window.push(msg);
      seen.add(msg.id);
      if (window.length >= 9) break;
    }
  }

  // Any messages mentioning this agent (scan last 20)
  const nameLower = agent.name.toLowerCase();
  for (const msg of chatLog.slice(0, 20)) {
    if (!seen.has(msg.id) && msg.message.toLowerCase().includes(nameLower)) {
      window.push(msg);
      seen.add(msg.id);
    }
  }

  // Sort chronologically (oldest first)
  window.sort((a, b) => a.timestamp - b.timestamp);
  return window;
}

// ── Helpers ──

function addMessage(agent: AgentState, message: string, mood: AgentMood, replyTo: string | null): ChatMessage {
  const msg: ChatMessage = {
    id: `msg-${nextMsgId++}`,
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    message,
    mood,
    replyTo,
    building: agent.location,
    timestamp: Date.now(),
  };
  chatLog.unshift(msg);
  if (chatLog.length > MAX_CHAT_LOG) chatLog.length = MAX_CHAT_LOG;
  return msg;
}

function setMood(agentId: string, mood: AgentMood): void {
  agentMoods.set(agentId, { mood, since: Date.now(), ticksSinceReinforced: 0 });
}

function updateConviction(agentId: string, conv: { marketId: string; marketName: string; direction: "bullish" | "bearish"; strength: number }): void {
  if (!agentConvictions.has(agentId)) {
    agentConvictions.set(agentId, []);
  }
  const list = agentConvictions.get(agentId)!;
  const existing = list.find((c) => c.marketId === conv.marketId);
  if (existing) {
    // Blend: move toward new direction, accumulate strength
    if (existing.direction === conv.direction) {
      existing.strength = Math.min(100, existing.strength + conv.strength * 0.5);
    } else {
      existing.strength -= conv.strength * 0.3;
      if (existing.strength <= 0) {
        existing.direction = conv.direction;
        existing.strength = conv.strength * 0.3;
      }
    }
    existing.updatedAt = Date.now();
  } else {
    list.push({ ...conv, updatedAt: Date.now() });
  }
}

function checkDirectiveTrigger(agent: AgentState): void {
  // Don't trigger if already on a directive
  if (agent.directive && agent.directiveUntil > Date.now()) return;

  const convictions = agentConvictions.get(agent.id) || [];
  const strong = convictions.find((c) => c.strength >= CONVICTION_DIRECTIVE_THRESHOLD);
  if (!strong) return;

  // Probability check: 60 = 30%, 80 = 70%, 95+ = 100%
  const probability = strong.strength >= 95 ? 1 : strong.strength >= 80 ? 0.7 : 0.3;
  if (Math.random() > probability) return;

  // Generate directive based on role
  let directive: string;
  const workBuilding = ROLE_WORK_BUILDINGS[agent.role];

  switch (agent.role) {
    case "pricer":
      directive = `Repricing ${strong.marketName} ${strong.direction === "bullish" ? "higher" : "lower"}`;
      break;
    case "trader":
      directive = `Going ${strong.direction === "bullish" ? "long" : "short"} on ${strong.marketName}`;
      break;
    case "creator":
      directive = `Creating a market about ${strong.marketName}`;
      break;
    default:
      return;
  }

  // Set directive on agent
  agent.directive = directive;
  agent.directiveUntil = Date.now() + 30_000;

  // Move to work building
  if (agent.location !== workBuilding) {
    state.moveAgent(agent.id, workBuilding);
    broadcast({
      type: "agent_move",
      agentId: agent.id,
      destination: workBuilding,
      reason: directive.slice(0, 40),
    });
  }

  // Broadcast directive
  broadcast({
    type: "agent_directive",
    agentId: agent.id,
    directive,
  });

  // Broadcast the directive declaration as a chat event too
  broadcast({
    type: "chat_directive",
    agentId: agent.id,
    agentName: agent.name,
    directive,
    destination: workBuilding,
    building: agent.location,
  });

  // Reset conviction
  const list = agentConvictions.get(agent.id) || [];
  const idx = list.findIndex((c) => c.marketId === strong.marketId);
  if (idx >= 0) list.splice(idx, 1);

  state.setAgentCooldown(agent.id, 15_000);

  console.log(`[Chat] ${agent.name} DIRECTIVE: ${directive} → ${workBuilding}`);
}

function buildMarketContext(): string {
  const markets = state.getActiveMarkets();
  if (markets.length === 0) return "";
  const lines = markets.slice(0, 5).map((m) => {
    const price = m.fairValue !== null ? `${Math.round(m.fairValue * 100)}c` : "unpriced";
    const title = shortMarketTitle(m.question);
    return `[${m.id}] "${title}" (${price})`;
  });
  return `ACTIVE MARKETS: ${lines.join(" | ")}`;
}

function shortMarketTitle(question: string): string {
  let q = question.replace(/^Will\s+/i, "").replace(/\?$/, "");
  if (q.length > 35) q = q.slice(0, 33) + "..";
  return q;
}

function getReplyPreview(msgId: string): string | null {
  const msg = chatLog.find((m) => m.id === msgId);
  if (!msg) return null;
  const preview = msg.message.length > 50 ? msg.message.slice(0, 47) + "..." : msg.message;
  return `${msg.agentName}: ${preview}`;
}

function getReplyAuthor(msgId: string): string {
  const msg = chatLog.find((m) => m.id === msgId);
  return msg?.agentName || "someone";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
