/** CoinGecko API fetcher — free tier, no auth */

const CG_BASE = "https://api.coingecko.com/api/v3";

export interface CryptoPrice {
  id: string;
  symbol: string;
  name: string;
  price: number;
  change24h: number;       // percentage
  marketCap: number;
}

const TOP_COINS = [
  "bitcoin", "ethereum", "solana", "cardano", "dogecoin",
  "avalanche-2", "chainlink", "polkadot", "polygon-ecosystem-token", "litecoin",
];

export async function fetchCryptoPrices(): Promise<CryptoPrice[]> {
  try {
    const ids = TOP_COINS.join(",");
    const url = `${CG_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`[CoinGecko] ${res.status}: ${await res.text()}`);
      return [];
    }

    const data: Array<{
      id: string;
      symbol: string;
      name: string;
      current_price: number;
      price_change_percentage_24h: number;
      market_cap: number;
    }> = await res.json();

    return data.map((c) => ({
      id: c.id,
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      price: c.current_price,
      change24h: c.price_change_percentage_24h || 0,
      marketCap: c.market_cap,
    }));
  } catch (err) {
    console.error("[CoinGecko] Error:", err);
    return [];
  }
}
