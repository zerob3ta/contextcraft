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
  "resolutionCriteria": "This market resolves YES if [precise condition]...\\n\\nEvidence sources: [specific X handles or source types].\\n\\nClarifications:\\n- [edge case 1]\\n- [edge case 2]",
  "evidenceMode": "web_enabled or social_only",
  "sources": ["@handle1", "@handle2"],
  "endTimeHours": 24
}

## CLAIM TYPE AWARENESS

Identify the claim type and set endTimeHours accordingly:

| Claim Type | Pattern | End Time Logic |
|---|---|---|
| Event-by-deadline | "Will X happen by Y?" | End AFTER the deadline + buffer for evidence (2-6h after event) |
| Threshold | "Will X reach N?" | End when the measurement window closes + buffer |
| Period-gated end-state | "Will X be Y at end of Z?" | End AFTER the period ends + buffer |
| Durational/aggregate | "Most/total over period" | End AFTER the full period + buffer |

## END TIME RULES — CRITICAL

The current date and time is provided in the user message. Use it to calculate endTimeHours precisely.

- **Sports game today/tonight**: Calculate hours until ~3h after expected game end. A 7pm game ends ~10pm, so if it's 2pm now, endTimeHours = 11 (covers game + evidence buffer).
- **Sports game tomorrow or later**: Calculate actual hours until event end + 3h buffer.
- **News events this week**: End time should cover the expected event window + 6h buffer.
- **Crypto price targets**: 48-168h depending on how ambitious the target is.
- **Policy/geopolitical**: 48-336h. Major policy actions take time. Don't use 24h for something that hasn't been announced yet.
- **Product launches/announcements**: End time after the event date + 12h buffer.
- **NEVER default to 24h.** Always reason about when the event will actually happen and set the end time accordingly.
- **Give buffer for evidence to appear.** If an event happens at 3pm, don't end at 3:01pm. Give at least 3-6 hours for social media and news to report it.

## QUESTION RULES
- Start with "Will...", 6-20 words, specific and measurable, ends with "?"
- Include a specific deadline or timeframe in the question itself
- shortQuestion: Condensed display version, under 100 characters

## RESOLUTION CRITERIA — WRITE LIKE A CONTRACT

The oracle is an AI that reads your criteria as its ONLY instructions. It cannot use outside knowledge. Your criteria must be completely self-contained.

Structure:
\`\`\`
This market resolves YES if [specific condition with measurable outcome].

This market resolves NO if [the market end time passes without the YES condition being met / specific disconfirming event].

Evidence sources: [@handle1, @handle2] on X/Twitter.
[OR] Evidence sources: Official announcements, major news outlets, or domain authority sources.

Clarifications:
- [Edge case: cancellation/postponement]
- [Edge case: partial outcomes]
- [Edge case: source conflicts]
- [Definition of any ambiguous term]
\`\`\`

Rules:
1. Be explicit about what counts as evidence — don't say "if announced", say "if announced via an official post from @Apple on X/Twitter, or confirmed by a major news outlet."
2. Define ambiguous terms — if you say "major," define what major means.
3. Handle edge cases — cancellation, postponement, partial truth, retraction.
4. Specify the evidence mode — social_only for X posts, web_enabled for official data/scores.
5. Name your sources — specific X handles for social_only, authoritative source types for web_enabled.
6. Time-bound everything — restate the deadline in the criteria.
7. One condition per market — don't combine unrelated conditions.

## EVIDENCE MODE
- "social_only": X/Twitter posts from specified accounts are sufficient (announcements, reactions)
- "web_enabled": Oracle also searches authoritative web sources — use for scores, earnings, official data, prices

## SOURCE GUIDE
- Sports: @ESPN, @SportsCenter, @NBA, @NFL, @NHL, @MLBNetwork
- Crypto: @CoinDesk, @CoinGecko, @whale_alert
- Politics/News: @AP, @Reuters, @business, @WSJ
- Tech: @TechCrunch, @verge, @Reuters
- Finance: @FederalReserve, @business, @unusual_whales

## RESOLUTION CRITERIA EXAMPLES

Sports: "This market resolves YES if the Los Angeles Lakers defeat the Boston Celtics in their game on March 12, 2026 (final score, including overtime if applicable). This market resolves NO if the Celtics win or the game is postponed beyond the market end time.\\n\\nEvidence: Official @NBA or @NBAOfficial posts, ESPN box score on espn.com, or reporting from major sports outlets.\\n\\nClarifications:\\n- Overtime and double-overtime results count as the final score.\\n- If the game is postponed or cancelled, this resolves NO.\\n- Pre-season or exhibition games do not count."

Crypto: "This market resolves YES if Bitcoin's spot price on CoinGecko exceeds $150,000 USD at any point before the market end time. This market resolves NO if the end time passes without the price reaching $150,000.\\n\\nEvidence: CoinGecko.com showing BTC/USD above $150,000, posts from @CoinGecko on X/Twitter, or screenshots showing the price level.\\n\\nClarifications:\\n- Brief wicks above $150,000 count — the price only needs to touch the level.\\n- CoinGecko is the sole price reference. Other exchanges do not count.\\n- If CoinGecko is down during the market window, the market resolves NO unless CoinGecko data retroactively confirms the price was reached."

Policy: "This market resolves YES if President Trump or the official @WhiteHouse account on X/Twitter announces new tariffs on Chinese imports exceeding 25% on any product category before the market end time. This market resolves NO if no such announcement is made.\\n\\nEvidence: Official White House announcements (whitehouse.gov), posts from @WhiteHouse or @POTUS, or reporting from Reuters, AP, or Bloomberg.\\n\\nClarifications:\\n- 'Announces' means an official statement, executive order, or signed proclamation — not a rumor, leak, or unofficial report.\\n- A threat or proposal does not count as an announcement.\\n- Tariffs on non-Chinese imports do not satisfy this condition."

Tech: "This market resolves YES if OpenAI publicly releases a model they designate as 'GPT-5' (available for general use, not just research preview or waitlist) before the market end time.\\n\\nEvidence: Official OpenAI blog post (openai.com/blog), posts from @OpenAI or @sama on X/Twitter, or reporting from major tech outlets (The Verge, TechCrunch, Bloomberg).\\n\\nClarifications:\\n- 'Publicly releases' means available to general public, not just enterprise or API-only.\\n- A model called 'GPT-4.5' or 'GPT-5-preview' does not count unless OpenAI explicitly designates it as 'GPT-5'.\\n- A research paper or demo does not count as a release."

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
      max_tokens: 1200,
      system: MARKET_DRAFT_PROMPT,
      messages: [
        {
          role: "user",
          content: `Current date and time: ${new Date().toISOString()} (Eastern Time approximate)\nDay of week: ${new Date().toLocaleDateString("en-US", { weekday: "long" })}\n\nTopic: ${topic}\n\nNews:\n${newsContext}`,
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
