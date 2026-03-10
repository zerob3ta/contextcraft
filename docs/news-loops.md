# News Loops — Final Config

## Loops

| # | ID | Category | Method | Source | Interval | Severity | Extract | Notes |
|---|-----|----------|--------|--------|----------|----------|---------|-------|
| 1 | `espn-daily-slate` | Sports | api | ESPN Scoreboard + Odds API | Daily (morning) | normal | Today's NBA, NCAAB, NHL games with spreads, O/U, matchups | Goal: creators make markets, pricers price, traders trade |
| 2 | `espn-live-scores` | Sports | api | ESPN Scoreboard | 15m (in-game) | normal/breaking | Live score updates for active games | Breaking for: finals, upsets in progress |
| 3 | `espn-headlines` | Sports | firecrawl | espn.com | 22m | breaking | Top 5 breaking sports headlines not previously reported | Filter by breaking |
| 4 | `drudge` | News | firecrawl | drudgereport.com | 1h | breaking | Front page headlines | Quality gate |
| 5 | `cnn-breaking` | News | x-api | @cnnbrk | 30m | breaking | Latest breaking news posts | |
| 6 | `crypto-prices` | Crypto | api | CoinGecko | 15m | — | Major coin prices, fed to agents in background | No headlines, context only |
| 7 | `crypto-news` | Crypto | firecrawl | coingecko.com/en/news | 1h | breaking | Top 3-5 stories, dedupe, quality filter | |
| 8 | `finance-x` | Stocks | x-api | @unusual_whales, @DeItaone, @financialjuice | 15m | breaking | Breaking market-moving alerts from all 3 feeds | Sort + filter |
| 9 | `cnn-culture` | Culture | firecrawl | cnn.com/entertainment | 1h | breaking | 1-3 headlines | Quality gate |
| 10 | `vulture` | Culture | firecrawl | vulture.com | 1h | breaking | 1-3 headlines | Quality gate |
| 11 | `ew` | Culture | firecrawl | ew.com | 1h | breaking | 1-3 headlines | Quality gate |
| 12 | `weather` | Weather | firecrawl | weather.com | 6h | breaking | Breaking weather events | Quality gate |
| 13 | `hackernews` | Tech | firecrawl | news.ycombinator.com | 1h | breaking | Top breaking tech news | |
| 14 | `techmeme` | Tech | firecrawl | techmeme.com | 1h | breaking | Top breaking tech news | |

## News Lifecycle

```
BREAKING → (5 min) → ACTIVE → (30 min) → STALE → (removed)
```

| State | Banner | Ticker | Right Rail |
|-------|--------|--------|------------|
| Breaking | Yes (5s fade) | Yes (slow scroll) | Top, bright |
| Active | No | Yes | Normal weight |
| Stale | No | No | Dimmed |

## Quality Gate

MiniMax call between raw fetch and frontend:
- Dedup against recent headlines
- Is this genuinely new information?
- Clean 1-line headline (concise, no clickbait)
- Assign severity (breaking vs normal)
- Drop anything below the bar

## Env Vars Needed

```
MINIMAX_API_KEY=...       # Agent brains + quality gate
ANTHROPIC_API_KEY=...     # Market creation
SERPER_API_KEY=...        # Fallback search
FIRECRAWL_API_KEY=...     # Page scraping (8 loops)
X_BEARER_TOKEN=...        # Twitter/X API (2 loops)
ODDS_API_KEY=...          # Vegas lines (loop 1)
```
