import { WebSocketServer, WebSocket } from "ws";

export type GameEvent =
  | { type: "agent_move"; agentId: string; destination: string; reason: string }
  | { type: "agent_speak"; agentId: string; message: string; emotion: string }
  | { type: "market_spawning"; marketId: string; question: string; creator: string }
  | { type: "price_update"; marketId: string; fairValue: number; spread: number }
  | { type: "trade_executed"; agentId: string; marketId: string; side: "YES" | "NO"; size: number; price: number }
  | { type: "news_alert"; headline: string; source: string; severity: "breaking" | "normal" };

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
