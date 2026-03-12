/**
 * Social agent brain — LLM-driven chatter, movement, interaction.
 * Called by the unified scheduler for agents not on job duty.
 */

import { state } from "../state";
import { broadcast } from "../ws-bridge";
import { callMinimax, parseJsonAction } from "./brain";
import type { Building } from "../../src/game/config/agents";

const BUILDINGS: Building[] = ["newsroom", "workshop", "exchange", "pit", "lounge"];

function buildSocialPrompt(agentId: string): { system: string; user: string } {
  const agent = state.agents.get(agentId)!;
  const nearby = state.getAgentsAtLocation(agent.location)
    .filter((a) => a.id !== agentId)
    .map((a) => `${a.name} (${a.role})`);

  const socialContext = state.getRecentSocialContext(8);
  const news = state.getRecentNews(4);
  const markets = state.getActiveMarkets();

  const system = `You are ${agent.name}, a ${agent.role} in a Context Markets agent simulation called MarketCraft.

PERSONALITY: ${agent.personality}
SPECIALTY: ${agent.specialty}

You're hanging out in town between work. This is a CONVERSATION, not a monologue. Read what others said and REPLY TO THEM directly. Use their names. Agree, disagree, ask follow-up questions, crack jokes, challenge their takes.

${agent.role === "trader" ? "You love arguing about positions. If someone traded the opposite side, call them out by name." : ""}
${agent.role === "pricer" ? "You defend your prices when challenged. Push back on bad takes with data." : ""}
${agent.role === "creator" ? "You pitch market ideas in conversation. React to news angles others miss." : ""}

CRITICAL RULES:
- RESPOND to what someone specific said. Use their name. Don't just broadcast your own take.
- Do NOT repeat what others already said. If 3 people already reacted to the same news, talk about something ELSE or add a genuinely new angle.
- Keep it conversational — questions, rebuttals, banter. Not press releases.
- Under 90 chars. Punchy but complete — don't get cut off mid-sentence.

Respond with JSON:
- "message": what you say
- "destination": where to go (newsroom/workshop/exchange/pit/lounge) or null to stay

Examples:
{"message": "Sage you're crazy shorting that. Lakers are locks.", "destination": "pit"}
{"message": "Flux, 52¢? That's disrespectful to Ja.", "destination": "exchange"}
{"message": "Wait Ghost — you're BUYING that? At this price?", "destination": null}
{"message": "Anchor I agree but your spread is too wide.", "destination": "exchange"}
{"message": "Enough about Iran. Anyone watching the Pistons game?", "destination": "lounge"}`;

  const parts: string[] = [];

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  parts.push(`DATE: ${today}`);
  parts.push(`YOU ARE AT: ${agent.location}`);

  if (nearby.length > 0) {
    parts.push(`WITH YOU: ${nearby.join(", ")}`);
  } else {
    parts.push("WITH YOU: nobody (you're alone)");
  }

  if (socialContext.length > 0) {
    parts.push("\nRECENT ACTIVITY:");
    for (const line of socialContext) {
      parts.push(`  ${line}`);
    }
  }

  if (news.length > 0) {
    parts.push("\nNEWS:");
    for (const n of news.slice(0, 3)) {
      parts.push(`  ${n.headline} (${n.source})`);
    }
  }

  if (markets.length > 0) {
    parts.push("\nMARKETS:");
    for (const m of markets.slice(0, 4)) {
      const price = m.fairValue !== null ? `${Math.round(m.fairValue * 100)}¢` : "unpriced";
      const trades = m.trades.length;
      parts.push(`  "${m.question.slice(0, 70)}" — ${price}, ${trades} trades`);
    }
  }

  // Where is everyone?
  const locationMap: Record<string, string[]> = {};
  for (const a of state.agents.values()) {
    if (a.id === agentId) continue;
    if (!locationMap[a.location]) locationMap[a.location] = [];
    locationMap[a.location].push(a.name);
  }
  parts.push("\nTOWN MAP:");
  for (const loc of BUILDINGS) {
    const names = locationMap[loc] || [];
    parts.push(`  ${loc}: ${names.length > 0 ? names.join(", ") : "(empty)"}`);
  }

  parts.push("\nSay something and/or move. JSON only.");

  return { system, user: parts.join("\n") };
}

export async function runSocialAgent(agentId: string): Promise<void> {
  const agent = state.agents.get(agentId);
  if (!agent) return;

  try {
    const { system, user } = buildSocialPrompt(agentId);
    const response = await callMinimax(system, user);
    const raw = parseJsonAction(response) as { message?: string; destination?: string } | null;
    if (!raw) return;

    const message = typeof raw.message === "string" ? raw.message.trim() : null;
    const destination = typeof raw.destination === "string" && BUILDINGS.includes(raw.destination as Building)
      ? raw.destination as Building
      : null;

    // Move first
    if (destination && destination !== agent.location) {
      state.moveAgent(agentId, destination);
      broadcast({
        type: "agent_move",
        agentId,
        destination,
        reason: message?.slice(0, 70) || "Wandering",
      });
    }

    // Then speak
    if (message) {
      const emotion = message.includes("!") || message.includes("🔥") || message.includes("🚀")
        ? "excited" as const
        : message.includes("wrong") || message.includes("crazy") || message.includes("no way") || message.includes("too")
        ? "frustrated" as const
        : message.includes("hmm") || message.includes("careful") || message.includes("risky")
        ? "cautious" as const
        : "neutral" as const;

      broadcast({ type: "agent_speak", agentId, message, emotion });
      state.addSpeech(agentId, message);
      console.log(`[Social:${agent.name}] "${message}"${destination ? ` → ${destination}` : ""}`);
    }
  } catch {
    // Silent fail — social isn't critical
  }
}
