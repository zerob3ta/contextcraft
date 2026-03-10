"use client";

import dynamic from "next/dynamic";
import HUD from "../components/HUD";

const GameCanvas = dynamic(() => import("../components/GameCanvas"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <div className="font-pixel text-xs text-white/20 animate-pulse">
        Loading game...
      </div>
    </div>
  ),
});

export default function Home() {
  return (
    <div className="w-screen h-screen bg-[#0f0f1a] overflow-hidden relative flex items-center justify-center">
      {/* Logo */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-2">
        <div className="font-pixel text-[10px] text-white/70 tracking-wider">
          ContextCraft
        </div>
        <div className="text-[9px] text-white/20">AI Market Town</div>
      </div>

      {/* Game canvas container — centered, maintains 1280x720 aspect ratio */}
      <div
        className="relative w-full h-full"
        style={{
          maxWidth: "1280px",
          maxHeight: "720px",
          aspectRatio: "1280 / 720",
        }}
      >
        {/* Phaser canvas */}
        <div className="absolute inset-0">
          <GameCanvas />
        </div>

        {/* React HUD overlay */}
        <HUD />
      </div>
    </div>
  );
}
