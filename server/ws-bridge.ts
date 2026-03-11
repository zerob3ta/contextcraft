import { WebSocketServer, WebSocket } from "ws";

export type AgentMood = "bullish" | "bearish" | "uncertain" | "confident" | "scared" | "manic" | "neutral";

export type GameEvent =
  | { type: "agent_move"; agentId: string; destination: string; reason: string }
  | { type: "agent_speak"; agentId: string; message: string; emotion: string; building?: string }
  | { type: "market_spawning"; marketId: string; question: string; creator: string; building?: string; apiMarketId?: string; url?: string }
  | { type: "price_update"; marketId: string; fairValue: number; spread: number; building?: string }
  | { type: "trade_executed"; agentId: string; marketId: string; side: "YES" | "NO"; size: number; price: number; building?: string }
  | { type: "news_alert"; headline: string; source: string; severity: "breaking" | "normal"; building?: string }
  | { type: "chat_message"; id: string; agentId: string; agentName: string; role: string; message: string; mood: AgentMood; replyTo: string | null; replyPreview: string | null; building?: string }
  | { type: "chat_directive"; agentId: string; agentName: string; directive: string; destination: string; building?: string }
  | { type: "mood_change"; agentId: string; agentName: string; oldMood: AgentMood; newMood: AgentMood; building?: string }
  | { type: "building_selected"; buildingId: string }
  | { type: "agent_directive"; agentId: string; directive: string }
  | { type: "directive_fulfilled"; agentId: string; agentName: string; directive: string; result: string; building?: string }
  // Context Markets integration events
  | { type: "market_rejected"; agentId: string; question: string; reason: string; building?: string }
  | { type: "market_failed"; agentId: string; question: string; reason: string; building?: string }
  | { type: "markets_synced"; count: number };

let wss: WebSocketServer | null = null;

export function startWsServer(port: number): WebSocketServer {
  wss = new WebSocketServer({ port, host: "0.0.0.0" });

  wss.on("connection", (ws) => {
    console.log(`[WS] Client connected (total: ${wss!.clients.size})`);

    // Send welcome event (normal severity so it doesn't trigger breaking banner)
    const welcome: GameEvent = {
      type: "news_alert",
      headline: "Agent server connected — live mode active",
      source: "System",
      severity: "normal",
    };
    ws.send(JSON.stringify(welcome));

    ws.on("close", () => {
      console.log(`[WS] Client disconnected (total: ${wss!.clients.size})`);
    });
  });

  console.log(`[WS] Server listening on ws://localhost:${port}`);
  return wss;
}

export function broadcast(event: GameEvent): void {
  if (!wss) return;
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

export function getWss(): WebSocketServer | null {
  return wss;
}
