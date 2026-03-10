import { callMinimax } from "../agents/brain";

/**
 * Given an interesting headline, generate 1-2 follow-up search queries
 * to dig deeper into the story.
 */
export async function generateFollowUpQueries(headline: string): Promise<string[]> {
  try {
    const response = await callMinimax(
      "You generate concise Google search queries to find more context about news headlines. Return a JSON array of 1-2 search query strings. Only output the JSON array, nothing else.",
      `Generate follow-up search queries for this headline: "${headline}"`,
    );

    const parsed = parseJsonArray(response);
    return parsed.filter((q): q is string => typeof q === "string").slice(0, 2);
  } catch (err) {
    console.error("[Reactive] Failed to generate follow-up queries:", err);
    return [];
  }
}

/**
 * Simple heuristic: does this headline have enough "market potential"
 * to warrant follow-up queries? (~30% of headlines should trigger this.)
 */
export function hasMarketPotential(headline: string): boolean {
  const h = headline.toLowerCase();

  // Contains numbers (prices, dates, scores, etc.)
  if (/\d+/.test(h)) return true;

  // Forward-looking language
  const forwardWords = ["will", "expected", "plans to", "set to", "could", "may", "announces", "launches", "unveils", "proposes", "files"];
  if (forwardWords.some((w) => h.includes(w))) return true;

  // Named entities (capitalized words beyond first word)
  const caps = headline.match(/\b[A-Z][a-z]{2,}\b/g);
  if (caps && caps.length >= 2) return true;

  return false;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const result = JSON.parse(text);
    if (Array.isArray(result)) return result;
  } catch {
    // Try extracting from code block
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { /* ignore */ }
    }
  }
  return [];
}
