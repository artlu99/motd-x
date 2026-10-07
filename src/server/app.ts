import { Hono } from "hono";
import { pickDailyReference } from "./daily-reference";
import type { DailyStore, MotdEntry, StoredReading } from "./store";

const TRANSLATIONS: ReadonlySet<string> = new Set([
  "web",
  "kjv",
  "asv",
  "bbe",
  "darby",
  "dra",
  "ylt",
  "webbe",
  "oeb-cw",
  "oeb-us",
  "clementine",
  "almeida",
  "rccv",
  "cuv",
  "bkr",
  "cherokee",
]);

const UPSTREAM_BASE = "https://bible-api.com";
const UPSTREAM_TIMEOUT_MS = 8000;

interface BibleVerse {
  book_id: string;
  book_name: string;
  chapter: number;
  verse: number;
  text: string;
}

interface NormalizedReading {
  reference: string;
  text: string;
  verses: BibleVerse[];
  translation: { id: string; name: string };
}

interface UpstreamBody {
  reference?: unknown;
  verses?: unknown;
  text?: unknown;
  translation_id?: unknown;
  translation_name?: unknown;
}

export interface AppDeps {
  store: DailyStore;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
}

function formatUtcDay(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return (
    parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
    parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
    parsed.getUTCDate() === Number(value.slice(8, 10))
  );
}

function secondsUntilUtcMidnight(date: Date): number {
  const nextMidnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
  const seconds = Math.floor((nextMidnight - date.getTime()) / 1000);
  return Math.min(86400, Math.max(1, seconds));
}

function parseUpstreamBody(raw: unknown): NormalizedReading | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const body = raw as UpstreamBody;
  if (
    typeof body.reference !== "string" ||
    typeof body.text !== "string" ||
    typeof body.translation_id !== "string" ||
    typeof body.translation_name !== "string" ||
    !Array.isArray(body.verses) ||
    body.verses.length === 0
  ) {
    return null;
  }
  const verses: BibleVerse[] = [];
  for (const item of body.verses) {
    if (item === null || typeof item !== "object") {
      return null;
    }
    const verse = item as Record<string, unknown>;
    verses.push({
      book_id: typeof verse.book_id === "string" ? verse.book_id : "",
      book_name: typeof verse.book_name === "string" ? verse.book_name : "",
      chapter: typeof verse.chapter === "number" ? verse.chapter : 0,
      verse: typeof verse.verse === "number" ? verse.verse : 0,
      text: typeof verse.text === "string" ? verse.text.trim() : "",
    });
  }
  return {
    reference: body.reference.trim(),
    text: body.text.trim(),
    verses,
    translation: { id: body.translation_id, name: body.translation_name },
  };
}

async function fetchNormalized(
  fetcher: AppDeps["fetcher"],
  reference: string,
  translation: string,
): Promise<NormalizedReading | null> {
  try {
    const upstream = await fetcher(
      `${UPSTREAM_BASE}/${encodeURIComponent(reference)}?translation=${translation}`,
      { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    );
    if (!upstream.ok) return null;
    return parseUpstreamBody(await upstream.json());
  } catch {
    return null;
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/daily", async (c) => {
    const translation = c.req.query("translation") ?? "web";
    if (!TRANSLATIONS.has(translation)) {
      return c.json({ error: "invalid_translation" }, 400);
    }

    const nowDate = deps.now();
    const todayUtc = formatUtcDay(nowDate);

    let day = todayUtc;
    const dateParam = c.req.query("date");
    if (dateParam !== undefined) {
      if (!isValidCalendarDate(dateParam)) {
        return c.json({ error: "invalid_date" }, 400);
      }
      if (dateParam > todayUtc) {
        return c.json({ error: "future_date" }, 400);
      }
      day = dateParam;
    }

    const cacheControl = `public, s-maxage=${secondsUntilUtcMidnight(nowDate)}`;
    const respond = (
      payload: Record<string, unknown> | NormalizedReading,
      responseDay: string,
      cached: boolean,
      stale: boolean,
    ) =>
      c.json(
        { ...payload, day: responseDay, source: "gospel", cached, stale },
        200,
        { "cache-control": cacheControl },
      );

    let motd: MotdEntry | null = null;
    try {
      motd = await deps.store.getMotd(day, { verify: c.req.query("verify") === "1" });
    } catch {
      motd = null;
    }
    if (motd !== null) {
      return c.json(
        {
          day,
          source: "motd",
          markdown: motd.markdown,
          version: motd.version,
          cached: false,
          stale: false,
        },
        200,
        { "cache-control": cacheControl },
      );
    }

    let stored: StoredReading | null = null;
    let cacheError: string | null = null;
    try {
      stored = await deps.store.get(day, translation);
    } catch (e) {
      cacheError = e instanceof Error ? e.message : String(e);
    }
    if (stored !== null) {
      const payload = JSON.parse(stored.payload) as Record<string, unknown>;
      return respond(payload, stored.day, true, false);
    }

    const reference = pickDailyReference(day);
    const normalized = await fetchNormalized(deps.fetcher, reference, translation);

    if (normalized !== null) {
      try {
        await deps.store.put({
          day,
          translation,
          reference: normalized.reference,
          payload: JSON.stringify(normalized),
          fetched_at: nowDate.getTime(),
        });
      } catch {
        cacheError ??= "cache write failed";
      }
      return respond(normalized, day, false, false);
    }

    try {
      const lastGood = await deps.store.getLatest();
      if (lastGood !== null) {
        const payload = JSON.parse(lastGood.payload) as Record<string, unknown>;
        return respond(payload, lastGood.day, true, true);
      }
    } catch (e) {
      cacheError = e instanceof Error ? e.message : String(e);
    }

    if (cacheError !== null) {
      return c.json(
        { error: "cache_unavailable", message: `reading cache unavailable: ${cacheError}` },
        503,
      );
    }
    return c.json({ error: "upstream_unavailable" }, 502);
  });

  return app;
}
