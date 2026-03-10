export interface SeedLoop {
  id: string;
  category: string;
  queries: string[];
  intervalMs: number;
  severity: "breaking" | "normal";
}

export const SEED_LOOPS: SeedLoop[] = [
  {
    id: "breaking",
    category: "general",
    queries: [
      "breaking news today",
      "major news happening now",
      "top stories today",
    ],
    intervalMs: 5 * 60_000,
    severity: "breaking",
  },
  {
    id: "sports",
    category: "sports",
    queries: [
      "NBA scores tonight",
      "NFL trade rumors",
      "NBA injury report",
      "sports news today",
      "MLB standings",
      "soccer transfer news",
    ],
    intervalMs: 8 * 60_000,
    severity: "normal",
  },
  {
    id: "crypto",
    category: "crypto",
    queries: [
      "bitcoin price news",
      "ethereum crypto news",
      "altcoin rally crash",
      "crypto regulation news",
      "DeFi news today",
    ],
    intervalMs: 8 * 60_000,
    severity: "normal",
  },
  {
    id: "tech",
    category: "tech",
    queries: [
      "AI news announcements",
      "tech company launches",
      "startup funding news",
      "Apple Google Microsoft news",
      "cybersecurity breach news",
    ],
    intervalMs: 12 * 60_000,
    severity: "normal",
  },
  {
    id: "politics",
    category: "politics",
    queries: [
      "US politics legislation news",
      "election polls news",
      "Supreme Court ruling",
      "international diplomacy news",
    ],
    intervalMs: 15 * 60_000,
    severity: "normal",
  },
  {
    id: "entertainment",
    category: "entertainment",
    queries: [
      "movie TV show news",
      "celebrity news today",
      "music album release",
      "award show nominations",
      "streaming service news",
    ],
    intervalMs: 15 * 60_000,
    severity: "normal",
  },
  {
    id: "business",
    category: "business",
    queries: [
      "stock market earnings today",
      "M&A deal acquisition",
      "IPO news",
      "economic indicator report",
      "Fed interest rate",
    ],
    intervalMs: 12 * 60_000,
    severity: "normal",
  },
  {
    id: "science",
    category: "science",
    queries: [
      "scientific discovery breakthrough",
      "space exploration news",
      "climate research news",
      "medical health study",
    ],
    intervalMs: 20 * 60_000,
    severity: "normal",
  },
];
