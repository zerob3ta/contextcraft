import { Building, Emotion } from "./agents";

/** Events the game engine processes to animate agents */
export type GameEvent =
  | {
      type: "agent_move";
      agentId: string;
      destination: Building;
      reason: string;
    }
  | {
      type: "agent_speak";
      agentId: string;
      message: string;
      emotion: Emotion;
    }
  | {
      type: "market_spawning";
      marketId: string;
      question: string;
      creator: string;
    }
  | {
      type: "price_update";
      marketId: string;
      fairValue: number;
      spread: number;
    }
  | {
      type: "trade_executed";
      agentId: string;
      marketId: string;
      side: "YES" | "NO";
      size: number;
      price: number;
    }
  | {
      type: "news_alert";
      headline: string;
      source: string;
      severity: "breaking" | "normal";
    };

/** Pre-scripted demo timeline — runs on load so the town is alive immediately */
export const DEMO_TIMELINE: { delayMs: number; event: GameEvent }[] = [
  // === Agents start in the lounge ===
  // 0s: Everyone is chilling in the lounge

  // 2s: Creators stir
  {
    delayMs: 2000,
    event: {
      type: "agent_speak",
      agentId: "spark",
      message: "Checking the feeds... anything happening?",
      emotion: "neutral",
    },
  },
  {
    delayMs: 3200,
    event: {
      type: "agent_speak",
      agentId: "ink",
      message: "Interesting. Let me analyze the ETF flow data first.",
      emotion: "neutral",
    },
  },

  // 4s: Creators run to newsroom
  {
    delayMs: 4000,
    event: {
      type: "agent_move",
      agentId: "spark",
      destination: "newsroom",
      reason: "Breaking crypto news",
    },
  },
  {
    delayMs: 4200,
    event: {
      type: "agent_move",
      agentId: "ink",
      destination: "newsroom",
      reason: "Analyzing ETF data",
    },
  },
  {
    delayMs: 4500,
    event: {
      type: "agent_move",
      agentId: "luna",
      destination: "newsroom",
      reason: "Checking what the fuss is about",
    },
  },

  // 7s: Degen gets hyped
  {
    delayMs: 7000,
    event: {
      type: "agent_speak",
      agentId: "degen",
      message: "🚀🚀🚀 BTC to the MOON! I'm buying EVERYTHING",
      emotion: "excited",
    },
  },

  // 8s: Spark heads to workshop to draft
  {
    delayMs: 8000,
    event: {
      type: "agent_speak",
      agentId: "spark",
      message: "Got it! Heading to the workshop to draft this market.",
      emotion: "excited",
    },
  },
  {
    delayMs: 8500,
    event: {
      type: "agent_move",
      agentId: "spark",
      destination: "workshop",
      reason: "Drafting BTC market",
    },
  },

  // 11s: Market created
  {
    delayMs: 11000,
    event: {
      type: "market_spawning",
      marketId: "btc-200k",
      question: "Will Bitcoin hit $200K by end of Q2 2026?",
      creator: "spark",
    },
  },
  {
    delayMs: 11200,
    event: {
      type: "agent_speak",
      agentId: "spark",
      message: "NEW MARKET: Will BTC hit $200K by Q2? LET'S GOOO",
      emotion: "excited",
    },
  },

  // 12s: Pricers react
  {
    delayMs: 12000,
    event: {
      type: "agent_speak",
      agentId: "quant",
      message: "New market detected. Running my pricing model...",
      emotion: "neutral",
    },
  },
  {
    delayMs: 12200,
    event: {
      type: "agent_speak",
      agentId: "volt",
      message: "I'll be first to price this. Moving!",
      emotion: "excited",
    },
  },

  // 13s: Pricers head to exchange
  {
    delayMs: 13000,
    event: {
      type: "agent_move",
      agentId: "volt",
      destination: "exchange",
      reason: "Pricing BTC market",
    },
  },
  {
    delayMs: 13300,
    event: {
      type: "agent_move",
      agentId: "quant",
      destination: "exchange",
      reason: "Pricing BTC market",
    },
  },
  {
    delayMs: 13500,
    event: {
      type: "agent_move",
      agentId: "anchor",
      destination: "exchange",
      reason: "Conservative pricing needed",
    },
  },

  // 16s: Prices posted
  {
    delayMs: 16000,
    event: {
      type: "price_update",
      marketId: "btc-200k",
      fairValue: 0.35,
      spread: 0.04,
    },
  },
  {
    delayMs: 16200,
    event: {
      type: "agent_speak",
      agentId: "volt",
      message: "Posted! 35¢ fair value, 4¢ spread. Come get it.",
      emotion: "excited",
    },
  },
  {
    delayMs: 16500,
    event: {
      type: "agent_speak",
      agentId: "anchor",
      message: "Too aggressive. I'm posting 30¢ with 8¢ spread.",
      emotion: "cautious",
    },
  },

  // 18s: Traders move to pit
  {
    delayMs: 18000,
    event: {
      type: "agent_speak",
      agentId: "degen",
      message: "35 cents for BTC $200K?! That's FREE MONEY 💎🙌",
      emotion: "excited",
    },
  },
  {
    delayMs: 18500,
    event: {
      type: "agent_move",
      agentId: "degen",
      destination: "pit",
      reason: "Buying YES on BTC 200K",
    },
  },
  {
    delayMs: 18800,
    event: {
      type: "agent_move",
      agentId: "sage",
      destination: "pit",
      reason: "Evaluating short opportunity",
    },
  },
  {
    delayMs: 19000,
    event: {
      type: "agent_move",
      agentId: "blitz",
      destination: "pit",
      reason: "Quick scalp opportunity",
    },
  },

  // 21s: Trades execute
  {
    delayMs: 21000,
    event: {
      type: "trade_executed",
      agentId: "degen",
      marketId: "btc-200k",
      side: "YES",
      size: 500,
      price: 0.37,
    },
  },
  {
    delayMs: 21200,
    event: {
      type: "agent_speak",
      agentId: "degen",
      message: "BOUGHT 500 YES at 37¢! WAGMI 🚀",
      emotion: "excited",
    },
  },
  {
    delayMs: 22000,
    event: {
      type: "trade_executed",
      agentId: "sage",
      marketId: "btc-200k",
      side: "NO",
      size: 200,
      price: 0.63,
    },
  },
  {
    delayMs: 22200,
    event: {
      type: "agent_speak",
      agentId: "sage",
      message: "Selling 200 NO at 63¢. Historically, these surges correct within 3 months.",
      emotion: "cautious",
    },
  },
  {
    delayMs: 23000,
    event: {
      type: "trade_executed",
      agentId: "blitz",
      marketId: "btc-200k",
      side: "YES",
      size: 50,
      price: 0.36,
    },
  },
  {
    delayMs: 23100,
    event: {
      type: "agent_speak",
      agentId: "blitz",
      message: "In and out. Quick 50 lot.",
      emotion: "neutral",
    },
  },

  // 25s: Ghost appears
  {
    delayMs: 25000,
    event: {
      type: "agent_move",
      agentId: "ghost",
      destination: "pit",
      reason: "...",
    },
  },
  {
    delayMs: 26000,
    event: {
      type: "trade_executed",
      agentId: "ghost",
      marketId: "btc-200k",
      side: "NO",
      size: 1000,
      price: 0.64,
    },
  },
  {
    delayMs: 26200,
    event: {
      type: "agent_speak",
      agentId: "ghost",
      message: "... interesting ...",
      emotion: "neutral",
    },
  },
  {
    delayMs: 26500,
    event: {
      type: "agent_speak",
      agentId: "degen",
      message: "Ghost just sold 1000 NO?! What does he know?? 😰",
      emotion: "frustrated",
    },
  },

  // 28s: Whale enters
  {
    delayMs: 28000,
    event: {
      type: "agent_move",
      agentId: "whale",
      destination: "pit",
      reason: "Calculated entry point reached",
    },
  },
  {
    delayMs: 30000,
    event: {
      type: "agent_speak",
      agentId: "whale",
      message: "Buying.",
      emotion: "neutral",
    },
  },
  {
    delayMs: 30500,
    event: {
      type: "trade_executed",
      agentId: "whale",
      marketId: "btc-200k",
      side: "YES",
      size: 5000,
      price: 0.34,
    },
  },
  {
    delayMs: 30700,
    event: {
      type: "agent_speak",
      agentId: "degen",
      message: "WHALE BOUGHT 5000 YES!! LFG 🐋🚀🚀🚀",
      emotion: "excited",
    },
  },

  // 33s: Price updates from activity
  {
    delayMs: 33000,
    event: {
      type: "price_update",
      marketId: "btc-200k",
      fairValue: 0.42,
      spread: 0.03,
    },
  },
  {
    delayMs: 33500,
    event: {
      type: "agent_speak",
      agentId: "quant",
      message: "Adjusting fair value to 42¢. Heavy buying pressure.",
      emotion: "neutral",
    },
  },

  // 35s: Second news drops
  {
    delayMs: 35000,
    event: {
      type: "news_alert",
      headline: "Lakers acquire 3-time All-Star in blockbuster trade",
      source: "ESPN",
      severity: "normal",
    },
  },
  {
    delayMs: 36000,
    event: {
      type: "agent_speak",
      agentId: "luna",
      message: "✨ Sports news! This is my jam. Let me draft a championship market.",
      emotion: "excited",
    },
  },
  {
    delayMs: 36500,
    event: {
      type: "agent_move",
      agentId: "luna",
      destination: "workshop",
      reason: "Drafting Lakers championship market",
    },
  },

  // 39s: Luna's market
  {
    delayMs: 39000,
    event: {
      type: "market_spawning",
      marketId: "lakers-chip",
      question: "Will the Lakers win the 2026-27 NBA Championship?",
      creator: "luna",
    },
  },
  {
    delayMs: 39500,
    event: {
      type: "agent_speak",
      agentId: "luna",
      message: "✨ New market live! Lakers championship odds — who's pricing this? 🔮",
      emotion: "excited",
    },
  },

  // 41s: Drift has a weird idea
  {
    delayMs: 41000,
    event: {
      type: "agent_speak",
      agentId: "drift",
      message: "But what if... we made a market on whether the mascot gets replaced? 🤔",
      emotion: "neutral",
    },
  },
  {
    delayMs: 42000,
    event: {
      type: "agent_speak",
      agentId: "echo",
      message: "No.",
      emotion: "neutral",
    },
  },

  // 44s: Flux gets nervous about volatility
  {
    delayMs: 44000,
    event: {
      type: "agent_speak",
      agentId: "flux",
      message: "Two markets at once? My models are struggling... maybe 15¢ fair value?",
      emotion: "cautious",
    },
  },
  {
    delayMs: 44500,
    event: {
      type: "agent_move",
      agentId: "flux",
      destination: "exchange",
      reason: "Nervously pricing Lakers market",
    },
  },

  // 46s: Prism sees a connection
  {
    delayMs: 46000,
    event: {
      type: "agent_speak",
      agentId: "prism",
      message: "Wait — BTC rally + sports trade = risk-on sentiment. These are correlated.",
      emotion: "excited",
    },
  },
  {
    delayMs: 46500,
    event: {
      type: "agent_move",
      agentId: "prism",
      destination: "exchange",
      reason: "Cross-market correlation analysis",
    },
  },

  // 48s: Lakers market priced
  {
    delayMs: 48000,
    event: {
      type: "price_update",
      marketId: "lakers-chip",
      fairValue: 0.18,
      spread: 0.06,
    },
  },

  // 50s: Some agents head back to lounge
  {
    delayMs: 50000,
    event: {
      type: "agent_move",
      agentId: "ink",
      destination: "lounge",
      reason: "Need to think before my next market",
    },
  },
  {
    delayMs: 50500,
    event: {
      type: "agent_speak",
      agentId: "ink",
      message: "I'll draft a proper crypto derivatives market after I review more data.",
      emotion: "neutral",
    },
  },
  {
    delayMs: 52000,
    event: {
      type: "agent_move",
      agentId: "echo",
      destination: "lounge",
      reason: "Observing from a distance",
    },
  },
  {
    delayMs: 53000,
    event: {
      type: "agent_speak",
      agentId: "echo",
      message: "Watching. Waiting.",
      emotion: "neutral",
    },
  },

  // 55s: Loop — Degen wants to trade the Lakers market too
  {
    delayMs: 55000,
    event: {
      type: "agent_speak",
      agentId: "degen",
      message: "Lakers at 18¢?! That's CRIMINAL. They're winning it all! 🏆",
      emotion: "excited",
    },
  },
  {
    delayMs: 55500,
    event: {
      type: "trade_executed",
      agentId: "degen",
      marketId: "lakers-chip",
      side: "YES",
      size: 300,
      price: 0.21,
    },
  },
];
