/** Firecrawl API fetcher — scrapes JS-rendered pages */

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";

export interface ScrapedPage {
  title: string;
  markdown: string;
}

export async function scrapePage(url: string): Promise<ScrapedPage | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.warn("[Firecrawl] No FIRECRAWL_API_KEY set");
    return null;
  }

  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.error(`[Firecrawl] ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    if (!data.success || !data.data) return null;

    const title = data.data.metadata?.title || data.data.metadata?.ogTitle || "";
    // Truncate to ~15k chars to keep LLM context manageable
    const markdown = (data.data.markdown || "").slice(0, 15_000);

    return { title, markdown };
  } catch (err) {
    console.error("[Firecrawl] Error:", err);
    return null;
  }
}
