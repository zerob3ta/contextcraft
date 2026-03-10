import { callMinimax } from "../agents/brain";
import { state } from "../state";

export interface GatedHeadline {
  headline: string;
  severity: "breaking" | "normal";
  category: string;
}

const GATE_SYSTEM_PROMPT = `You are a news editor for a prediction market town. Given raw news content, extract genuinely newsworthy headlines.

RULES:
- Each headline must be concise (under 80 chars), factual, no clickbait
- Only include genuinely NEW information — skip rehashes, listicles, opinion pieces
- Assign severity: "breaking" for first reports of major events, big price moves, game results. "normal" for routine updates.
- Return a JSON array of objects: [{"headline": "...", "severity": "breaking"|"normal"}]
- Return an EMPTY array [] if nothing is newsworthy
- Max 3 headlines per batch
- Skip: TV schedules, "watch live", generic roundups, ads, subscription prompts
- Skip headlines that reference old dates or are clearly not from today
- Only extract headlines about events happening TODAY or very recently`;

/**
 * Pass raw content through the quality gate.
 * Returns 0-3 clean, deduplicated headlines.
 */
export async function qualityGate(
  rawContent: string,
  category: string,
  context?: string
): Promise<GatedHeadline[]> {
  try {
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const userPrompt = context
      ? `Today's date: ${today}\nCategory: ${category}\nContext: ${context}\n\nRaw content:\n${rawContent.slice(0, 3000)}`
      : `Today's date: ${today}\nCategory: ${category}\n\nRaw content:\n${rawContent.slice(0, 3000)}`;

    const response = await callMinimax(GATE_SYSTEM_PROMPT, userPrompt);

    const parsed = parseJsonArray(response);
    const headlines: GatedHeadline[] = [];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const headline = String(obj.headline || "").trim();
      if (!headline || headline.length < 15) continue;

      // Dedup against recent news
      if (isDuplicate(headline)) continue;

      headlines.push({
        headline,
        severity: obj.severity === "breaking" ? "breaking" : "normal",
        category,
      });
    }

    return headlines.slice(0, 3);
  } catch (err) {
    console.error("[QualityGate] Error:", err);
    return [];
  }
}

/**
 * Simple headline for structured data (scores, prices) that doesn't need LLM gating.
 */
export function directHeadline(
  headline: string,
  category: string,
  severity: "breaking" | "normal"
): GatedHeadline | null {
  if (isDuplicate(headline)) return null;
  return { headline, severity, category };
}

function isDuplicate(headline: string): boolean {
  const norm = headline.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const words = new Set(norm.split(/\s+/).filter(Boolean));
  if (words.size < 3) return false;

  for (const existing of state.newsBuffer.slice(0, 50)) {
    const eNorm = existing.headline.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    const eWords = new Set(eNorm.split(/\s+/).filter(Boolean));
    const overlap = [...words].filter((w) => eWords.has(w)).length;
    const similarity = overlap / Math.max(words.size, eWords.size);
    if (similarity > 0.45) return true;
  }
  return false;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const result = JSON.parse(text);
    if (Array.isArray(result)) return result;
  } catch { /* continue */ }

  const match = text.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* continue */ }
  }
  return [];
}
