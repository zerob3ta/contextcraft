"use client";

import { useEffect, useRef } from "react";
import type { PhaserGameHandle } from "../game/PhaserGame";
import { gameEventBus } from "../lib/gameEventBus";
import type { GameEvent } from "../game/config/events";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8766";
const WS_RECONNECT_MS = 5000;
const WS_CONNECT_TIMEOUT_MS = 5000;

export default function GameCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PhaserGameHandle | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const liveMode = useRef(false);
  const demoStarted = useRef(false);

  useEffect(() => {
    if (!containerRef.current || handleRef.current) return;

    let destroyed = false;

    (async () => {
      try {
        const { createPhaserGame } = await import("../game/PhaserGame");
        if (destroyed || !containerRef.current) return;
        const handle = createPhaserGame(containerRef.current);
        if (!handle) return;
        handleRef.current = handle;

        // Stop the bus fallback timeline
        gameEventBus.stopDemoTimeline();

        // Bridge Phaser events → React HUD event bus
        handle.eventProcessor.onEvent((event) => {
          gameEventBus.emit(event);
        });

        // Try WS first — fall back to demo only if WS connection fully fails
        connectWs(handle);
      } catch (err) {
        console.error("[GameCanvas] Failed to create Phaser game:", err);
      }
    })();

    function startDemo(handle: PhaserGameHandle) {
      if (demoStarted.current || liveMode.current) return;
      demoStarted.current = true;
      console.log("[GameCanvas] Starting demo timeline (no server)");
      handle.eventProcessor.startTimeline();
    }

    function connectWs(handle: PhaserGameHandle) {
      if (destroyed) return;

      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("[WS] Connected to agent server — live mode");
          liveMode.current = true;
          demoStarted.current = false;
          // Kill any running demo timeline, re-attach for live events
          handle.eventProcessor.destroy();
          const scene = handle.getScene();
          if (scene) {
            handle.eventProcessor.attach(scene);
            handle.eventProcessor.onEvent((event) => {
              gameEventBus.emit(event);
            });
          }
        };

        ws.onmessage = (msg) => {
          try {
            const event = JSON.parse(msg.data as string) as GameEvent;
            handle.eventProcessor.injectEvent(event);
          } catch (err) {
            console.warn("[WS] Failed to parse message:", err);
          }
        };

        ws.onclose = () => {
          console.log("[WS] Disconnected from agent server");
          wsRef.current = null;
          if (liveMode.current && !destroyed) {
            liveMode.current = false;
            startDemo(handle);
          }
          // Try reconnecting
          if (!destroyed) {
            setTimeout(() => connectWs(handle), WS_RECONNECT_MS);
          }
        };

        ws.onerror = () => {
          // onclose will fire after this
        };
      } catch {
        if (!destroyed) {
          setTimeout(() => connectWs(handle), WS_RECONNECT_MS);
        }
      }
    }

    return () => {
      destroyed = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (handleRef.current) {
        handleRef.current.destroy();
        handleRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
