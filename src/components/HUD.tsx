"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ALL_AGENTS,
  CREATORS,
  PRICERS,
  TRADERS,
  type AgentConfig,
  type AgentRole,
} from "../game/config/agents";
import type { GameEvent } from "../game/config/events";
import { gameEventBus } from "../lib/gameEventBus";
import AgentInspector from "./AgentInspector";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface MarketState {
  id: string;
  question: string;
  creator: string;
  fairValue: number | null;
  spread: number | null;
  lastPriceDirection: "up" | "down" | null;
  createdAt: number;
}

interface ActivityEntry {
  id: number;
  text: string;
  agentColor: string;
  timestamp: number;
}

interface SpeechEntry {
  message: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Role color helpers
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<AgentRole, string> = {
  creator: "#c4b5fd",
  pricer: "#67e8f9",
  trader: "#fb923c",
};

const ROLE_DOT: Record<AgentRole, string> = {
  creator: "bg-purple-400",
  pricer: "bg-cyan-400",
  trader: "bg-orange-400",
};

// ---------------------------------------------------------------------------
// NewsBar
// ---------------------------------------------------------------------------

interface NewsItem {
  id: number;
  headline: string;
  source: string;
  severity: "breaking" | "normal";
}

function NewsBar() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    return gameEventBus.on((event) => {
      if (event.type === "news_alert") {
        setItems((prev) => {
          const next = [
            ...prev,
            {
              id: nextId.current++,
              headline: event.headline,
              source: event.source,
              severity: event.severity,
            },
          ];
          // keep last 10
          return next.slice(-10);
        });
      }
    });
  }, []);

  if (items.length === 0) {
    return (
      <div className="h-8 flex items-center justify-center text-[10px] text-white/20 font-pixel tracking-wider">
        AWAITING NEWS...
      </div>
    );
  }

  return (
    <div className="h-8 overflow-hidden relative">
      <div className="absolute whitespace-nowrap animate-ticker flex items-center h-full gap-12">
        {items.map((item) => (
          <span key={item.id} className="inline-flex items-center gap-2">
            {item.severity === "breaking" && (
              <span className="font-pixel text-[9px] text-red-400 bg-red-400/15 px-1.5 py-0.5 rounded uppercase">
                Breaking
              </span>
            )}
            <span
              className={`text-xs ${
                item.severity === "breaking"
                  ? "text-red-300 font-medium"
                  : "text-white/60"
              }`}
            >
              {item.headline}
            </span>
            <span className="text-[10px] text-white/25">{item.source}</span>
          </span>
        ))}
        {/* Duplicate for seamless loop */}
        {items.map((item) => (
          <span
            key={`dup-${item.id}`}
            className="inline-flex items-center gap-2"
          >
            {item.severity === "breaking" && (
              <span className="font-pixel text-[9px] text-red-400 bg-red-400/15 px-1.5 py-0.5 rounded uppercase">
                Breaking
              </span>
            )}
            <span
              className={`text-xs ${
                item.severity === "breaking"
                  ? "text-red-300 font-medium"
                  : "text-white/60"
              }`}
            >
              {item.headline}
            </span>
            <span className="text-[10px] text-white/25">{item.source}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentRoster
// ---------------------------------------------------------------------------

function AgentDot({
  agent,
  status,
  active,
  onClick,
}: {
  agent: AgentConfig;
  status: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 w-full text-left px-1.5 py-0.5 rounded transition-all hover:bg-white/5 ${
        active ? "bg-white/5" : ""
      }`}
    >
      <div
        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
          active ? "ring-1 ring-white/40" : ""
        }`}
        style={{
          backgroundColor: agent.color,
          boxShadow: active ? `0 0 6px ${agent.color}60` : "none",
        }}
      />
      <span
        className={`text-[10px] truncate ${
          active ? "text-white/90" : "text-white/50"
        }`}
      >
        {agent.name}
      </span>
      <span className="text-[8px] text-white/25 ml-auto truncate max-w-[50px]">
        {status}
      </span>
    </button>
  );
}

function AgentRoster({
  agentLocations,
  activeAgents,
  onSelectAgent,
}: {
  agentLocations: Record<string, string>;
  activeAgents: Set<string>;
  onSelectAgent: (agent: AgentConfig) => void;
}) {
  const groups: { label: string; color: string; agents: AgentConfig[] }[] = [
    { label: "Creators", color: ROLE_COLORS.creator, agents: CREATORS },
    { label: "Pricers", color: ROLE_COLORS.pricer, agents: PRICERS },
    { label: "Traders", color: ROLE_COLORS.trader, agents: TRADERS },
  ];

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.label}>
          <div
            className="font-pixel text-[8px] uppercase tracking-widest mb-1 px-1.5"
            style={{ color: group.color }}
          >
            {group.label}
          </div>
          <div className="space-y-0">
            {group.agents.map((agent) => (
              <AgentDot
                key={agent.id}
                agent={agent}
                status={agentLocations[agent.id] || "lounge"}
                active={activeAgents.has(agent.id)}
                onClick={() => onSelectAgent(agent)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketBoard
// ---------------------------------------------------------------------------

function MarketCard({ market }: { market: MarketState }) {
  const creator = ALL_AGENTS.find((a) => a.id === market.creator);
  const priceClass =
    market.lastPriceDirection === "up"
      ? "animate-flash-green"
      : market.lastPriceDirection === "down"
      ? "animate-flash-red"
      : "";

  return (
    <div className="bg-white/5 rounded-md p-2.5 border border-white/5 animate-slide-in">
      <div className="text-[11px] text-white/80 leading-relaxed mb-1.5">
        {market.question}
      </div>
      <div className="flex items-center justify-between">
        {market.fairValue !== null ? (
          <div className={`font-mono text-sm text-white font-bold ${priceClass}`}>
            {Math.round(market.fairValue * 100)}c
            {market.spread !== null && (
              <span className="text-[10px] text-white/30 font-normal ml-1">
                +/-{Math.round(market.spread * 100)}c
              </span>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-yellow-400/60 font-pixel">
            AWAITING PRICE
          </div>
        )}
        {creator && (
          <div className="flex items-center gap-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: creator.color }}
            />
            <span className="text-[9px] text-white/30">{creator.name}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MarketBoard({ markets }: { markets: MarketState[] }) {
  return (
    <div className="space-y-2">
      <div className="font-pixel text-[8px] text-cyan-400/70 uppercase tracking-widest px-1">
        Markets
      </div>
      {markets.length === 0 ? (
        <div className="text-[10px] text-white/20 italic px-1">
          No active markets
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[300px] overflow-y-auto hud-scroll">
          {markets.map((m) => (
            <MarketCard key={m.id} market={m} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------

function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="space-y-1">
      <div className="font-pixel text-[8px] text-white/30 uppercase tracking-widest px-1">
        Activity
      </div>
      <div
        ref={scrollRef}
        className="space-y-0.5 max-h-[120px] overflow-y-auto hud-scroll"
      >
        {entries.length === 0 ? (
          <div className="text-[10px] text-white/15 italic px-1">
            Waiting for action...
          </div>
        ) : (
          entries.slice(-20).map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-1.5 text-[10px] animate-slide-up px-1"
            >
              <div
                className="w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0"
                style={{ backgroundColor: entry.agentColor }}
              />
              <span className="text-white/50 leading-relaxed">
                {entry.text}
              </span>
              <span className="text-white/15 ml-auto flex-shrink-0 text-[9px]">
                {formatTime(entry.timestamp)}
              </span>
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

// ---------------------------------------------------------------------------
// Main HUD
// ---------------------------------------------------------------------------

export default function HUD() {
  const startTime = useRef(Date.now());
  const nextActivityId = useRef(0);

  // State
  const [agentLocations, setAgentLocations] = useState<Record<string, string>>(
    () => {
      const locs: Record<string, string> = {};
      for (const a of ALL_AGENTS) locs[a.id] = "lounge";
      return locs;
    }
  );
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [markets, setMarkets] = useState<MarketState[]>([]);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(null);
  const [agentSpeeches, setAgentSpeeches] = useState<
    Record<string, SpeechEntry[]>
  >({});

  const getAgentColor = useCallback((agentId: string): string => {
    return ALL_AGENTS.find((a) => a.id === agentId)?.color || "#888";
  }, []);

  const getAgentName = useCallback((agentId: string): string => {
    return ALL_AGENTS.find((a) => a.id === agentId)?.name || agentId;
  }, []);

  const elapsed = useCallback(
    () => Date.now() - startTime.current,
    []
  );

  const addActivity = useCallback(
    (text: string, agentColor: string) => {
      setActivities((prev) => {
        const next = [
          ...prev,
          {
            id: nextActivityId.current++,
            text,
            agentColor,
            timestamp: elapsed(),
          },
        ];
        return next.slice(-30); // keep last 30
      });
    },
    [elapsed]
  );

  // Subscribe to game events
  useEffect(() => {
    const unsub = gameEventBus.on((event: GameEvent) => {
      switch (event.type) {
        case "agent_move": {
          setAgentLocations((prev) => ({
            ...prev,
            [event.agentId]: event.destination,
          }));
          // Mark active briefly
          setActiveAgents((prev) => {
            const next = new Set(prev);
            next.add(event.agentId);
            return next;
          });
          setTimeout(() => {
            setActiveAgents((prev) => {
              const next = new Set(prev);
              next.delete(event.agentId);
              return next;
            });
          }, 4000);
          addActivity(
            `${getAgentName(event.agentId)} → ${event.destination}`,
            getAgentColor(event.agentId)
          );
          break;
        }

        case "agent_speak": {
          setActiveAgents((prev) => {
            const next = new Set(prev);
            next.add(event.agentId);
            return next;
          });
          setTimeout(() => {
            setActiveAgents((prev) => {
              const next = new Set(prev);
              next.delete(event.agentId);
              return next;
            });
          }, 5000);
          setAgentSpeeches((prev) => ({
            ...prev,
            [event.agentId]: [
              ...(prev[event.agentId] || []),
              { message: event.message, timestamp: elapsed() },
            ].slice(-10),
          }));
          addActivity(
            `${getAgentName(event.agentId)}: "${event.message}"`,
            getAgentColor(event.agentId)
          );
          break;
        }

        case "market_spawning": {
          setMarkets((prev) => {
            // Prevent duplicate markets from double-firing
            if (prev.some((m) => m.id === event.marketId)) return prev;
            return [
              ...prev,
              {
                id: event.marketId,
                question: event.question,
                creator: event.creator,
                fairValue: null,
                spread: null,
                lastPriceDirection: null,
                createdAt: elapsed(),
              },
            ];
          });
          addActivity(
            `New market: ${event.question}`,
            getAgentColor(event.creator)
          );
          break;
        }

        case "price_update": {
          setMarkets((prev) =>
            prev.map((m) => {
              if (m.id !== event.marketId) return m;
              const dir =
                m.fairValue === null
                  ? null
                  : event.fairValue > m.fairValue
                  ? "up"
                  : "down";
              return {
                ...m,
                fairValue: event.fairValue,
                spread: event.spread,
                lastPriceDirection: dir,
              };
            })
          );
          addActivity(
            `${event.marketId} priced at ${Math.round(event.fairValue * 100)}c`,
            "#67e8f9"
          );
          break;
        }

        case "trade_executed": {
          addActivity(
            `${getAgentName(event.agentId)} ${event.side} ${event.size}@${Math.round(event.price * 100)}c on ${event.marketId}`,
            getAgentColor(event.agentId)
          );
          setActiveAgents((prev) => {
            const next = new Set(prev);
            next.add(event.agentId);
            return next;
          });
          setTimeout(() => {
            setActiveAgents((prev) => {
              const next = new Set(prev);
              next.delete(event.agentId);
              return next;
            });
          }, 3000);
          break;
        }

        case "news_alert": {
          addActivity(
            `[${event.source}] ${event.headline}`,
            event.severity === "breaking" ? "#ef4444" : "#6b7280"
          );
          break;
        }
      }
    });

    // Demo timeline is started by EventProcessor in PhaserGame.ts
    // and bridged to gameEventBus via GameCanvas.tsx.
    // As a fallback (if Phaser hasn't loaded yet), start the bus timeline
    // after a short delay — it will no-op if already started.
    const fallbackTimer = setTimeout(() => {
      gameEventBus.startDemoTimeline();
    }, 3000);

    return () => {
      clearTimeout(fallbackTimer);
      unsub();
    };
  }, [addActivity, elapsed, getAgentColor, getAgentName]);

  return (
    <div className="absolute inset-0 pointer-events-none z-10 flex flex-col">
      {/* Top: News Bar */}
      <div className="pointer-events-auto bg-black/60 backdrop-blur-sm border-b border-white/5">
        <NewsBar />
      </div>

      {/* Middle: Sidebars flanking the canvas */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: Agent Roster */}
        <div className="pointer-events-auto w-44 bg-black/50 backdrop-blur-sm border-r border-white/5 p-2 overflow-y-auto hud-scroll hidden md:block">
          <AgentRoster
            agentLocations={agentLocations}
            activeAgents={activeAgents}
            onSelectAgent={setSelectedAgent}
          />
        </div>

        {/* Center: transparent pass-through to canvas */}
        <div className="flex-1 relative">
          {/* Agent Inspector (overlaid) */}
          {selectedAgent && (
            <div className="pointer-events-auto">
              <AgentInspector
                agent={selectedAgent}
                location={agentLocations[selectedAgent.id] || "lounge"}
                speeches={agentSpeeches[selectedAgent.id] || []}
                onClose={() => setSelectedAgent(null)}
              />
            </div>
          )}
        </div>

        {/* Right sidebar: Market Board */}
        <div className="pointer-events-auto w-56 bg-black/50 backdrop-blur-sm border-l border-white/5 p-2 overflow-y-auto hud-scroll hidden lg:block">
          <MarketBoard markets={markets} />
        </div>
      </div>

      {/* Bottom: Activity Feed */}
      <div className="pointer-events-auto bg-black/60 backdrop-blur-sm border-t border-white/5 p-2">
        <ActivityFeed entries={activities} />
      </div>
    </div>
  );
}
