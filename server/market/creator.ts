import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export interface MarketDraft {
  question: string;
  shortQuestion: string;
  resolutionCriteria: string;
  evidenceMode: "social_only" | "web_enabled";
  sources: string[];
  endTimeHours: number;
}

const MARKET_DRAFT_PROMPT = `You are a prediction market designer for Context Markets. Given a topic, design a complete market.

You MUST respond with a JSON object. No other text.

{
  "question": "Will [specific event] by [deadline]?",
  "shortQuestion": "Short version for display (under 100 chars)",
  "resolutionCriteria": "This market resolves YES if [precise condition]. This market resolves NO if the market end time passes without the condition being met.\\n\\nEvidence sources: [specific X handles or source types].\\n\\nClarifications:\\n- [edge case 1]\\n- [edge case 2]",
  "evidenceMode": "web_enabled or social_only",
  "sources": ["@handle1", "@handle2"],
  "endTimeHours": 24
}

RULES:
- question: Start with "Will...", 6-20 words, specific and measurable, ends with "?"
- shortQuestion: Condensed display version, under 100 characters
- resolutionCriteria: Be VERY specific. Name exact sources. Handle edge cases (cancellation, postponement, partial outcomes). The oracle uses ONLY your criteria to resolve.
- evidenceMode: Use "social_only" when X/Twitter accounts reliably cover it. Use "web_enabled" when official websites, scores, or data feeds are needed.
- sources: X handles (@ESPN, @Reuters, etc.) that will post about this. Max 5.
- endTimeHours: Hours from now. Sports tonight = 8. News events = 24-72. Policy/geopolitical = 48-168. Give buffer for evidence to appear AFTER the event.

SOURCE GUIDE:
- Sports: @ESPN, @SportsCenter, @NBA, @NFL, @NHL
- Crypto: @CoinDesk, @CoinGecko, @whale_alert
- Politics/News: @AP, @Reuters, @business, @WSJ
- Tech: @TechCrunch, @veraborisova, @Reuters
- Finance: @FederalReserve, @business, @unusual_whales

RESOLUTION CRITERIA EXAMPLES:

Sports: "This market resolves YES if the Lakers defeat the Celtics in tonight's game (final score including overtime). Evidence: Official @NBA posts, ESPN box score, or reporting from major sports outlets. If the game is postponed beyond the market end time, this resolves NO."

Crypto: "This market resolves YES if Bitcoin's spot price on CoinGecko exceeds $200,000 at any point before end time. Evidence: @CoinGecko or CoinGecko.com showing BTC/USD above $200,000. Brief wicks count."

Geopolitical: "This market resolves YES if [specific official action] is announced via official channels before end time. Evidence: Posts from [official accounts] on X, or reporting from Reuters/AP. A rumor or leak does not count as an announcement."

BANNED topics: follower counts, likes, views, retweets, engagement, viral, trending, memes

JSON only.`;

/**
 * Draft a complete market using Claude.
 * Returns a structured MarketDraft, or falls back to question-only.
 */
export async function draftMarket(
  topic: string,
  newsContext: string
): Promise<MarketDraft | string | null> {
  try {
    const anthropic = getClient();

    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: MARKET_DRAFT_PROMPT,
      messages: [
        {
          role: "user",
          content: `Today: ${new Date().toISOString().split("T")[0]}\n\nTopic: ${topic}\n\nNews:\n${newsContext}`,
        },
      ],
    });

    const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : null;
    if (!text) {
      console.log("[Creator] Claude returned no text content");
      return null;
    }

    // Try to parse as structured JSON
    try {
      const parsed = JSON.parse(text);
      if (parsed.question && parsed.resolutionCriteria) {
        const draft: MarketDraft = {
          question: parsed.question,
          shortQuestion: parsed.shortQuestion || parsed.question.slice(0, 100),
          resolutionCriteria: parsed.resolutionCriteria,
          evidenceMode: parsed.evidenceMode === "social_only" ? "social_only" : "web_enabled",
          sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 5) : [],
          endTimeHours: Math.max(4, Math.min(168, Number(parsed.endTimeHours) || 24)),
        };

        if (!draft.question.endsWith("?") || draft.question.length < 10) {
          console.log(`[Creator] Draft rejected (invalid question): "${draft.question.slice(0, 80)}"`);
          return null;
        }

        console.log(`[Creator] Drafted: "${draft.question}" (${draft.evidenceMode}, ${draft.endTimeHours}h, ${draft.sources.length} sources)`);
        return draft;
      }
    } catch {
      // Not valid JSON — try extracting just the question
    }

    // Fallback: treat as plain question string
    const question = text.replace(/^["']|["']$/g, "").trim();
    if (question.endsWith("?") && question.length >= 10 && question.length <= 300) {
      console.log(`[Creator] Drafted (simple): "${question}"`);
      return question;
    }

    console.log(`[Creator] Draft rejected: "${text.slice(0, 80)}"`);
    return null;
  } catch (err) {
    console.error("[Creator] Claude draft error:", err);
    return null;
  }
}
