import type { Building, Emotion, AgentRole } from "../../src/game/config/agents";

export type ResearchSource = "sports" | "web" | "x" | "url";

export type AgentAction =
  | { action: "move"; destination: Building; reason: string }
  | { action: "speak"; message: string; emotion: Emotion }
  | { action: "create_market"; topic: string }
  | { action: "post_price"; marketId: string; fairValue: number; spread: number }
  | { action: "trade"; marketId: string; side: "YES" | "NO"; size: number; direction: "buy" | "sell" }
  | { action: "cancel_orders"; marketId: string }
  | { action: "research"; query: string; source: ResearchSource }
  | { action: "idle" };

const VALID_BUILDINGS: Set<string> = new Set(["newsroom", "workshop", "exchange", "pit", "lounge"]);
const VALID_EMOTIONS: Set<string> = new Set(["excited", "cautious", "neutral", "frustrated"]);

/**
 * Validate and clamp an agent action. Returns idle for invalid actions.
 */
export function validateAction(raw: unknown, role: AgentRole): AgentAction {
  if (!raw || typeof raw !== "object") return { action: "idle" };

  const obj = raw as Record<string, unknown>;

  switch (obj.action) {
    case "move": {
      const dest = String(obj.destination || "");
      if (!VALID_BUILDINGS.has(dest)) return { action: "idle" };
      return {
        action: "move",
        destination: dest as Building,
        reason: String(obj.reason || "").slice(0, 100),
      };
    }

    case "speak": {
      const msg = String(obj.message || "").slice(0, 200);
      if (!msg) return { action: "idle" };
      const emotion = VALID_EMOTIONS.has(String(obj.emotion)) ? String(obj.emotion) as Emotion : "neutral";
      return { action: "speak", message: msg, emotion };
    }

    case "create_market": {
      if (role !== "creator") return { action: "idle" };
      const topic = String(obj.topic || "").slice(0, 300);
      if (!topic) return { action: "idle" };
      return { action: "create_market", topic };
    }

    case "post_price": {
      if (role !== "pricer") return { action: "idle" };
      const marketId = String(obj.marketId || "");
      const fairValue = Math.max(0.01, Math.min(0.99, Number(obj.fairValue) || 0.5));
      const spread = Math.max(0.02, Math.min(0.15, Number(obj.spread) || 0.05));
      if (!marketId) return { action: "idle" };
      return { action: "post_price", marketId, fairValue, spread };
    }

    case "trade": {
      if (role !== "trader") return { action: "idle" };
      const marketId = String(obj.marketId || "");
      const side = obj.side === "NO" ? "NO" : "YES";
      const size = Math.max(1, Math.min(10000, Math.round(Number(obj.size) || 100)));
      const direction = obj.direction === "sell" ? "sell" : "buy";
      if (!marketId) return { action: "idle" };
      return { action: "trade", marketId, side, size, direction };
    }

    case "cancel_orders": {
      if (role !== "trader" && role !== "pricer") return { action: "idle" };
      const marketId = String(obj.marketId || "");
      if (!marketId) return { action: "idle" };
      return { action: "cancel_orders", marketId };
    }

    case "research": {
      const query = String(obj.query || "").slice(0, 200);
      if (!query) return { action: "idle" };
      const validSources: Set<string> = new Set(["sports", "web", "x", "url"]);
      const source = validSources.has(String(obj.source)) ? String(obj.source) as ResearchSource : "web";
      return { action: "research", query, source };
    }

    case "idle":
      return { action: "idle" };

    default:
      return { action: "idle" };
  }
}

/** Clamp trade sizes per trader personality */
export function clampTradeSize(agentId: string, size: number): number {
  const limits: Record<string, [number, number]> = {
    degen: [200, 1000],
    sage: [50, 200],
    blitz: [20, 100],
    whale: [500, 5000],
    ghost: [100, 1000],
  };
  const [min, max] = limits[agentId] || [50, 500];
  return Math.max(min, Math.min(max, size));
}
