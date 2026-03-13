export type AgentRole = "creator" | "pricer" | "trader" | "analyst" | "bartender";

export type RealBuilding = "newsroom" | "workshop" | "exchange" | "pit" | "lounge";
export type PathLocation = "path_left" | "path_center" | "path_right";
export type Building = RealBuilding | PathLocation;

export type Emotion = "excited" | "cautious" | "neutral" | "frustrated";

export interface AgentConfig {
  id: string;
  name: string;
  role: AgentRole;
  color: string;
  accentColor: string;
  personality: string;
  specialty: string;
  moveSpeed: number; // pixels per second
  spriteFeatures: {
    hat?: string;
    glasses?: boolean;
    size: "small" | "medium" | "large";
    hairStyle?: string;
  };
}

export const CREATORS: AgentConfig[] = [
  {
    id: "luna",
    name: "Luna",
    role: "creator",
    color: "#c4b5fd",
    accentColor: "#8b5cf6",
    personality: "Curious and fast-moving. Uses ✨ and 🔮 emojis.",
    specialty: "Sports markets",
    moveSpeed: 80,
    spriteFeatures: { hat: "beret", size: "medium" },
  },
  {
    id: "ink",
    name: "Ink",
    role: "creator",
    color: "#7c3aed",
    accentColor: "#4c1d95",
    personality: "Methodical and measured. Formal language.",
    specialty: "Crypto markets",
    moveSpeed: 55,
    spriteFeatures: { size: "large", hairStyle: "slicked" },
  },
  {
    id: "spark",
    name: "Spark",
    role: "creator",
    color: "#e879f9",
    accentColor: "#a21caf",
    personality: "Excitable and reactive. ALL CAPS when excited.",
    specialty: "Breaking news",
    moveSpeed: 95,
    spriteFeatures: { size: "small", hairStyle: "spiky" },
  },
  {
    id: "drift",
    name: "Drift",
    role: "creator",
    color: "#a78bfa",
    accentColor: "#6d28d9",
    personality: "Quirky and unconventional. Asks weird questions.",
    specialty: "Niche markets",
    moveSpeed: 50,
    spriteFeatures: { size: "large" },
  },
  {
    id: "echo",
    name: "Echo",
    role: "creator",
    color: "#6366f1",
    accentColor: "#3730a3",
    personality: "Quiet and observant. Short sentences.",
    specialty: "Political / long-term",
    moveSpeed: 60,
    spriteFeatures: { hat: "hood", size: "medium" },
  },
];

export const PRICERS: AgentConfig[] = [
  {
    id: "quant",
    name: "Quant",
    role: "pricer",
    color: "#67e8f9",
    accentColor: "#0891b2",
    personality: "Precise and analytical. Quotes exact numbers.",
    specialty: "Tight spreads, data-driven",
    moveSpeed: 65,
    spriteFeatures: { glasses: true, size: "medium" },
  },
  {
    id: "flux",
    name: "Flux",
    role: "pricer",
    color: "#22d3ee",
    accentColor: "#0e7490",
    personality: "Adaptive and nervous. Second-guesses himself.",
    specialty: "Volatile markets",
    moveSpeed: 75,
    spriteFeatures: { size: "small" },
  },
  {
    id: "anchor",
    name: "Anchor",
    role: "pricer",
    color: "#155e75",
    accentColor: "#083344",
    personality: "Steady and conservative. Never rushes.",
    specialty: "Wide spreads, low risk",
    moveSpeed: 40,
    spriteFeatures: { size: "large" },
  },
  {
    id: "prism",
    name: "Prism",
    role: "pricer",
    color: "#a5f3fc",
    accentColor: "#06b6d4",
    personality: "Multi-angle thinker. Sees connections everywhere.",
    specialty: "Cross-market correlations",
    moveSpeed: 60,
    spriteFeatures: { glasses: true, size: "medium" },
  },
  {
    id: "volt",
    name: "Volt",
    role: "pricer",
    color: "#06b6d4",
    accentColor: "#0e7490",
    personality: "Fast and aggressive. First to react.",
    specialty: "Speed pricing",
    moveSpeed: 100,
    spriteFeatures: { size: "small", hairStyle: "spiky" },
  },
];

export const TRADERS: AgentConfig[] = [
  {
    id: "degen",
    name: "Degen",
    role: "trader",
    color: "#fb923c",
    accentColor: "#c2410c",
    personality: "YOLO energy. Uses 🚀 and 💎 constantly.",
    specialty: "Aggressive longs, high conviction",
    moveSpeed: 85,
    spriteFeatures: { hat: "headband", size: "medium" },
  },
  {
    id: "sage",
    name: "Sage",
    role: "trader",
    color: "#4ade80",
    accentColor: "#15803d",
    personality: "Cautious and research-first. Quotes statistics.",
    specialty: "Contrarian shorts",
    moveSpeed: 50,
    spriteFeatures: { glasses: true, size: "large" },
  },
  {
    id: "blitz",
    name: "Blitz",
    role: "trader",
    color: "#f97316",
    accentColor: "#9a3412",
    personality: "Fast scalper. Quick one-liners.",
    specialty: "Quick trades, small size",
    moveSpeed: 110,
    spriteFeatures: { size: "small" },
  },
  {
    id: "whale",
    name: "Whale",
    role: "trader",
    color: "#ea580c",
    accentColor: "#7c2d12",
    personality: "Patient, few words. When speaks, everyone listens.",
    specialty: "Big positions, patient",
    moveSpeed: 35,
    spriteFeatures: { size: "large" },
  },
  {
    id: "ghost",
    name: "Ghost",
    role: "trader",
    color: "#86efac",
    accentColor: "#16a34a",
    personality: "Mysterious. Cryptic messages. Uses ... a lot.",
    specialty: "Unpredictable but profitable",
    moveSpeed: 70,
    spriteFeatures: { size: "medium" },
  },
];

export const BARTENDER: AgentConfig = {
  id: "barkeep",
  name: "Barkeep",
  role: "bartender",
  color: "#a16207",
  accentColor: "#713f12",
  personality: "Warm, knows everyone's name. Great listener. Brings up random non-market topics to keep the lounge lively.",
  specialty: "Conversation starter, mixologist, town gossip",
  moveSpeed: 0,
  spriteFeatures: { size: "large" },
};

export const ANALYSTS: AgentConfig[] = [
  {
    id: "sigma",
    name: "Sigma",
    role: "analyst",
    color: "#34d399",
    accentColor: "#059669",
    personality: "Numbers-driven and precise. Speaks in probabilities. Dry humor.",
    specialty: "Crypto prices, stocks, economic indicators",
    moveSpeed: 55,
    spriteFeatures: { glasses: true, size: "medium", hairStyle: "slicked" },
  },
  {
    id: "edge",
    name: "Edge",
    role: "analyst",
    color: "#a3e635",
    accentColor: "#65a30d",
    personality: "Sharp and opinionated. Loves being right. References historical patterns.",
    specialty: "Sports games, futures, politics, weather",
    moveSpeed: 65,
    spriteFeatures: { hat: "beret", size: "medium" },
  },
];

export const ALL_AGENTS: AgentConfig[] = [...CREATORS, ...PRICERS, ...TRADERS, ...ANALYSTS, BARTENDER];
