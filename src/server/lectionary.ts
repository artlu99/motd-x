const LECTIONARY_BASE = "https://cpbjr.github.io/catholic-readings-api/readings";
const TIMEOUT_MS = 8000;

export function normalizeCitation(citation: string): string {
  return citation
    .toLowerCase()
    .replace(/(\d+)\s*[a-c]\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchGospelReference(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  day: string,
): Promise<string | null> {
  const parts = day.split("-");
  const [year, month, date] = parts;
  if (!year || !month || !date) return null;
  const url = `${LECTIONARY_BASE}/${year}/${month}-${date}.json`;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      readings?: { gospel?: unknown };
    } | null;
    const gospel = body?.readings?.gospel;
    if (typeof gospel !== "string" || gospel.trim() === "") return null;
    return normalizeCitation(gospel);
  } catch {
    return null;
  }
}
