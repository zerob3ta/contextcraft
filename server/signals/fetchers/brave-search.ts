/**
 * Brave Search API client for web grounding.
 * Returns concise search results to inject into LLM prompts.
 */

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export interface BraveSearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

/**
 * Search Brave and return top results as grounding context.
 */
export async function braveSearch(query: string, count = 5): Promise<BraveSearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(count),
      text_decorations: "false",
      search_lang: "en",
    });

    const res = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
      headers: { "X-Subscription-Token": apiKey },
    });

    if (!res.ok) {
      console.warn(`[Brave] ${res.status}: ${await res.text().catch(() => "")}`);
      return [];
    }

    const data = await res.json();
    const results: BraveSearchResult[] = (data.web?.results ?? [])
      .slice(0, count)
      .map((r: { title?: string; url?: string; description?: string; age?: string }) => ({
        title: r.title || "",
        url: r.url || "",
        snippet: (r.description || "").slice(0, 200),
        age: r.age,
      }));

    return results;
  } catch (err) {
    console.warn("[Brave] Search failed:", err);
    return [];
  }
}

/**
 * Format search results as a compact string for prompt injection.
 */
export function formatSearchResults(results: BraveSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map((r) => {
      const age = r.age ? ` (${r.age})` : "";
      return `- ${r.title}${age}: ${r.snippet}`;
    })
    .join("\n");
}
