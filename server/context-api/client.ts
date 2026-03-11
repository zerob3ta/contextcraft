/**
 * Context Markets SDK client management.
 * Derives wallets from a single mnemonic, creates ContextClient per agent.
 */

import { ContextClient } from "@contextwtf/sdk";
import { mnemonicToAccount } from "viem/accounts";
import { ALL_AGENTS } from "../../src/game/config/agents";
import type { AgentWallet } from "./types";

// ── Wallet derivation ──

const wallets = new Map<string, AgentWallet>();
const clients = new Map<string, ContextClient>();

/** Read-only client (no signer) for shared queries */
let readClient: ContextClient | null = null;

function getApiKey(): string {
  return process.env.CONTEXT_API_KEY || "";
}

function getMnemonic(): string {
  return process.env.AGENT_MNEMONIC || "";
}

/**
 * Derive HD wallets from the mnemonic for all agents.
 * Uses BIP-44 derivation: m/44'/60'/0'/0/{index}
 */
export function deriveWallets(): AgentWallet[] {
  const mnemonic = getMnemonic();
  if (!mnemonic) {
    console.warn("[Context] No AGENT_MNEMONIC — wallet derivation skipped");
    return [];
  }

  const derived: AgentWallet[] = [];
  for (let i = 0; i < ALL_AGENTS.length; i++) {
    const agent = ALL_AGENTS[i];
    const account = mnemonicToAccount(mnemonic, { addressIndex: i });
    const wallet: AgentWallet = {
      agentId: agent.id,
      address: account.address,
      privateKey: `0x${Buffer.from(account.getHdKey().privateKey!).toString("hex")}`,
      walletIndex: i,
    };
    wallets.set(agent.id, wallet);
    derived.push(wallet);
  }

  console.log(`[Context] Derived ${derived.length} wallets from mnemonic`);
  for (const w of derived) {
    console.log(`  ${w.agentId}: ${w.address}`);
  }

  return derived;
}

/**
 * Get the wallet for an agent.
 */
export function getWallet(agentId: string): AgentWallet | undefined {
  return wallets.get(agentId);
}

/**
 * Get or create a ContextClient with signing capability for a specific agent.
 * Used for trading (pricers + traders).
 */
export function getAgentClient(agentId: string): ContextClient | null {
  const existing = clients.get(agentId);
  if (existing) return existing;

  const wallet = wallets.get(agentId);
  if (!wallet) return null;

  const apiKey = getApiKey();
  if (!apiKey) return null;

  const client = new ContextClient({
    apiKey,
    signer: { privateKey: wallet.privateKey as `0x${string}` },
  });
  clients.set(agentId, client);
  return client;
}

/**
 * Get a read-only ContextClient (no signer) for market queries.
 */
export function getReadClient(): ContextClient | null {
  if (readClient) return readClient;

  const apiKey = getApiKey();
  if (!apiKey) return null;

  readClient = new ContextClient({ apiKey });
  return readClient;
}

/**
 * Direct fetch to Context API for endpoints not covered by SDK (e.g., agent-submit).
 */
export async function contextApiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; data: T }> {
  const base = process.env.CONTEXT_API_URL || "https://api-testnet.context.markets/v2";
  const url = `${base.replace(/\/$/, "")}${path}`;
  const apiKey = getApiKey();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data: data as T };
}

/**
 * Check if Context Markets integration is configured.
 */
export function isContextEnabled(): boolean {
  return !!getApiKey() && !!getMnemonic();
}
