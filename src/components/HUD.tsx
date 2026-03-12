"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ALL_AGENTS,
  type AgentConfig,
  type AgentRole,
} from "../game/config/agents";
import type { AgentMood, GameEvent } from "../game/config/events";
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
  recentActions: { agentName: string; action: string; ts: number }[];
}

interface SpeechEntry {
  message: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Chat message types for the unified group chat stream
// ---------------------------------------------------------------------------

interface ChatMsg {
  id: string;
  type: "message" | "directive" | "mood_change" | "activity" | "news";
  agentId?: string;
  agentName?: string;
  role?: string;
  message: string;
  mood?: AgentMood;
  replyTo?: string | null;
  replyPreview?: string | null;
  directive?: string;
  destination?: string;
  oldMood?: AgentMood;
  newMood?: AgentMood;
  building?: string; // which building this message belongs to
  severity?: "breaking" | "normal"; // for news type messages
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Mood colors
// ---------------------------------------------------------------------------

const MOOD_COLORS: Record<AgentMood, string> = {
  bullish: "#4ade80",
  bearish: "#f87171",
  uncertain: "#facc15",
  confident: "#60a5fa",
  scared: "#6b7280",
  manic: "#a78bfa",
  neutral: "#6b7280",
};

// ---------------------------------------------------------------------------
// Role color helpers
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<AgentRole, string> = {
  creator: "#c4b5fd",
  pricer: "#67e8f9",
  trader: "#fb923c",
};

// ---------------------------------------------------------------------------
// News types & lifecycle
// ---------------------------------------------------------------------------

interface NewsItem {
  id: number;
  headline: string;
  source: string;
  severity: "breaking" | "normal";
  arrivedAt: number;
}

// ---------------------------------------------------------------------------
// BreakingTicker — top bar
// ---------------------------------------------------------------------------

const TICKER_PX_PER_SEC = 40;

function BreakingTicker({ items }: { items: NewsItem[] }) {
  const recent = items.slice().reverse().slice(0, 8);
  const contentRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(60);

  useEffect(() => {
    if (!contentRef.current || recent.length === 0) return;
    const el = contentRef.current;
    requestAnimationFrame(() => {
      const halfWidth = el.scrollWidth / 2;
      const viewportWidth = el.parentElement?.clientWidth || 1200;
      const totalTravel = halfWidth + viewportWidth;
      setDuration(totalTravel / TICKER_PX_PER_SEC);
    });
  }, [recent.map((b) => b.id).join(",")]);

  if (recent.length === 0) {
    return (
      <div className="h-7 flex items-center justify-center text-[9px] text-white/20 font-pixel tracking-wider">
        CONTEXTCRAFT
      </div>
    );
  }

  const renderItem = (item: NewsItem, keyPrefix = "") => {
    const isBreaking = item.severity === "breaking" && Date.now() - item.arrivedAt < 5 * 60_000;
    return (
      <span key={`${keyPrefix}${item.id}`} className="inline-flex items-center gap-2 px-6">
        {isBreaking && (
          <span className="font-pixel text-[8px] text-red-400 bg-red-400/15 px-1.5 py-0.5 rounded uppercase flex-shrink-0">
            Breaking
          </span>
        )}
        <span className={`text-[11px] ${isBreaking ? "text-red-300 font-medium" : "text-white/50"}`}>
          {item.headline}
        </span>
        <span className="text-[9px] text-white/25 flex-shrink-0">{item.source}</span>
      </span>
    );
  };

  return (
    <div className="h-7 overflow-hidden relative">
      <div
        ref={contentRef}
        className="absolute whitespace-nowrap flex items-center h-full"
        style={{
          animation: `ticker-constant ${duration}s linear infinite`,
        }}
      >
        {recent.map((item) => renderItem(item))}
        {recent.map((item) => renderItem(item, "dup-"))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BreakingBanner
// ---------------------------------------------------------------------------

function BreakingBanner({ items }: { items: NewsItem[] }) {
  const [banner, setBanner] = useState<NewsItem | null>(null);
  const lastBannerId = useRef(-1);

  useEffect(() => {
    const latest = items.findLast(
      (i) => i.severity === "breaking" && Date.now() - i.arrivedAt < 6000
    );
    if (latest && latest.id !== lastBannerId.current) {
      lastBannerId.current = latest.id;
      setBanner(latest);
      const t = setTimeout(() => setBanner(null), 5000);
      return () => clearTimeout(t);
    }
  }, [items]);

  if (!banner) return null;

  return (
    <div className="absolute top-8 left-0 right-0 z-50 pointer-events-none flex justify-center px-4">
      <div className="animate-banner bg-red-950/90 backdrop-blur-md border border-red-500/30 rounded-lg px-5 py-3 max-w-xl shadow-lg shadow-red-900/30">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-pixel text-[8px] text-red-400 uppercase tracking-wider">
            Breaking News
          </span>
          <span className="text-[9px] text-red-400/50">{banner.source}</span>
        </div>
        <div className="text-[13px] text-red-100 font-medium leading-snug">
          {banner.headline}
        </div>
      </div>
    </div>
  );
}

function formatAge(arrivedAt: number, now: number): string {
  const sec = Math.floor((now - arrivedAt) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// Building config for nav
// ---------------------------------------------------------------------------

import type { RealBuilding } from "../game/config/agents";

const BUILDING_NAV: { id: RealBuilding; icon: string; label: string; color: string }[] = [
  { id: "lounge", icon: "☕", label: "Lounge", color: "#d97706" },
  { id: "newsroom", icon: "📰", label: "Newsroom", color: "#dc2626" },
  { id: "workshop", icon: "🔧", label: "Workshop", color: "#7c3aed" },
  { id: "exchange", icon: "📊", label: "Exchange", color: "#0891b2" },
  { id: "pit", icon: "🔥", label: "Pit", color: "#ea580c" },
];

// ---------------------------------------------------------------------------
// BuildingNav — left rail organized by building
// ---------------------------------------------------------------------------

function BuildingNav({
  activeBuilding,
  onSelectBuilding,
  agentLocations,
  activeAgents,
  agentDirectives,
  recentBuildingActivity,
  onSelectAgent,
}: {
  activeBuilding: RealBuilding | "all";
  onSelectBuilding: (b: RealBuilding | "all") => void;
  agentLocations: Record<string, string>;
  activeAgents: Set<string>;
  agentDirectives: Record<string, string>;
  recentBuildingActivity: Set<string>;
  onSelectAgent: (agent: AgentConfig) => void;
}) {
  // Count agents per building
  const counts: Record<string, number> = {};
  for (const loc of Object.values(agentLocations)) {
    counts[loc] = (counts[loc] || 0) + 1;
  }

  // Get agents at a specific building
  const agentsAt = (buildingId: string) =>
    ALL_AGENTS.filter((a) => (agentLocations[a.id] || "lounge") === buildingId);

  return (
    <div className="flex flex-col gap-1">
      {/* All feed toggle */}
      <button
        onClick={() => onSelectBuilding("all")}
        className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded transition-all ${
          activeBuilding === "all" ? "bg-white/10" : "hover:bg-white/5"
        }`}
      >
        <span className="text-[12px]">🌐</span>
        <span className={`text-[10px] font-semibold ${activeBuilding === "all" ? "text-white/90" : "text-white/50"}`}>
          All
        </span>
      </button>

      <div className="h-px bg-white/5 mx-1 my-0.5" />

      {BUILDING_NAV.map((b) => {
        const count = counts[b.id] || 0;
        const isActive = activeBuilding === b.id;
        const hasActivity = recentBuildingActivity.has(b.id);

        return (
          <div key={b.id}>
            <button
              onClick={() => onSelectBuilding(b.id)}
              className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded transition-all ${
                isActive ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              <span className="text-[12px]">{b.icon}</span>
              <span className={`text-[10px] font-semibold flex-1 ${isActive ? "text-white/90" : "text-white/50"}`}>
                {b.label}
              </span>
              {count > 0 && (
                <span className={`text-[9px] ${isActive ? "text-white/60" : "text-white/25"}`}>
                  {count}
                </span>
              )}
              {hasActivity && !isActive && (
                <div
                  className="w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: b.color }}
                />
              )}
            </button>

            {/* Always show agents in this building */}
            {count > 0 && (
              <div className="pl-6 pr-1 pb-1">
                {agentsAt(b.id).map((agent) => (
                  <button
                    key={agent.id}
                    onClick={(e) => { e.stopPropagation(); onSelectAgent(agent); }}
                    className="flex items-center gap-1.5 w-full text-left px-1 py-0.5 rounded hover:bg-white/5"
                  >
                    <div
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        activeAgents.has(agent.id) ? "ring-1 ring-white/40" : ""
                      }`}
                      style={{ backgroundColor: agent.color }}
                    />
                    <span className="text-[9px] text-white/50 truncate">{agent.name}</span>
                    <span className="text-[7px] uppercase text-white/20 ml-auto">{agent.role}</span>
                    {agentDirectives[agent.id] && (
                      <span className="text-[7px] text-cyan-400/60 truncate max-w-[50px]">
                        → {agentDirectives[agent.id].slice(0, 20)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatStream — unified group chat panel (#the-lounge)
// ---------------------------------------------------------------------------

function ChatAvatar({ agentId }: { agentId: string }) {
  const agent = ALL_AGENTS.find((a) => a.id === agentId);
  const color = agent?.color || "#888";
  const initial = agent?.name?.[0] || "?";

  return (
    <div
      className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-black/70 flex-shrink-0"
      style={{ backgroundColor: color }}
    >
      {initial}
    </div>
  );
}

function ChatMessageItem({ msg, allMessages }: { msg: ChatMsg; allMessages: ChatMsg[] }) {
  const agent = msg.agentId ? ALL_AGENTS.find((a) => a.id === msg.agentId) : null;
  const agentColor = agent?.color || "#888";

  // --- Mood change ---
  if (msg.type === "mood_change") {
    return (
      <div className="flex justify-center py-1.5">
        <span className="text-[10px] text-white/30">
          {msg.agentName} mood shifted:{" "}
          <span style={{ color: msg.oldMood ? MOOD_COLORS[msg.oldMood] : "#6b7280" }}>
            {msg.oldMood}
          </span>
          {" → "}
          <span style={{ color: msg.newMood ? MOOD_COLORS[msg.newMood] : "#6b7280" }}>
            {msg.newMood}
          </span>
        </span>
      </div>
    );
  }

  // --- News (breaking + normal) ---
  if (msg.type === "news") {
    const isBreaking = msg.severity === "breaking";
    return (
      <div className={`mx-2 my-1.5 rounded-md px-3 py-2 ${
        isBreaking
          ? "bg-amber-500/10 border border-amber-500/20"
          : "bg-white/[0.03] border border-white/5"
      }`}>
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={`font-pixel text-[8px] px-1.5 py-0.5 rounded uppercase ${
            isBreaking
              ? "text-amber-400 bg-amber-400/15"
              : "text-white/40 bg-white/5"
          }`}>
            {isBreaking ? "Breaking" : "News"}
          </span>
        </div>
        <div className={`text-[11px] leading-snug ${
          isBreaking ? "text-amber-200" : "text-white/60"
        }`}>{msg.message}</div>
      </div>
    );
  }

  // --- Activity (trades, market creation, pricing, directive fulfillment) ---
  if (msg.type === "activity") {
    const lower = msg.message.toLowerCase();
    const isTrade = lower.includes("bought") || lower.includes("sold") || lower.includes("yes $") || lower.includes("no $");
    const isMarket = lower.includes("created market") || lower.includes("created:");
    const isPrice = lower.includes("priced");
    const isResearch = lower.includes("researched");

    let label: string;
    let labelColor: string;
    let bgColor: string;
    if (isResearch) {
      label = "RESEARCH";
      labelColor = "#a3e635";
      bgColor = "rgba(163, 230, 53, 0.06)";
    } else if (isTrade) {
      label = "TRADE";
      labelColor = "#fb923c";
      bgColor = "rgba(251, 146, 60, 0.06)";
    } else if (isMarket) {
      label = "CREATE";
      labelColor = "#c4b5fd";
      bgColor = "rgba(196, 181, 253, 0.06)";
    } else if (isPrice) {
      label = "PRICE";
      labelColor = "#67e8f9";
      bgColor = "rgba(103, 232, 249, 0.06)";
    } else {
      label = "ACTION";
      labelColor = "#94a3b8";
      bgColor = "rgba(148, 163, 184, 0.06)";
    }

    return (
      <div className="px-3 py-1.5">
        <div className="flex items-start gap-2 rounded px-2.5 py-1.5" style={{ backgroundColor: bgColor }}>
          <span
            className="text-[8px] font-bold uppercase tracking-wider mt-px flex-shrink-0"
            style={{ color: labelColor }}
          >
            {label}
          </span>
          <span className="text-[10px] text-white/60 leading-snug">
            {msg.message}
          </span>
        </div>
      </div>
    );
  }

  // --- Directive ---
  if (msg.type === "directive") {
    return (
      <div className="flex gap-2 px-3 py-1.5">
        <ChatAvatar agentId={msg.agentId || ""} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold" style={{ color: agentColor }}>
              {msg.agentName}
            </span>
            {agent && (
              <span className="text-[8px] uppercase tracking-wide text-white/25">
                {agent.role}
              </span>
            )}
            <span className="text-[8px] text-white/15 ml-auto flex-shrink-0">
              {formatAge(msg.timestamp, Date.now())}
            </span>
          </div>
          <div className="text-[11px] text-[#e8e6e1]/70 leading-snug mt-0.5">
            {msg.message}
          </div>
          {/* Directive action bar */}
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[8px] font-pixel uppercase tracking-wide text-cyan-400 bg-cyan-400/10 px-1.5 py-0.5 rounded">
              Directive
            </span>
            <span className="text-[9px] text-white/40">{msg.directive}</span>
            {msg.destination && (
              <span className="text-[9px] text-white/25">
                {"-->"} {msg.destination}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- Regular / reply message ---
  // Find reply reference
  let replyRef: { agentName: string; preview: string; color: string } | null = null;
  if (msg.replyTo) {
    // Use the replyPreview from the event if available
    if (msg.replyPreview) {
      // replyPreview format: "AgentName: truncated message..."
      const colonIdx = msg.replyPreview.indexOf(":");
      const refName = colonIdx > 0 ? msg.replyPreview.slice(0, colonIdx) : msg.replyPreview;
      const refText = colonIdx > 0 ? msg.replyPreview.slice(colonIdx + 1).trim() : "";
      const refAgent = ALL_AGENTS.find((a) => a.name === refName);
      replyRef = {
        agentName: refName,
        preview: refText,
        color: refAgent?.color || "#888",
      };
    } else {
      // Fallback: look up the original message
      const original = allMessages.find((m) => m.id === msg.replyTo);
      if (original) {
        const origAgent = original.agentId ? ALL_AGENTS.find((a) => a.id === original.agentId) : null;
        replyRef = {
          agentName: original.agentName || "Unknown",
          preview: original.message.slice(0, 60),
          color: origAgent?.color || "#888",
        };
      }
    }
  }

  return (
    <div className="px-3 py-1.5">
      {/* Reply reference bar */}
      {replyRef && (
        <div className="pl-8 mb-1">
          <div
            className="flex items-center gap-1.5 pl-2 text-[9px] text-white/30"
            style={{ borderLeft: `2px solid ${replyRef.color}` }}
          >
            <span style={{ color: replyRef.color }}>@{replyRef.agentName}</span>
            <span className="truncate">{replyRef.preview}</span>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <ChatAvatar agentId={msg.agentId || ""} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold" style={{ color: agentColor }}>
              {msg.agentName}
            </span>
            {agent && (
              <span className="text-[8px] uppercase tracking-wide text-white/25">
                {agent.role}
              </span>
            )}
            <span className="text-[8px] text-white/15 ml-auto flex-shrink-0">
              {formatAge(msg.timestamp, Date.now())}
            </span>
          </div>
          <div className="text-[11px] text-[#e8e6e1]/70 leading-snug mt-0.5">
            {msg.message}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatStream({
  messages,
  activeBuilding,
  agentCountAtBuilding,
}: {
  messages: ChatMsg[];
  activeBuilding: RealBuilding | "all";
  agentCountAtBuilding: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filter messages by building
  const filtered = activeBuilding === "all"
    ? messages
    : messages.filter((m) => m.building === activeBuilding);

  // Always scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [filtered.length]);

  const navItem = BUILDING_NAV.find((b) => b.id === activeBuilding);
  const headerText = activeBuilding === "all" ? "# all-rooms" : `# ${navItem?.label.toLowerCase() || activeBuilding}`;
  const headerIcon = activeBuilding === "all" ? "🌐" : navItem?.icon || "";

  return (
    <div className="flex flex-col" style={{ height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5" style={{ flexShrink: 0 }}>
        <span className="text-[13px]">{headerIcon}</span>
        <span className="text-[13px] font-semibold text-[#e8e6e1]">{headerText}</span>
        {activeBuilding !== "all" && (
          <div className="flex items-center gap-1 ml-auto">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[9px] text-white/40">{agentCountAtBuilding} here</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="relative" style={{ flex: "1 1 0%", minHeight: 0 }}>
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto hud-scroll py-1"
        >
          {filtered.length === 0 ? (
            <div className="text-[10px] text-white/20 italic px-3 pt-4">
              {activeBuilding === "all"
                ? "Agents are warming up..."
                : `No activity in ${navItem?.label || activeBuilding} yet...`}
            </div>
          ) : (
            filtered.map((msg) => (
              <ChatMessageItem key={msg.id} msg={msg} allMessages={messages} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main HUD
// ---------------------------------------------------------------------------

export default function HUD({ children }: { children?: React.ReactNode }) {
  const startTime = useRef(Date.now());
  const nextNewsId = useRef(0);
  const nextChatId = useRef(0);

  // State
  const [agentLocations, setAgentLocations] = useState<Record<string, string>>(
    () => {
      const locs: Record<string, string> = {};
      const roleLocations: Record<string, string> = { creator: "newsroom", pricer: "exchange", trader: "pit" };
      for (const a of ALL_AGENTS) locs[a.id] = roleLocations[a.role] || "lounge";
      return locs;
    }
  );
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [markets, setMarkets] = useState<MarketState[]>([]);
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(null);
  const [agentSpeeches, setAgentSpeeches] = useState<
    Record<string, SpeechEntry[]>
  >({});
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [agentDirectives, setAgentDirectives] = useState<Record<string, string>>({});
  const [agentMoods, setAgentMoods] = useState<Record<string, AgentMood>>({});
  // Track which agents have been active recently (for "X chatting" count)
  const [chattingAgents, setChattingAgents] = useState<Set<string>>(new Set());
  // Active building room being viewed
  const [activeBuilding, setActiveBuilding] = useState<RealBuilding | "all">("all");
  // Track recent activity per building for nav indicators
  const [recentBuildingActivity, setRecentBuildingActivity] = useState<Set<string>>(new Set());

  const getAgentName = useCallback((agentId: string): string => {
    return ALL_AGENTS.find((a) => a.id === agentId)?.name || agentId;
  }, []);

  const getAgentRole = useCallback((agentId: string): string => {
    return ALL_AGENTS.find((a) => a.id === agentId)?.role || "unknown";
  }, []);

  const elapsed = useCallback(
    () => Date.now() - startTime.current,
    []
  );

  const addChatMessage = useCallback((msg: Omit<ChatMsg, "id">) => {
    const id = `chat-${nextChatId.current++}`;
    setChatMessages((prev) => {
      const next = [...prev, { ...msg, id }];
      // Per-building cap: keep last 40 messages per building so quiet rooms don't get flushed
      if (next.length > 300) {
        const byBuilding = new Map<string, ChatMsg[]>();
        for (const m of next) {
          const b = m.building || "unknown";
          if (!byBuilding.has(b)) byBuilding.set(b, []);
          byBuilding.get(b)!.push(m);
        }
        const pruned: ChatMsg[] = [];
        for (const [, msgs] of byBuilding) {
          pruned.push(...msgs.slice(-40));
        }
        pruned.sort((a, b) => a.timestamp - b.timestamp);
        return pruned;
      }
      return next;
    });
    // Track building activity for nav pulse indicators
    if (msg.building) {
      setRecentBuildingActivity((prev) => {
        const next = new Set(prev);
        next.add(msg.building!);
        return next;
      });
      const b = msg.building;
      setTimeout(() => {
        setRecentBuildingActivity((prev) => {
          const next = new Set(prev);
          next.delete(b);
          return next;
        });
      }, 5_000);
    }
  }, []);

  const markAgentChatting = useCallback((agentId: string) => {
    setChattingAgents((prev) => {
      const next = new Set(prev);
      next.add(agentId);
      return next;
    });
    setTimeout(() => {
      setChattingAgents((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }, 10_000);
  }, []);

  // Subscribe to game events
  useEffect(() => {
    const unsub = gameEventBus.on((event: GameEvent) => {
      switch (event.type) {
        case "agent_move": {
          setAgentLocations((prev) => ({
            ...prev,
            [event.agentId]: event.destination,
          }));
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
          // Also add to chat stream so job speak actions appear inline
          markAgentChatting(event.agentId);
          addChatMessage({
            type: "message",
            agentId: event.agentId,
            agentName: getAgentName(event.agentId),
            role: getAgentRole(event.agentId),
            message: event.message,
            building: (event as { building?: string }).building,
            timestamp: Date.now(),
          });
          break;
        }

        case "chat_message": {
          markAgentChatting(event.agentId);
          if (event.mood) {
            setAgentMoods((prev) => ({ ...prev, [event.agentId]: event.mood }));
          }
          addChatMessage({
            type: "message",
            agentId: event.agentId,
            agentName: event.agentName,
            role: event.role,
            message: event.message,
            mood: event.mood,
            replyTo: event.replyTo,
            replyPreview: event.replyPreview,
            building: event.building,
            timestamp: Date.now(),
          });
          break;
        }

        case "chat_directive": {
          markAgentChatting(event.agentId);
          addChatMessage({
            type: "directive",
            agentId: event.agentId,
            agentName: event.agentName,
            message: `Heading to ${event.destination}`,
            directive: event.directive,
            destination: event.destination,
            building: event.building,
            timestamp: Date.now(),
          });
          break;
        }

        case "mood_change": {
          setAgentMoods((prev) => ({ ...prev, [event.agentId]: event.newMood }));
          addChatMessage({
            type: "mood_change",
            agentId: event.agentId,
            agentName: event.agentName,
            message: "",
            oldMood: event.oldMood,
            newMood: event.newMood,
            building: event.building,
            timestamp: Date.now(),
          });
          break;
        }

        case "market_spawning": {
          setMarkets((prev) => {
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
                recentActions: [],
              },
            ];
          });
          const creatorName = getAgentName(event.creator);
          addChatMessage({
            type: "activity",
            agentId: event.creator,
            agentName: creatorName,
            message: `${creatorName} created market: "${event.question}"`,
            building: event.building || "workshop",
            timestamp: Date.now(),
          });
          break;
        }

        case "price_update": {
          setMarkets((prev) => {
            const updated = prev.map((m) => {
              if (m.id !== event.marketId) return m;
              const dir: "up" | "down" | null =
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
                recentActions: [
                  ...m.recentActions,
                  {
                    agentName: "Pricer",
                    action: `priced at ${Math.round(event.fairValue * 100)}c`,
                    ts: Date.now(),
                  },
                ].slice(-4),
              };
            });
            // Add price update to chat stream with market name
            const market = prev.find((m) => m.id === event.marketId);
            if (market) {
              const shortQ = market.question.length > 50 ? market.question.slice(0, 47) + "..." : market.question;
              addChatMessage({
                type: "activity",
                message: `"${shortQ}" priced at ${Math.round(event.fairValue * 100)}¢ (spread ${Math.round(event.spread * 100)}¢)`,
                building: event.building || "exchange",
                timestamp: Date.now(),
              });
            }
            return updated;
          });
          break;
        }

        case "trade_executed": {
          const traderName = getAgentName(event.agentId);
          setMarkets((prev) =>
            prev.map((m) => {
              if (m.id !== event.marketId) return m;
              return {
                ...m,
                recentActions: [
                  ...m.recentActions,
                  {
                    agentName: traderName,
                    action: `bought ${event.side} ${event.size}x at ${Math.round(event.price * 100)}¢`,
                    ts: Date.now(),
                  },
                ].slice(-4),
              };
            })
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
          // Look up market name for the trade
          setMarkets((currentMarkets) => {
            const market = currentMarkets.find((m) => m.id === event.marketId);
            const marketQ = event.question || market?.question || "a market";
            const shortQ = marketQ.length > 50 ? marketQ.slice(0, 47) + "..." : marketQ;
            const cost = Math.round(event.size * event.price);
            addChatMessage({
              type: "activity",
              agentId: event.agentId,
              agentName: traderName,
              message: `${traderName} bought ${event.side} $${cost} on "${shortQ}"`,
              building: event.building || "pit",
              timestamp: Date.now(),
            });
            return currentMarkets; // no mutation
          });
          break;
        }

        case "news_alert": {
          const newsId = nextNewsId.current++;
          setNewsItems((prev) => {
            const next = [
              ...prev,
              {
                id: newsId,
                headline: event.headline,
                source: event.source,
                severity: event.severity,
                arrivedAt: Date.now(),
              },
            ];
            const cutoff = Date.now() - 30 * 60_000;
            return next.filter((n) => n.arrivedAt > cutoff).slice(-30);
          });
          // Add all news to newsroom chat stream (breaking + normal)
          addChatMessage({
            type: "news",
            message: event.headline,
            building: "newsroom",
            severity: event.severity || "normal",
            timestamp: Date.now(),
          });
          break;
        }

        case "building_selected": {
          setActiveBuilding(event.buildingId as RealBuilding);
          break;
        }

        case "agent_directive": {
          setAgentDirectives((p) => ({ ...p, [event.agentId]: event.directive }));
          if (event.directive) {
            const agentIdCopy = event.agentId;
            setTimeout(() => {
              setAgentDirectives((p) => {
                const n = { ...p };
                delete n[agentIdCopy];
                return n;
              });
            }, 30_000);
          }
          break;
        }

        case "directive_fulfilled": {
          // Clear directive
          setAgentDirectives((p) => {
            const n = { ...p };
            delete n[event.agentId];
            return n;
          });
          // Add activity result to chat stream
          const fulfilledAgent = ALL_AGENTS.find((a) => a.id === event.agentId);
          addChatMessage({
            type: "activity",
            agentId: event.agentId,
            agentName: fulfilledAgent?.name || event.agentName,
            message: `${fulfilledAgent?.name || event.agentName} ${event.result}`,
            building: (event as { building?: string }).building,
            timestamp: Date.now(),
          });
          break;
        }
      }
    });

    return () => {
      unsub();
    };
  }, [elapsed, getAgentName, getAgentRole, addChatMessage, markAgentChatting]);

  return (
    <>
      {/* Top: Breaking-only ticker */}
      <div className="bg-black/60 backdrop-blur-sm border-b border-white/5 flex-shrink-0">
        <BreakingTicker items={newsItems} />
      </div>

      {/* Main row: left sidebar | canvas | right sidebar — all in flow */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: Building Nav */}
        <div className="w-44 bg-black/50 backdrop-blur-sm border-r border-white/5 p-2 overflow-y-auto hud-scroll hidden md:block flex-shrink-0">
          <BuildingNav
            activeBuilding={activeBuilding}
            onSelectBuilding={setActiveBuilding}
            agentLocations={agentLocations}
            activeAgents={activeAgents}
            agentDirectives={agentDirectives}
            recentBuildingActivity={recentBuildingActivity}
            onSelectAgent={setSelectedAgent}
          />
        </div>

        {/* Center: canvas (passed as children) + overlays */}
        <div className="flex-1 relative min-w-0">
          {children}

          {/* Breaking banner overlay — on canvas only */}
          <BreakingBanner items={newsItems} />

          {/* Agent Inspector overlay — on canvas only */}
          {selectedAgent && (
            <div className="absolute inset-0 z-10 pointer-events-none">
              <div className="pointer-events-auto">
                <AgentInspector
                  agent={selectedAgent}
                  location={agentLocations[selectedAgent.id] || "lounge"}
                  speeches={agentSpeeches[selectedAgent.id] || []}
                  onClose={() => setSelectedAgent(null)}
                />
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar: Room chat */}
        <div className="w-[576px] bg-[#13161e]/95 backdrop-blur-sm border-l border-white/5 hidden lg:flex flex-col flex-shrink-0">
          <ChatStream
            messages={chatMessages}
            activeBuilding={activeBuilding}
            agentCountAtBuilding={
              activeBuilding === "all"
                ? ALL_AGENTS.length
                : Object.values(agentLocations).filter((l) => l === activeBuilding).length
            }
          />
        </div>
      </div>
    </>
  );
}
