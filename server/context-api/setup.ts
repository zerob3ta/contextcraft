/**
 * One-time wallet setup: gasless operator approval + USDC minting.
 * Runs on server boot before the scheduler starts.
 */

import { deriveWallets, getAgentClient, isContextEnabled } from "./client";
import { state } from "../state";
import { ALL_AGENTS } from "../../src/game/config/agents";
import { cancelOrders } from "./trading";

const USDC_PER_TRADING_AGENT = 10_000; // $10,000 each (whole USDC)
const MINT_AMOUNT = 10_000; // max $10,000 per mint call
const MIN_BALANCE_FOR_TOPUP = 2_000; // auto-mint when below $2,000
const TOPUP_INTERVAL_MS = 60_000; // check balances every 60s

let topupTimer: ReturnType<typeof setInterval> | null = null;
let _setupComplete = false;
export function isSetupComplete(): boolean { return _setupComplete; }

/**
 * Reset all agents: cancel all open orders, clear local state, mint fresh USDC.
 * Runs BEFORE initializeWallets() on server boot for a clean slate.
 */
export async function resetAllAgents(): Promise<void> {
  if (!isContextEnabled()) return;

  console.log("[Context Reset] Cancelling all open orders and topping up wallets...");

  const tradingAgents = ALL_AGENTS.filter((a) => a.role === "pricer" || a.role === "trader");

  for (const agentCfg of tradingAgents) {
    const client = getAgentClient(agentCfg.id);
    if (!client) continue;

    // Cancel all orders across all active markets
    const activeMarkets = state.getActiveMarkets();
    for (const market of activeMarkets) {
      if (!market.apiMarketId) continue;
      try {
        const orders = await client.orders.allMine(market.apiMarketId);
        const openNonces = orders
          .filter((o) => o.status === "open")
          .map((o) => o.nonce as `0x${string}`);

        if (openNonces.length > 0) {
          // Batch cancel in groups of 20
          for (let i = 0; i < openNonces.length; i += 20) {
            const batch = openNonces.slice(i, i + 20);
            await client.orders.bulkCancel(batch);
          }
          console.log(`[Context Reset] ${agentCfg.id}: cancelled ${openNonces.length} orders on ${market.id}`);
        }
      } catch (err) {
        // Continue even if cancel fails for one market
        console.error(`[Context Reset] ${agentCfg.id}: cancel failed on ${market.id}:`, err);
      }
    }

    // Clear local open orders
    const agent = state.agents.get(agentCfg.id);
    if (agent) {
      agent.openOrders = [];
    }

    // Mint fresh USDC and deposit into settlement
    try {
      await client.account.mintTestUsdc(MINT_AMOUNT);
      console.log(`[Context Reset] ${agentCfg.id}: minted $${MINT_AMOUNT}`);
      // Wait for mint tx to confirm on-chain
      await new Promise((r) => setTimeout(r, 8_000));
      // Deposit whatever is in the wallet (mint may not match exact amount)
      const bal = await client.portfolio.balance();
      const walletBal = parseFloat(String(bal?.usdc?.walletBalance ?? "0"));
      if (walletBal > 0) {
        const depositAmount = walletBal / 1e6; // convert micro-USDC to whole USDC for gaslessDeposit
        await client.account.gaslessDeposit(depositAmount);
        console.log(`[Context Reset] ${agentCfg.id}: deposited $${depositAmount}`);
      } else {
        console.log(`[Context Reset] ${agentCfg.id}: wallet balance is 0 — mint may not have confirmed yet`);
      }
    } catch (err) {
      console.error(`[Context Reset] ${agentCfg.id}: mint/deposit failed:`, err);
    }
  }

  console.log("[Context Reset] All agents reset");
}

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

  // 3. Set up wallets for trading agents (pricers + traders, skip bartender)
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
      const usdcBalanceRaw = parseFloat(String(balance?.usdc?.balance ?? "0"));
      const usdcBalance = usdcBalanceRaw / 1e6; // convert micro-USDC (6 decimals) to whole USDC
      console.log(`[Context Setup] ${agentCfg.id}: balance = $${usdcBalance.toFixed(2)} (raw: ${usdcBalanceRaw})`);

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

        // Wait for mint tx to confirm on-chain, then deposit
        await new Promise((r) => setTimeout(r, 8_000));
        try {
          const afterMint = await client.portfolio.balance();
          const walletUsdc = parseFloat(String(afterMint?.usdc?.walletBalance ?? "0"));
          if (walletUsdc > 0) {
            const depositAmount = walletUsdc / 1e6; // micro-USDC → whole USDC
            await client.account.gaslessDeposit(depositAmount);
            console.log(`[Context Setup] ${agentCfg.id}: deposited $${depositAmount}`);
          } else {
            console.log(`[Context Setup] ${agentCfg.id}: mint not yet confirmed, deposit will happen via topup loop`);
          }
        } catch (depositErr) {
          console.error(`[Context Setup] ${agentCfg.id}: deposit failed:`, depositErr);
        }
      }

      // Update state with final balance (convert micro-USDC to whole)
      const finalBalance = await client.portfolio.balance();
      const agent = state.agents.get(agentCfg.id);
      if (agent) {
        const rawBal = parseFloat(String(finalBalance?.usdc?.balance ?? "0"));
        agent.usdcBalance = rawBal / 1e6;
        console.log(`[Context Setup] ${agentCfg.id}: state.usdcBalance = $${agent.usdcBalance.toFixed(2)} (raw: ${rawBal})`);
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
  _setupComplete = true;

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
        const usdcBalanceRaw = parseFloat(String(balance?.usdc?.balance ?? "0"));
        const usdcBalance = usdcBalanceRaw / 1e6; // convert micro-USDC to whole USDC
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
