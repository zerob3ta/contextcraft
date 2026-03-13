const MINIMAX_API_URL = "https://api.minimax.io/anthropic/v1/messages";

/**
 * Call MiniMax M2.5 via Anthropic-compatible API. Returns raw text response.
 */
export async function callMinimax(
  systemPrompt: string,
  userPrompt: string,
  retries = 1
): Promise<string> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error("MINIMAX_API_KEY not set");
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(MINIMAX_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "MiniMax-M2.5",
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          temperature: 0.8,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`MiniMax ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const content = data.content as { type: string; text?: string }[] | undefined;
      if (!content || !Array.isArray(content)) {
        throw new Error("No content array in MiniMax response");
      }

      // MiniMax M2.5 returns thinking + text blocks; grab the text block
      const textBlock = content.find((c) => c.type === "text");
      if (textBlock?.text) {
        return textBlock.text.trim();
      }

      // Fallback: sometimes only thinking block exists, extract from it
      const thinkingBlock = content.find((c) => c.type === "thinking") as { text?: string } | undefined;
      if (thinkingBlock?.text) {
        return thinkingBlock.text.trim();
      }

      // Debug: log what we actually got
      console.warn("[Brain] Empty response content:", JSON.stringify(content).slice(0, 200));
      console.warn("[Brain] Full response keys:", Object.keys(data).join(", "));
      console.warn("[Brain] stop_reason:", data.stop_reason);
      throw new Error("No text or thinking block in MiniMax response");
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[Brain] Retry ${attempt + 1} after error:`, err);
        await sleep(2000);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Unreachable");
}

/**
 * Parse a JSON action from LLM response. Handles code blocks and malformed JSON.
 */
export function parseJsonAction(text: string): unknown {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Try extracting from code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch { /* continue */ }
  }

  // Try finding first complete JSON object by matching balanced braces
  const startIdx = text.indexOf("{");
  if (startIdx >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") { depth--; if (depth === 0) {
        try { return JSON.parse(text.slice(startIdx, i + 1)); } catch { /* continue */ }
        break;
      }}
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
