import type { Building, AgentRole } from "../src/game/config/agents";
import { ALL_AGENTS } from "../src/game/config/agents";

// ─── News ───

export interface NewsItem {
  id: string;
  headline: string;
  snippet: string;
  source: string;
  category: string;
  timestamp: number;
  link?: string;
}

// ─── Markets ───

export interface Market {
  id: string;
  question: string;
  creator: string;
  fairValue: number | null;
  spread: number | null;
  trackingQuery: string | null;
  createdAt: number;
  trades: { agentId: string; side: "YES" | "NO"; size: number; price: number; ts: number }[];
  // Context Markets API integration
  apiMarketId: string | null; // real hex UUID from Context API
  isExternal: boolean; // true = discovered from testnet, false = created by our agents
  apiUrl: string | null;
}

// ─── Agent State ───

export interface AgentOpenOrder {
  nonce: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  marketId: string;
}

export interface AgentPosition {
  marketId: string;
  outcome: string;
  size: number;
  avgPrice: number;
}

export interface AgentState {
  id: string;
  name: string;
  role: AgentRole;
  personality: string;
  specialty: string;
  location: Building;
  lastActionAt: number;
  lastSpoke: string;
  cooldownUntil: number;
  directive: string | null;       // current action item from conversation
  directiveUntil: number;         // when directive expires
  // Context Markets wallet
  walletAddress?: string;
  usdcBalance?: number;
  positions?: AgentPosition[];
  openOrders?: AgentOpenOrder[];
}

// ─── Global State ───

class ServerState {
  agents: Map<string, AgentState> = new Map();
  markets: Map<string, Market> = new Map();
  newsBuffer: NewsItem[] = [];
  seenHeadlines: Set<string> = new Set();
  eventHistory: { type: string; ts: number; data: unknown }[] = [];

  // Social context — recent speeches and actions for agent-to-agent interaction
  recentSpeeches: { agentId: string; message: string; ts: number }[] = [];
  recentActions: { agentId: string; action: string; detail: string; ts: number }[] = [];

  // Conversation insights (legacy, used by job prompts)
  conversationInsights: Map<string, { insight: string; ts: number }[]> = new Map();
  lastMarketCreatedAt = 0; // global cooldown for market creation

  // Rejection feedback for creators (LLM learning)
  recentRejections: { agentId: string; question: string; reason: string; ts: number }[] = [];

  // Reverse lookup: apiMarketId → local market id
  private apiMarketIdMap: Map<string, string> = new Map();

  addSpeech(agentId: string, message: string): void {
    this.recentSpeeches.unshift({ agentId, message, ts: Date.now() });
    if (this.recentSpeeches.length > 20) this.recentSpeeches.length = 20;
  }

  addAction(agentId: string, action: string, detail: string): void {
    this.recentActions.unshift({ agentId, action, detail, ts: Date.now() });
    if (this.recentActions.length > 20) this.recentActions.length = 20;
  }

  getAgentsAtLocation(location: string): AgentState[] {
    return Array.from(this.agents.values()).filter((a) => a.location === location);
  }

  getRecentSocialContext(limit = 10): string[] {
    const lines: string[] = [];
    const cutoff = Date.now() - 2 * 60_000; // last 2 min
    for (const s of this.recentSpeeches.slice(0, limit)) {
      if (s.ts < cutoff) break;
      const agent = this.agents.get(s.agentId);
      const ago = Math.round((Date.now() - s.ts) / 1000);
      lines.push(`${agent?.name || s.agentId} said: "${s.message}" (${ago}s ago)`);
    }
    for (const a of this.recentActions.slice(0, 5)) {
      if (a.ts < cutoff) break;
      const agent = this.agents.get(a.agentId);
      lines.push(`${agent?.name || a.agentId} ${a.action}: ${a.detail}`);
    }
    return lines;
  }

  // Live data from signal loops (used by agent brains for context)
  sportsSlate: Array<{ id: string; league: string; shortName: string; homeTeam: string; awayTeam: string; homeScore: number | null; awayScore: number | null; status: string; statusDetail: string; startTime: string; spread: number | null; overUnder: number | null }> = [];
  liveScores: Array<{ id: string; league: string; shortName: string; homeTeam: string; awayTeam: string; homeScore: number | null; awayScore: number | null; status: string; statusDetail: string; startTime: string }> = [];
  cryptoPrices: Array<{ id: string; symbol: string; name: string; price: number; change24h: number; marketCap: number }> = [];

  private nextMarketId = 1;

  constructor() {
    const roleLocations: Record<string, Building> = {
      creator: "newsroom",
      pricer: "exchange",
      trader: "pit",
    };

    for (const cfg of ALL_AGENTS) {
      this.agents.set(cfg.id, {
        id: cfg.id,
        name: cfg.name,
        role: cfg.role,
        personality: cfg.personality,
        specialty: cfg.specialty,
        location: roleLocations[cfg.role] || "lounge",
        lastActionAt: 0,
        lastSpoke: "",
        cooldownUntil: 0,
        directive: null,
        directiveUntil: 0,
      });
    }
  }

  // ── News ──

  addNews(item: Omit<NewsItem, "id" | "timestamp">): NewsItem | null {
    const key = item.headline.toLowerCase().trim();
    if (this.seenHeadlines.has(key)) return null;

    // Fuzzy dedup — check word overlap against recent headlines (only very close matches)
    const words = new Set(key.replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
    if (words.size >= 4) {
      for (const existing of this.newsBuffer.slice(0, 20)) {
        const eWords = new Set(existing.headline.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
        const overlap = [...words].filter((w) => eWords.has(w)).length;
        if (overlap / Math.max(words.size, eWords.size) > 0.65) return null;
      }
    }

    this.seenHeadlines.add(key);

    const newsItem: NewsItem = {
      ...item,
      id: `news-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    };
    this.newsBuffer.unshift(newsItem);
    if (this.newsBuffer.length > 100) this.newsBuffer.length = 100;
    return newsItem;
  }

  getRecentNews(limit = 15): NewsItem[] {
    return this.newsBuffer.slice(0, limit);
  }

  getMarketNews(marketId: string): NewsItem[] {
    const market = this.markets.get(marketId);
    if (!market) return [];
    // Return news tagged for this market's tracking query
    return this.newsBuffer.filter(
      (n) => n.category === `market:${marketId}`
    ).slice(0, 5);
  }

  // ── Markets ──

  createMarket(question: string, creator: string): Market {
    const id = `M${this.nextMarketId++}`;
    const market: Market = {
      id,
      question,
      creator,
      fairValue: null,
      spread: null,
      trackingQuery: null,
      createdAt: Date.now(),
      trades: [],
      apiMarketId: null,
      isExternal: false,
      apiUrl: null,
    };
    this.markets.set(id, market);
    return market;
  }

  createMarketWithApiId(question: string, creator: string, apiMarketId: string): Market {
    const market = this.createMarket(question, creator);
    market.apiMarketId = apiMarketId;
    this.apiMarketIdMap.set(apiMarketId, market.id);
    return market;
  }

  addExternalMarket(info: { apiMarketId: string; question: string; fairValue: number | null }): string | null {
    if (this.apiMarketIdMap.has(info.apiMarketId)) return null;

    const id = `M${this.nextMarketId++}`;
    const market: Market = {
      id,
      question: info.question,
      creator: "external",
      fairValue: info.fairValue,
      spread: null,
      trackingQuery: null,
      createdAt: Date.now(),
      trades: [],
      apiMarketId: info.apiMarketId,
      isExternal: true,
      apiUrl: null,
    };
    this.markets.set(id, market);
    this.apiMarketIdMap.set(info.apiMarketId, id);
    return id;
  }

  getMarketByApiId(apiMarketId: string): Market | undefined {
    const localId = this.apiMarketIdMap.get(apiMarketId);
    return localId ? this.markets.get(localId) : undefined;
  }

  /** Get local market ID for a given API market ID */
  getLocalMarketId(apiMarketId: string): string | undefined {
    return this.apiMarketIdMap.get(apiMarketId);
  }

  addRejection(agentId: string, question: string, reason: string): void {
    this.recentRejections.unshift({ agentId, question, reason, ts: Date.now() });
    if (this.recentRejections.length > 10) this.recentRejections.length = 10;
  }

  getRecentRejections(agentId: string, limit = 3): { question: string; reason: string }[] {
    return this.recentRejections
      .filter((r) => r.agentId === agentId && Date.now() - r.ts < 30 * 60_000) // last 30 min
      .slice(0, limit)
      .map(({ question, reason }) => ({ question, reason }));
  }

  getActiveMarkets(): Market[] {
    return Array.from(this.markets.values());
  }

  getUnpricedMarkets(): Market[] {
    return this.getActiveMarkets().filter((m) => m.fairValue === null);
  }

  getPricedMarkets(): Market[] {
    return this.getActiveMarkets().filter((m) => m.fairValue !== null);
  }

  updatePrice(marketId: string, fairValue: number, spread: number): void {
    const m = this.markets.get(marketId);
    if (m) {
      m.fairValue = Math.max(0.01, Math.min(0.99, fairValue));
      m.spread = Math.max(0.02, Math.min(0.15, spread));
    }
  }

  addTrade(marketId: string, agentId: string, side: "YES" | "NO", size: number, price: number): void {
    const m = this.markets.get(marketId);
    if (m) {
      m.trades.push({ agentId, side, size, price, ts: Date.now() });
    }
  }

  // ── Agent ──

  moveAgent(agentId: string, destination: Building): void {
    const a = this.agents.get(agentId);
    if (a) a.location = destination;
  }

  setAgentCooldown(agentId: string, ms: number): void {
    const a = this.agents.get(agentId);
    if (a) a.cooldownUntil = Date.now() + ms;
  }

  // ── Conversation insights ──

  addConversationInsight(agentId: string, insight: string): void {
    if (!this.conversationInsights.has(agentId)) {
      this.conversationInsights.set(agentId, []);
    }
    const insights = this.conversationInsights.get(agentId)!;
    insights.unshift({ insight, ts: Date.now() });
    if (insights.length > 5) insights.length = 5;
  }

  getConversationInsights(agentId: string, limit = 3): { insight: string; ts: number }[] {
    const insights = this.conversationInsights.get(agentId) || [];
    const cutoff = Date.now() - 10 * 60_000; // last 10 min
    return insights.filter((i) => i.ts > cutoff).slice(0, limit);
  }

  // ── Dedup helpers ──

  isDuplicateMarket(question: string): boolean {
    const norm = question.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    const words = new Set(norm.split(/\s+/));

    // Extract team names for sports dedup (catches "Rockets beat Nuggets" vs "Rockets cover +6.5 vs Nuggets")
    const teamPattern = /(?:rockets|nuggets|lakers|celtics|cavaliers|cavs|magic|knicks|jazz|warriors|clippers|wolves|timberwolves|raptors|pelicans|hawks|heat|bucks|76ers|sixers|nets|pacers|pistons|spurs|suns|kings|grizzlies|thunder|blazers|hornets|bulls|mavericks|mavs|rangers|capitals|flyers|bruins|panthers|penguins|lightning|maple leafs|oilers|flames|canadiens|senators|devils|islanders|sabres|red wings|blue jackets|wild|kraken|predators|avalanche|stars|blackhawks|ducks|sharks|coyotes|jets|hurricanes)/g;
    const teamsA = new Set(norm.match(teamPattern) || []);

    for (const m of this.markets.values()) {
      const mNorm = m.question.toLowerCase().replace(/[^a-z0-9\s]/g, "");
      const mWords = new Set(mNorm.split(/\s+/));

      // Word overlap check (original)
      const overlap = [...words].filter((w) => mWords.has(w)).length;
      const similarity = overlap / Math.max(words.size, mWords.size);
      if (similarity > 0.7) return true;

      // Team-based dedup: if same 2+ teams mentioned, likely same game
      if (teamsA.size >= 2) {
        const teamsB = new Set(mNorm.match(teamPattern) || []);
        const teamOverlap = [...teamsA].filter((t) => teamsB.has(t)).length;
        if (teamOverlap >= 2) return true;
      }
    }
    return false;
  }
}

export const state = new ServerState();
