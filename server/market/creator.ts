import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

const MARKET_DRAFT_PROMPT = `You are a prediction market question writer. Given a topic, write ONE concise prediction market question. You MUST always output a question — never explain, refuse, or caveat.

RULES:
- Output ONLY the question ending with "?" — no other text, no explanations
- 6-15 words, concise, ends with "?"
- Specific: include team names, numbers, dates, thresholds
- For tonight's games: ask about winner, spread, total points, player props
- For news: ask about future outcomes related to the news
- If a game is today, it's valid to ask about the outcome — these are prediction markets

BANNED: follower, likes, views, retweets, engagement, viral, trending, popular, backlash, memes, video, audio, podcast, clips

EXAMPLES:
- "Will Lakers beat Celtics tonight?"
- "Will BTC hit $200K by Q2 2026?"
- "Will Iran close Strait of Hormuz by April?"
- "Will Grizzlies cover -3.5 spread vs 76ers?"

Output ONLY the question. Nothing else.`;

/**
 * Draft a market question using Claude.
 * Returns the question string, or null if drafting fails.
 */
export async function draftMarket(
  topic: string,
  newsContext: string
): Promise<string | null> {
  try {
    const anthropic = getClient();

    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      system: MARKET_DRAFT_PROMPT,
      messages: [
        {
          role: "user",
          content: `Today's date: ${new Date().toISOString().split("T")[0]}\n\nTopic: ${topic}\n\nRecent news context:\n${newsContext}`,
        },
      ],
    });

    const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : null;
    if (!text) {
      console.log("[Creator] Claude returned no text content");
      return null;
    }

    // Basic validation
    if (!text.endsWith("?")) {
      console.log(`[Creator] Draft rejected (no ?): "${text.slice(0, 80)}"`);
      return null;
    }
    if (text.length < 10 || text.length > 200) {
      console.log(`[Creator] Draft rejected (length ${text.length}): "${text.slice(0, 80)}"`);
      return null;
    }

    console.log(`[Creator] Drafted: "${text}"`);
    return text;
  } catch (err) {
    console.error("[Creator] Claude draft error:", err);
    return null;
  }
}
