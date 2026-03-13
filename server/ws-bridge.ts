import { WebSocketServer, WebSocket } from "ws";
import { notifyConnect, notifyDisconnect } from "./sleep";
import { state } from "./state";

export type AgentMood = "bullish" | "bearish" | "uncertain" | "confident" | "scared" | "manic" | "neutral";

export type GameEvent =
  | { type: "agent_move"; agentId: string; destination: string; reason: string }
  | { type: "agent_speak"; agentId: string; message: string; emotion: string; building?: string }
  | { type: "market_spawning"; marketId: string; question: string; creator: string; building?: string; apiMarketId?: string; url?: string }
  | { type: "price_update"; marketId: string; fairValue: number; spread: number; building?: string }
  | { type: "trade_executed"; agentId: string; marketId: string; side: "YES" | "NO"; size: number; price: number; building?: string; question?: string; tradeType?: "order" | "execution" | "cancel"; direction?: "buy" | "sell" }
  | { type: "news_alert"; headline: string; source: string; severity: "breaking" | "normal"; building?: string }
  | { type: "chat_message"; id: string; agentId: string; agentName: string; role: string; message: string; mood: AgentMood; replyTo: string | null; replyPreview: string | null; building?: string }
  | { type: "chat_directive"; agentId: string; agentName: string; directive: string; destination: string; building?: string }
  | { type: "mood_change"; agentId: string; agentName: string; oldMood: AgentMood; newMood: AgentMood; building?: string }
  | { type: "building_selected"; buildingId: string }
  | { type: "agent_directive"; agentId: string; directive: string }
  | { type: "directive_fulfilled"; agentId: string; agentName: string; directive: string; result: string; building?: string }
  // NPC visitor events
  | { type: "npc_spawn"; agentId: string; name: string; color: string; accentColor: string; personality: string; backstory: string; spriteFeatures: { hat?: string; glasses?: boolean; size: "small" | "medium" | "large"; hairStyle?: string } }
  | { type: "npc_despawn"; agentId: string }
  // Context Markets integration events
  | { type: "market_pending"; agentId: string; question: string; building?: string }
  | { type: "market_rejected"; agentId: string; question: string; reason: string; building?: string }
  | { type: "market_failed"; agentId: string; question: string; reason: string; building?: string }
  | { type: "markets_synced"; count: number }
  | { type: "board_sync"; count: number; stats: { total: number; analyzed: number; priced: number; traded: number } }
  | { type: "briefing_updated"; count: number; categories: string[] }
  // Analyst report events
  | { type: "analyst_report"; agentId: string; agentName: string; marketId: string; question: string; probability: number; confidence: string; summary: string; building?: string };

let wss: WebSocketServer | null = null;

export function startWsServer(port: number): WebSocketServer {
  wss = new WebSocketServer({ port, host: "0.0.0.0" });

  wss.on("connection", (ws) => {
    const count = wss!.clients.size;
    console.log(`[WS] Client connected (total: ${count})`);
    notifyConnect(count);

    // Send welcome event (normal severity so it doesn't trigger breaking banner)
    const welcome: GameEvent = {
      type: "news_alert",
      headline: "Agent server connected — live mode active",
      source: "System",
      severity: "normal",
    };
    ws.send(JSON.stringify(welcome));

    // Send board snapshot — full market list with coverage status
    const board = state.getBigBoard();
    const boardStats = state.getBoardStats();
    const shorten = (q: string) => q.replace(/^Will\s+/i, "").replace(/\?$/, "");
    const boardSnapshot = {
      type: "board_snapshot",
      markets: board.map((m) => ({
        id: m.id,
        question: shorten(m.question),
        fairValue: m.fairValue,
        hasAnalystOdds: !!m.analystOdds,
        hasQuotes: m.bestBid !== null && m.bestAsk !== null,
        hasTrades: m.trades.length > 0,
        apiStatus: m.apiStatus,
      })),
      stats: boardStats,
    };
    ws.send(JSON.stringify(boardSnapshot));

    ws.on("close", () => {
      const remaining = wss!.clients.size;
      console.log(`[WS] Client disconnected (total: ${remaining})`);
      notifyDisconnect(remaining);
    });
  });

  console.log(`[WS] Server listening on ws://localhost:${port}`);
  return wss;
}

/** Strip internal market IDs (M1, M14, etc.) from user-visible text fields */
function sanitizeMarketIds(event: GameEvent): GameEvent {
  const strip = (s: string) => s.replace(/\bM\d+\b/g, "").replace(/\s{2,}/g, " ").trim();
  switch (event.type) {
    case "chat_message":
      return { ...event, message: strip(event.message) };
    case "agent_speak":
      return { ...event, message: strip(event.message) };
    case "chat_directive":
      return { ...event, directive: strip(event.directive) };
    case "directive_fulfilled":
      return { ...event, result: strip(event.result), directive: strip(event.directive) };
    default:
      return event;
  }
}

export function broadcast(event: GameEvent): void {
  if (!wss) return;
  const msg = JSON.stringify(sanitizeMarketIds(event));
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

export function getWss(): WebSocketServer | null {
  return wss;
}
