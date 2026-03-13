/**
 * Analyst job runner — computes deterministic odds using the JIT pricing engine,
 * then adds a short LLM-generated summary. One market per tick.
 */

import { state, type AnalystOdds } from "../state";
import { broadcast } from "../ws-bridge";
import { callMinimax, parseJsonAction } from "./brain";
import { computeOdds } from "./jit/compute";

/** Which categories each analyst covers */
const ANALYST_SPECIALTIES: Record<string, Set<string>> = {
  sigma: new Set(["crypto_price", "stock_price", "economic"]),
  edge: new Set(["sports_game", "sports_futures", "politics", "weather"]),
};

// Track which markets are currently being analyzed to prevent both analysts picking the same one
const inProgress = new Set<string>();

/**
 * Run one analyst job: pick highest-priority market, compute odds, publish.
 * Analysts cover ALL markets — specialty determines priority, not eligibility.
 * Analyzes up to 3 markets per call to chew through backlogs faster.
 */
export async function runAnalystJob(agentId: string): Promise<void> {
  const agent = state.agents.get(agentId);
  if (!agent || agent.role !== "analyst") return;

  const allNeeding = state.getMarketsNeedingAnalysis();
  if (allNeeding.length === 0) return;

  // Filter out markets another analyst is currently working on
  const available = allNeeding.filter((m) => !inProgress.has(m.id));
  const unanalyzed = available.filter((m) => !m.analystOdds);
  const stale = available.filter((m) => m.analystOdds);

  // Batch: analyze up to 3 markets per tick to clear backlogs faster
  const batch = [...unanalyzed, ...stale].slice(0, 3);
  if (batch.length === 0) return;

  for (const market of batch) {
    inProgress.add(market.id);
    try {
      const result = await computeOdds(market.question, market.deadline);

      // Skip LLM summary for low-confidence/other — just use the method string
      const isSimple = result.confidence === "low" || result.category === "other";
      const summary = isSimple
        ? result.method.slice(0, 200)
        : await generateSummary(agent.name, agent.specialty, market.question, result.probability, result.confidence, result.method);

      const odds: AnalystOdds = {
        probability: result.probability,
        confidence: result.confidence,
        method: result.method,
        category: result.category,
        summary,
        analystId: agentId,
        computedAt: Date.now(),
      };

      state.updateAnalystOdds(market.id, odds);

      broadcast({
        type: "analyst_report",
        agentId,
        agentName: agent.name,
        marketId: market.id,
        question: market.question,
        probability: result.probability,
        confidence: result.confidence,
        summary,
        building: agent.location,
      });

      const shortQ = market.question.replace(/^Will\s+/i, "").replace(/\?$/, "").slice(0, 70);
      state.addAction(agentId, "analyzed", `${shortQ} at ${result.probability}% (${result.confidence})`);
      console.log(`[Analyst:${agent.name}] analyzed ${market.id} → ${result.probability}% (${result.confidence}) [${result.category}]`);
    } catch (err) {
      console.error(`[Analyst:${agent.name}] Error analyzing ${market.id}:`, err);
    } finally {
      inProgress.delete(market.id);
    }
  }
}

/**
 * Generate a 1-sentence qualitative summary. This is the ONLY LLM call per analyst job.
 */
async function generateSummary(
  name: string,
  specialty: string,
  question: string,
  probability: number,
  confidence: string,
  method: string,
): Promise<string> {
  try {
    const system = `You are ${name}, a ${specialty} analyst. Write ONE sentence explaining your probability estimate. Be concise and specific. No JSON — just the sentence.`;
    const user = `Market: ${question}\nEstimate: ${probability}% (${confidence})\nMethod: ${method}`;

    const response = await callMinimax(system, user);
    // Take first sentence, strip quotes
    const clean = response.replace(/^["']|["']$/g, "").trim();
    const firstSentence = clean.split(/[.!]\s/)[0];
    return (firstSentence + ".").slice(0, 200);
  } catch {
    return `${probability}% based on ${method.slice(0, 100)}`;
  }
}
