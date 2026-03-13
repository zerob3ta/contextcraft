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
        const useCampus =
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).get("scene") === "campus";
        const handle = createPhaserGame(containerRef.current, useCampus);
        if (!handle) return;
        handleRef.current = handle;

        // Stop the bus fallback timeline
        gameEventBus.stopDemoTimeline();

        // Bridge Phaser events → React HUD event bus
        handle.eventProcessor.onEvent((event) => {
          gameEventBus.emit(event);
        });

        // Bridge building clicks → HUD
        const scene = handle.getScene();
        if (scene) {
          scene.onBuildingSelect((buildingId) => {
            gameEventBus.emit({ type: "building_selected", buildingId });
          });
        }

        // Listen for HUD-originated events (e.g. agent_directive) and forward directly to scene
        const unsubBus = gameEventBus.on((event) => {
          const scene = handle.getScene();
          if (!scene) return;
          if (event.type === "agent_directive") {
            scene.setAgentDirective(event.agentId, event.directive);
          } else if (event.type === "directive_fulfilled") {
            scene.showDirectiveFulfilled(event.agentId, event.result);
          }
        });
        // Store unsub for cleanup
        (handle as unknown as { _busUnsub?: () => void })._busUnsub = unsubBus;

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
          // Kill any running demo timeline, clear demo state, re-attach for live events
          handle.eventProcessor.destroy();
          gameEventBus.stopDemoTimeline();
          gameEventBus.emit({ type: "server_connected" });
          const scene = handle.getScene();
          if (scene) {
            handle.eventProcessor.attach(scene);
            // No onEvent bridge needed — ws.onmessage emits directly to gameEventBus
            scene.onBuildingSelect((buildingId) => {
              gameEventBus.emit({ type: "building_selected", buildingId });
            });
          }
        };

        ws.onmessage = (msg) => {
          try {
            const event = JSON.parse(msg.data as string) as GameEvent;
            handle.eventProcessor.injectEvent(event);
            // Emit all WS events to gameEventBus for HUD consumption.
            // EventProcessor.onEvent bridge is only used for demo timeline events.
            gameEventBus.emit(event);
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
        (handleRef.current as unknown as { _busUnsub?: () => void })._busUnsub?.();
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
