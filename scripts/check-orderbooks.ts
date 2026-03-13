import { ContextClient } from "@contextwtf/sdk";
import { mnemonicToAccount } from "viem/accounts";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const apiKey = process.env.CONTEXT_API_KEY || "";
const mnemonic = process.env.AGENT_MNEMONIC || "";

// Quant = index 5
const account = mnemonicToAccount(mnemonic, { addressIndex: 5 });
const pk = ("0x" + Buffer.from(account.getHdKey().privateKey!).toString("hex")) as `0x${string}`;
const quantClient = new ContextClient({ apiKey, signer: { privateKey: pk } });
const readClient = new ContextClient({ apiKey });

async function main() {
  // Check ALL pricer wallets, not just quant
  const pricerIndices = [5, 6, 7, 8, 9]; // quant, flux, anchor, prism, volt
  const pricerNames = ["quant", "flux", "anchor", "prism", "volt"];
  const pricerClients = pricerIndices.map((idx) => {
    const acc = mnemonicToAccount(mnemonic, { addressIndex: idx });
    const key = ("0x" + Buffer.from(acc.getHdKey().privateKey!).toString("hex")) as `0x${string}`;
    return new ContextClient({ apiKey, signer: { privateKey: key } });
  });

  const res = await readClient.markets.list({ status: "active", limit: 3, sortBy: "new" }) as any;
  const active = res.markets || [];
  console.log(`\nFound ${active.length} active markets`);

  for (const m of active) {
    const q = (m.question || m.id).slice(0, 60);
    console.log(`\n=== ${q} ===`);
    console.log(`  Market ID: ${m.id}`);

    // Check orderbook
    const ob = await readClient.markets.orderbook(m.id);
    const bids = ob?.bids || [];
    const asks = ob?.asks || [];
    console.log(`  Orderbook — Bids: ${bids.length}, Asks: ${asks.length}`);
    for (const b of bids.slice(0, 6)) console.log(`    BID: ${b.price}¢ x${b.size}`);
    for (const a of asks.slice(0, 6)) console.log(`    ASK: ${a.price}¢ x${a.size}`);

    // Check ALL pricers' orders on this market — only recent (last 5 min)
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    for (let i = 0; i < pricerClients.length; i++) {
      try {
        const orders = await pricerClients[i].orders.allMine(m.id);
        const recent = orders.filter((o: any) => o.insertedAt > cutoff);
        if (recent.length === 0) continue;
        const open = recent.filter((o: any) => o.status === "open");
        const voided = recent.filter((o: any) => o.status === "voided");
        const voidReasons: Record<string, number> = {};
        for (const o of voided) { const r = (o as any).voidReason || "?"; voidReasons[r] = (voidReasons[r] || 0) + 1; }
        console.log(`  ${pricerNames[i]}: ${recent.length} recent (${open.length} open, ${voided.length} voided${voided.length > 0 ? " — " + JSON.stringify(voidReasons) : ""})`);
        for (const o of open) {
          const side = o.side === 0 ? "buy" : "sell";
          console.log(`    OPEN: outcome=${o.outcomeIndex} ${side} ${o.price}¢ x${o.size}`);
        }
      } catch {}
    }
  }
}
main().catch(console.error);
