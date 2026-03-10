"use client";

import { useEffect, useRef } from "react";
import type { PhaserGameHandle } from "../game/PhaserGame";
import { gameEventBus } from "../lib/gameEventBus";

export default function GameCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PhaserGameHandle | null>(null);

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

        // Stop the fallback timeline since Phaser is handling it
        gameEventBus.stopDemoTimeline();

        // Bridge Phaser events → React HUD event bus
        handle.eventProcessor.onEvent((event) => {
          gameEventBus.emit(event);
        });
      } catch (err) {
        console.error("[GameCanvas] Failed to create Phaser game:", err);
      }
    })();

    return () => {
      destroyed = true;
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
