/**
 * One-time wallet setup: gasless operator approval + USDC minting.
 * Runs on server boot before the scheduler starts.
 */

import { deriveWallets, getAgentClient, isContextEnabled } from "./client";
import { state } from "../state";
import { ALL_AGENTS } from "../../src/game/config/agents";

const USDC_PER_TRADING_AGENT = 10_000; // $10k each
const MINT_AMOUNT = 10_000; // max per mint call
const MIN_BALANCE_FOR_TOPUP = 2_000; // auto-mint when below this
const TOPUP_INTERVAL_MS = 60_000; // check balances every 60s

let topupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize all agent wallets: derive keys, gasless setup, mint USDC.
 * Call this once before starting the scheduler.
 */
export async function initializeWallets(): Promise<void> {
  if (!isContextEnabled()) {
    console.log("[Context Setup] Skipping — no CONTEXT_API_KEY or AGENT_MNEMONIC");
    return;
  }

  console.log("[Context Setup] Initializing agent wallets...");

  // 1. Derive wallets from mnemonic
  const walletInfos = deriveWallets();
  if (walletInfos.length === 0) return;

  // 2. Store wallet addresses in agent state
  for (const w of walletInfos) {
    const agent = state.agents.get(w.agentId);
    if (agent) {
      agent.walletAddress = w.address;
    }
  }

  // 3. Set up wallets for trading agents (pricers + traders)
  const tradingAgents = ALL_AGENTS.filter((a) => a.role === "pricer" || a.role === "trader");

  for (const agentCfg of tradingAgents) {
    const client = getAgentClient(agentCfg.id);
    if (!client) continue;

    try {
      // Gasless operator approval (no ETH needed)
      console.log(`[Context Setup] ${agentCfg.id}: gasless setup...`);
      await client.account.gaslessSetup();
      console.log(`[Context Setup] ${agentCfg.id}: operator approved`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Already approved is fine
      if (msg.includes("already") || msg.includes("approved")) {
        console.log(`[Context Setup] ${agentCfg.id}: already approved`);
      } else {
        console.error(`[Context Setup] ${agentCfg.id}: gasless setup failed:`, msg);
      }
    }

    try {
      // Check balance and mint if needed
      const balance = await client.portfolio.balance();
      const usdcBalance = parseFloat(String(balance?.usdc?.balance ?? "0"));
      console.log(`[Context Setup] ${agentCfg.id}: balance = $${usdcBalance}`);

      if (usdcBalance < USDC_PER_TRADING_AGENT) {
        const needed = USDC_PER_TRADING_AGENT - usdcBalance;
        const mintCalls = Math.ceil(needed / MINT_AMOUNT);
        console.log(`[Context Setup] ${agentCfg.id}: minting ${mintCalls}x $${MINT_AMOUNT}...`);

        for (let i = 0; i < mintCalls; i++) {
          try {
            await client.account.mintTestUsdc(MINT_AMOUNT);
            console.log(`[Context Setup] ${agentCfg.id}: minted $${MINT_AMOUNT} (${i + 1}/${mintCalls})`);
          } catch (mintErr) {
            console.error(`[Context Setup] ${agentCfg.id}: mint failed:`, mintErr);
            break; // Don't keep trying if minting fails
          }
        }

        // Wait for mint tx to confirm, then deposit into trading contract
        await new Promise((r) => setTimeout(r, 5_000));
        try {
          const afterMint = await client.portfolio.balance();
          const walletUsdc = parseFloat(String(afterMint?.usdc?.balance ?? "0"));
          if (walletUsdc > 0) {
            await client.account.gaslessDeposit(walletUsdc);
            console.log(`[Context Setup] ${agentCfg.id}: deposited $${walletUsdc}`);
          } else {
            console.log(`[Context Setup] ${agentCfg.id}: mint not yet confirmed, deposit will happen via topup loop`);
          }
        } catch (depositErr) {
          console.error(`[Context Setup] ${agentCfg.id}: deposit failed:`, depositErr);
        }
      }

      // Update state with final balance
      const finalBalance = await client.portfolio.balance();
      const agent = state.agents.get(agentCfg.id);
      if (agent) {
        agent.usdcBalance = parseFloat(String(finalBalance?.usdc?.balance ?? "0"));
      }
    } catch (err) {
      console.error(`[Context Setup] ${agentCfg.id}: balance check failed:`, err);
    }
  }

  // 4. Also initialize clients for creators (they need to query markets, not trade)
  for (const agentCfg of ALL_AGENTS.filter((a) => a.role === "creator")) {
    getAgentClient(agentCfg.id); // pre-create client
  }

  console.log("[Context Setup] Wallet initialization complete");

  // 5. Start background balance top-up loop
  startTopupLoop();
}

/**
 * Background loop: check balances and auto-mint when low.
 */
function startTopupLoop(): void {
  topupTimer = setInterval(async () => {
    const tradingAgents = ALL_AGENTS.filter((a) => a.role === "pricer" || a.role === "trader");

    for (const agentCfg of tradingAgents) {
      const client = getAgentClient(agentCfg.id);
      if (!client) continue;

      try {
        const balance = await client.portfolio.balance();
        const usdcBalance = parseFloat(String(balance?.usdc?.balance ?? "0"));
        const agent = state.agents.get(agentCfg.id);
        if (agent) agent.usdcBalance = usdcBalance;

        if (usdcBalance < MIN_BALANCE_FOR_TOPUP) {
          console.log(`[Context Topup] ${agentCfg.id}: $${usdcBalance} < $${MIN_BALANCE_FOR_TOPUP}, minting...`);
          try {
            await client.account.mintTestUsdc(MINT_AMOUNT);
            await client.account.gaslessDeposit(MINT_AMOUNT);
            console.log(`[Context Topup] ${agentCfg.id}: minted + deposited $${MINT_AMOUNT}`);
          } catch (err) {
            console.error(`[Context Topup] ${agentCfg.id}: mint/deposit failed:`, err);
          }
        }
      } catch {
        // Balance check failed — skip this cycle
      }
    }
  }, TOPUP_INTERVAL_MS);
}

export function stopTopupLoop(): void {
  if (topupTimer) {
    clearInterval(topupTimer);
    topupTimer = null;
  }
}
