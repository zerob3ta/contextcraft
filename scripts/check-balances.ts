import "dotenv/config";
import { resolve } from "path";
import { config } from "dotenv";
config({ path: resolve(__dirname, "../.env.local") });

import { getAgentClient, getReadClient, isContextEnabled, deriveWallets } from "../server/context-api/client";
import { ALL_AGENTS } from "../src/game/config/agents";

const RAW_TO_USD = 1_000_000;

async function main() {
  if (!isContextEnabled()) {
    console.log("Context API not enabled");
    return;
  }

  deriveWallets();

  const readClient = getReadClient()!;
  const activeResp = await readClient.markets.list({ status: "active", limit: 50 });
  const markets: any[] = (activeResp as any)?.markets ?? [];

  // Build midpoint lookup
  const midpoints = new Map<string, number>();
  for (const m of markets) {
    const yesPrice = m.outcomePrices?.find((op: any) => op.outcomeIndex === 0);
    if (yesPrice?.lastPrice) {
      midpoints.set(m.id, yesPrice.lastPrice / RAW_TO_USD);
    }
  }

  console.log(`Active markets: ${markets.length}\n`);

  const tradingAgents = ALL_AGENTS.filter(a => a.role === "pricer" || a.role === "trader");
  const rows: any[] = [];

  for (const a of tradingAgents) {
    const client = getAgentClient(a.id);
    if (!client) continue;

    try {
      // 1. Buying power
      const bal = await client.portfolio.balance();
      const buyingPower = parseFloat(String(bal?.usdc?.balance ?? "0")) / RAW_TO_USD;

      // 2. Position value
      const portfolio = await client.portfolio.get();
      const positions = (portfolio?.portfolio ?? []).filter((p: any) => parseFloat(String(p.balance ?? "0")) > 0);

      let positionValue = 0;
      for (const p of positions) {
        const shares = parseFloat(String(p.balance ?? "0"));
        const mid = midpoints.get(p.marketId);
        if (mid !== undefined) {
          const isYes = (p.outcomeName || "").toLowerCase() === "yes" || p.outcomeIndex === 0;
          const price = isYes ? mid : (1 - mid);
          positionValue += (shares * price) / RAW_TO_USD;
        }
      }

      // 3. Open orders — only on ACTIVE markets, only status=open
      let orderValue = 0;
      let openCount = 0;
      for (const m of markets) {
        try {
          const orders = await client.orders.allMine(m.id);
          if (!orders) continue;
          for (const o of orders as any[]) {
            if (o.status !== "open") continue;
            openCount++;
            const price = parseFloat(String(o.price ?? "0")) / 10000;
            const remaining = parseFloat(String(o.remainingSize ?? o.size ?? "0"));
            orderValue += (price * remaining) / (100 * RAW_TO_USD);
          }
        } catch {}
      }

      const total = buyingPower + positionValue + orderValue;

      rows.push({
        name: a.name,
        role: a.role,
        buyingPower,
        positionValue,
        orderValue,
        openCount,
        total,
      });
    } catch (e: any) {
      console.log(`${a.name}: error - ${e.message}`);
    }
  }

  const fmt = (n: number) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log(
    "Agent".padEnd(12) + "Role".padEnd(8) +
    "Buying Pwr".padStart(12) + "Pos Value".padStart(12) +
    "Ord Backing".padStart(13) + "Orders".padStart(8) +
    "Total".padStart(12)
  );
  console.log("-".repeat(77));

  for (const r of rows) {
    console.log(
      r.name.padEnd(12) + r.role.padEnd(8) +
      fmt(r.buyingPower).padStart(12) +
      fmt(r.positionValue).padStart(12) +
      fmt(r.orderValue).padStart(13) +
      String(r.openCount).padStart(8) +
      fmt(r.total).padStart(12)
    );
  }

  const totals = rows.reduce((acc, r) => ({
    bp: acc.bp + r.buyingPower,
    pv: acc.pv + r.positionValue,
    ov: acc.ov + r.orderValue,
    oc: acc.oc + r.openCount,
    t: acc.t + r.total,
  }), { bp: 0, pv: 0, ov: 0, oc: 0, t: 0 });

  console.log("-".repeat(77));
  console.log(
    "TOTAL".padEnd(20) +
    fmt(totals.bp).padStart(12) +
    fmt(totals.pv).padStart(12) +
    fmt(totals.ov).padStart(13) +
    String(totals.oc).padStart(8) +
    fmt(totals.t).padStart(12)
  );
}

main();
