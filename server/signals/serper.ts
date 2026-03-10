export interface SerperResult {
  title: string;
  snippet: string;
  link: string;
}

export async function searchSerper(
  query: string,
  tbs?: string
): Promise<SerperResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn("[Serper] No SERPER_API_KEY set, returning empty results");
    return [];
  }

  try {
    const body: Record<string, unknown> = { q: query, num: 5 };
    if (tbs) body.tbs = tbs;

    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`[Serper] ${res.status}: ${await res.text()}`);
      return [];
    }

    const data = await res.json();
    const organic = data.organic || [];

    return organic.slice(0, 5).map((r: { title?: string; snippet?: string; link?: string }) => ({
      title: r.title || "",
      snippet: r.snippet || "",
      link: r.link || "",
    }));
  } catch (err) {
    console.error("[Serper] Error:", err);
    return [];
  }
}
