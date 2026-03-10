"use client";

import { useEffect, useRef } from "react";
import type { AgentConfig } from "../game/config/agents";

interface SpeechEntry {
  message: string;
  timestamp: number;
}

interface AgentInspectorProps {
  agent: AgentConfig;
  location: string;
  speeches: SpeechEntry[];
  onClose: () => void;
}

const ROLE_LABELS: Record<string, string> = {
  creator: "Creator",
  pricer: "Pricer",
  trader: "Trader",
};

export default function AgentInspector({
  agent,
  location,
  speeches,
  onClose,
}: AgentInspectorProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Delay to avoid the click that opened this panel from closing it
    const t = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 50);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="absolute left-60 top-16 z-50 w-72 rounded-lg border border-white/10 bg-black/80 backdrop-blur-md p-4 animate-slide-in"
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-8 h-8 rounded-full flex-shrink-0 ring-2 ring-white/20"
          style={{ backgroundColor: agent.color }}
        />
        <div className="min-w-0">
          <div className="font-pixel text-xs text-white truncate">
            {agent.name}
          </div>
          <div className="text-[10px] text-white/50 mt-0.5">
            {ROLE_LABELS[agent.role]} — {agent.specialty}
          </div>
        </div>
        <button
          onClick={onClose}
          className="ml-auto text-white/30 hover:text-white/70 transition-colors text-lg leading-none"
          aria-label="Close"
        >
          x
        </button>
      </div>

      {/* Personality */}
      <div className="text-[11px] text-white/60 mb-3 italic leading-relaxed">
        {agent.personality}
      </div>

      {/* Location */}
      <div className="flex items-center gap-2 mb-3 text-[10px]">
        <span className="text-white/40 uppercase tracking-wider">
          Location
        </span>
        <span className="text-white/70 font-mono">{location}</span>
      </div>

      {/* Color swatch */}
      <div className="flex items-center gap-2 mb-3 text-[10px]">
        <span className="text-white/40 uppercase tracking-wider">Color</span>
        <div className="flex gap-1">
          <div
            className="w-4 h-4 rounded"
            style={{ backgroundColor: agent.color }}
            title={agent.color}
          />
          <div
            className="w-4 h-4 rounded"
            style={{ backgroundColor: agent.accentColor }}
            title={agent.accentColor}
          />
        </div>
      </div>

      {/* Recent speech */}
      <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1.5">
        Recent
      </div>
      <div className="space-y-1.5 max-h-32 overflow-y-auto hud-scroll">
        {speeches.length === 0 ? (
          <div className="text-[11px] text-white/25 italic">
            No recent messages
          </div>
        ) : (
          speeches.slice(-5).map((s, i) => (
            <div key={i} className="text-[11px] text-white/70 leading-relaxed">
              <span className="text-white/30 mr-1">
                {formatTime(s.timestamp)}
              </span>
              {s.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const s = Math.floor(ts / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
