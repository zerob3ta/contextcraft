/**
 * Question classification for JIT base rate computation.
 * Two-tier: regex-first (~70-80% of markets), MiniMax fallback for the rest.
 */

import { callMinimax, parseJsonAction } from "../brain";

export type QuestionCategory =
  | "crypto_price"
  | "stock_price"
  | "sports_game"
  | "sports_futures"
  | "politics"
  | "weather"
  | "economic"
  | "other";

export interface ClassifiedQuestion {
  category: QuestionCategory;
  // Crypto/stock price fields
  asset?: string;
  symbol?: string;
  targetPrice?: number;
  direction?: "above" | "below";
  // Sports fields
  sport?: string;
  teamA?: string;
  teamB?: string;
  team?: string;
  seed?: number;
  // Politics fields
  isIncumbent?: boolean;
  // Weather fields
  region?: string;
  season?: string;
  phenomenon?: string;
  // Economic fields
  indicator?: string;
  threshold?: number;
}

// ── Regex-first classification ──

const CRYPTO_NAMES: Record<string, string> = {
  bitcoin: "btc", btc: "btc",
  ethereum: "eth", eth: "eth",
  solana: "sol", sol: "sol",
  dogecoin: "doge", doge: "doge",
  xrp: "xrp", ripple: "xrp",
  cardano: "ada", ada: "ada",
  avalanche: "avax", avax: "avax",
};

const STOCK_TICKERS = new Set([
  "aapl", "msft", "googl", "goog", "amzn", "meta", "tsla", "nvda", "amd",
  "nflx", "crm", "shop", "sq", "pypl", "uber", "abnb", "dash", "coin",
  "pltr", "rivn", "mara", "riot", "mstr", "snow", "dkng", "lcid", "sofi",
  "upst", "afrm", "spy", "qqq", "dia", "iwm", "jpm", "v", "ma",
]);

export function classifyQuestion(question: string): ClassifiedQuestion | null {
  const q = question.toLowerCase();

  // ── Crypto price ──
  const cryptoMatch = q.match(
    /will\s+(?:the\s+)?(?:price\s+of\s+)?(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|ripple|cardano|ada|avalanche|avax)\s+(?:price\s+)?(reach|hit|exceed|surpass|drop|fall|decline|go\s+(?:above|below|over|under)).*?\$?([\d,]+(?:\.\d+)?)/i
  );
  if (cryptoMatch) {
    const asset = CRYPTO_NAMES[cryptoMatch[1].toLowerCase()] || cryptoMatch[1].toLowerCase();
    const verb = cryptoMatch[2].toLowerCase();
    const direction = /drop|fall|decline|below|under/.test(verb) ? "below" : "above";
    const targetPrice = parseFloat(cryptoMatch[3].replace(/,/g, ""));
    if (targetPrice > 0) {
      return { category: "crypto_price", asset, targetPrice, direction };
    }
  }

  // Also match "$120K" style
  const cryptoK = q.match(
    /will\s+(?:the\s+)?(?:price\s+of\s+)?(bitcoin|btc|ethereum|eth|solana|sol)\s+(?:price\s+)?(reach|hit|exceed|drop|fall|go\s+(?:above|below)).*?\$?([\d,]+(?:\.\d+)?)\s*k/i
  );
  if (cryptoK) {
    const asset = CRYPTO_NAMES[cryptoK[1].toLowerCase()] || cryptoK[1].toLowerCase();
    const verb = cryptoK[2].toLowerCase();
    const direction = /drop|fall|below/.test(verb) ? "below" : "above";
    const targetPrice = parseFloat(cryptoK[3].replace(/,/g, "")) * 1000;
    if (targetPrice > 0) {
      return { category: "crypto_price", asset, targetPrice, direction };
    }
  }

  // ── Sports game ──
  const gameMatch = q.match(
    /will\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+(beat|win\s+against|defeat|cover|win\s+over)\s+(?:the\s+)?(\w+(?:\s+\w+)?)/i
  );
  if (gameMatch) {
    return {
      category: "sports_game",
      teamA: gameMatch[1].trim(),
      teamB: gameMatch[3].trim(),
    };
  }

  // ── Sports futures ──
  const futuresMatch = q.match(
    /will\s+(?:the\s+)?(.+?)\s+win\s+(?:the\s+)?(super bowl|world series|stanley cup|nba (?:finals|championship|title)|ncaa tournament|march madness|championship|title|pennant)/i
  );
  if (futuresMatch) {
    const team = futuresMatch[1].trim();
    const event = futuresMatch[2].toLowerCase();
    let sport: string | undefined;
    if (event.includes("super bowl")) sport = "nfl";
    else if (event.includes("world series") || event.includes("pennant")) sport = "mlb";
    else if (event.includes("stanley cup")) sport = "nhl";
    else if (event.includes("nba")) sport = "nba";
    else if (event.includes("ncaa") || event.includes("march madness")) sport = "ncaab";
    return { category: "sports_futures", team, sport };
  }

  // ── Politics ──
  if (/will\s+.*(tariff|sanction|executive order|bill\s|rate\s+cut|rate\s+hike|impeach|elect|veto|sign\s+into\s+law)/i.test(q)) {
    const isIncumbent = /trump|biden|president/i.test(q);
    return { category: "politics", isIncumbent };
  }

  // ── Weather ──
  if (/will\s+.*(rain|snow|hurricane|tornado|blizzard|flood|drought|heat\s+wave)/i.test(q)) {
    let phenomenon: string = "other";
    if (/snow|blizzard/i.test(q)) phenomenon = "snow";
    else if (/rain|flood/i.test(q)) phenomenon = "rain";
    else if (/hurricane/i.test(q)) phenomenon = "hurricane";
    else if (/tornado/i.test(q)) phenomenon = "tornado";

    let region: string | undefined;
    if (/new york|boston|chicago|detroit|minneapolis|milwaukee/i.test(q)) region = "northern";
    else if (/dc|washington|philadelphia|baltimore|pittsburgh/i.test(q)) region = "mid_atlantic";
    else if (/miami|atlanta|dallas|houston|phoenix|tampa|orlando/i.test(q)) region = "southern";

    const month = new Date().getMonth();
    let season: string;
    if (month >= 11 || month <= 2) season = "winter";
    else if (month >= 5 && month <= 8) season = "summer";
    else season = "spring_fall";

    return { category: "weather", phenomenon, region, season };
  }

  // ── Economic ──
  if (/will\s+.*(cpi|inflation|gdp|unemployment|fed\s+funds|interest\s+rate|treasury|consumer\s+sentiment)/i.test(q)) {
    let indicator: string = "other";
    if (/cpi|inflation/i.test(q)) indicator = "cpi";
    else if (/gdp/i.test(q)) indicator = "gdp";
    else if (/unemployment/i.test(q)) indicator = "unemployment";
    else if (/fed\s+funds|interest\s+rate/i.test(q)) indicator = "fed_funds";
    else if (/treasury/i.test(q)) indicator = "treasury_10y";
    else if (/consumer\s+sentiment/i.test(q)) indicator = "consumer_sentiment";
    return { category: "economic", indicator };
  }

  // No regex match — return null so caller can try MiniMax fallback
  return null;
}

/**
 * MiniMax fallback classifier — short prompt for unmatched questions.
 * ~200 tokens total.
 */
export async function classifyWithLLM(question: string): Promise<ClassifiedQuestion> {
  try {
    const system = `Classify this prediction market question into ONE category. Respond with JSON only.
Categories: crypto_price, stock_price, sports_game, sports_futures, politics, weather, economic, other
Include relevant params: asset/symbol, targetPrice, direction(above/below), teamA/teamB, sport, team, seed, isIncumbent, phenomenon, indicator.`;

    const response = await callMinimax(system, question);
    const parsed = parseJsonAction(response) as ClassifiedQuestion | null;
    if (parsed?.category) return parsed;
  } catch {
    // Fall through
  }
  return { category: "other" };
}
