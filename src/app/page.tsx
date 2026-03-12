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
    <div className="w-screen h-screen bg-[#0f0f1a] overflow-hidden flex flex-col">
      <HUD>
        {/* This is the center slot — Phaser canvas lives here */}
        <div className="relative w-full h-full">
          {/* Logo */}
          <div className="absolute top-2 left-2 z-20 flex items-center gap-2">
            <div className="font-pixel text-[10px] text-white/70 tracking-wider">
              MarketCraft
            </div>
            <div className="text-[9px] text-white/20">Context Markets Agent Sim</div>
          </div>
          <GameCanvas />
        </div>
      </HUD>
    </div>
  );
}
