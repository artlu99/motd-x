import { Hono } from "hono";
import { pickDailyReference } from "./daily-reference";
import { fetchGospelReference } from "./lectionary";
import type { XUser } from "./auth-store";
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
  auth?: {
    resolveSession(raw: string): Promise<string | null>;
    getUser(userId: string): Promise<XUser | null>;
  };
}

interface PublicResult {
  status: number;
  body: Record<string, unknown>;
  cacheControl: string;
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

async function resolvePublic(
  deps: AppDeps,
  opts: { day: string; translation: string; verify: boolean; nowDate: Date },
): Promise<PublicResult> {
  const cacheControl = `public, s-maxage=${secondsUntilUtcMidnight(opts.nowDate)}`;

  let motd: MotdEntry | null = null;
  try {
    motd = await deps.store.getMotd(opts.day, { verify: opts.verify });
  } catch {
    motd = null;
  }
  if (motd !== null) {
    return {
      status: 200,
      body: {
        day: opts.day,
        source: "motd",
        markdown: motd.markdown,
        version: motd.version,
        cached: false,
        stale: false,
      },
      cacheControl,
    };
  }

  let stored: StoredReading | null = null;
  let cacheError: string | null = null;
  try {
    stored = await deps.store.get(opts.day, opts.translation);
  } catch (e) {
    cacheError = e instanceof Error ? e.message : String(e);
  }
  if (stored !== null) {
    const payload = JSON.parse(stored.payload) as Record<string, unknown>;
    return {
      status: 200,
      body: { ...payload, day: stored.day, source: "gospel", cached: true, stale: false },
      cacheControl,
    };
  }

  let reference: string | null = null;
  try {
    reference = await deps.store.getGospelReference(opts.day);
  } catch {
    reference = null;
  }
  if (reference === null) {
    reference = await fetchGospelReference(deps.fetcher, opts.day);
    if (reference !== null) {
      try {
        await deps.store.putGospelReference(opts.day, reference);
      } catch {}
    }
  }
  if (reference === null) {
    reference = pickDailyReference(opts.day);
  }
  const normalized = await fetchNormalized(deps.fetcher, reference, opts.translation);

  if (normalized !== null) {
    try {
      await deps.store.put({
        day: opts.day,
        translation: opts.translation,
        reference: normalized.reference,
        payload: JSON.stringify(normalized),
        fetched_at: opts.nowDate.getTime(),
      });
    } catch {
      cacheError ??= "cache write failed";
    }
    return {
      status: 200,
      body: { ...normalized, day: opts.day, source: "gospel", cached: false, stale: false },
      cacheControl,
    };
  }

  try {
    const lastGood = await deps.store.getLatest();
    if (lastGood !== null) {
      const payload = JSON.parse(lastGood.payload) as Record<string, unknown>;
      return {
        status: 200,
        body: { ...payload, day: lastGood.day, source: "gospel", cached: true, stale: true },
        cacheControl,
      };
    }
  } catch (e) {
    cacheError = e instanceof Error ? e.message : String(e);
  }

  if (cacheError !== null) {
    return {
      status: 503,
      body: { error: "cache_unavailable", message: `reading cache unavailable: ${cacheError}` },
      cacheControl,
    };
  }
  return { status: 502, body: { error: "upstream_unavailable" }, cacheControl };
}

function resolveDay(
  c: { req: { query(name: string): string | undefined } },
  nowDate: Date,
): { day: string } | { status: number; body: Record<string, unknown> } {
  const todayUtc = formatUtcDay(nowDate);
  const dateParam = c.req.query("date");
  if (dateParam === undefined) {
    return { day: todayUtc };
  }
  if (!isValidCalendarDate(dateParam)) {
    return { status: 400, body: { error: "invalid_date" } };
  }
  if (dateParam > todayUtc) {
    return { status: 400, body: { error: "future_date" } };
  }
  return { day: dateParam };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono({ strict: false });

  app.get("/api/daily", async (c) => {
    const translation = c.req.query("translation") ?? "web";
    if (!TRANSLATIONS.has(translation)) {
      return c.json({ error: "invalid_translation" }, 400);
    }

    const nowDate = deps.now();
    const day = resolveDay(c, nowDate);
    if ("status" in day) {
      return c.json(day.body, day.status as 400);
    }

    const result = await resolvePublic(deps, {
      day: day.day,
      translation,
      verify: c.req.query("verify") === "1",
      nowDate,
    });
    return c.json(result.body, result.status as 200, {
      "cache-control": `public, max-age=0, s-maxage=${
        secondsUntilUtcMidnight(nowDate)
      }`,
    });
  });

  app.use("/api/daily/me", async (c, next) => {
    await next();
    c.header("cache-control", "private, no-store");
  });

  app.get("/api/daily/me", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!deps.auth || raw === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    let userId: string | null = null;
    try {
      userId = await deps.auth.resolveSession(raw);
    } catch {
      userId = null;
    }
    if (userId === null) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let username = "friend";
    try {
      const user = await deps.auth.getUser(userId);
      if (user !== null) username = user.username;
    } catch {}

    const day = resolveDay(c, deps.now());
    if ("status" in day) {
      return c.json(day.body, day.status as 400);
    }

    let isFriend = false;
    try {
      isFriend =
        (await deps.store.isFriend(userId)) || (await deps.store.isFriend(username));
    } catch {
      isFriend = false;
    }

    if (isFriend) {
      let entry: MotdEntry | null = null;
      try {
        entry = await deps.store.getFriendsMotd(day.day);
      } catch {
        entry = null;
      }
      if (entry !== null) {
        console.log(JSON.stringify({ evt: "me.tier", audience: "friend", user_id: userId }));
        return c.json({
          day: day.day,
          source: "motd",
          markdown: entry.markdown.replaceAll("{username}", username),
          version: entry.version,
          audience: "friend",
          cached: false,
          stale: false,
        });
      }
    }

    const audience = isFriend ? "friend" : "greeting";
    console.log(JSON.stringify({ evt: "me.tier", audience, user_id: userId }));
    return c.json({
      day: day.day,
      source: "motd",
      markdown: `Hello ${username} I see you 👀`,
      version: "greeting",
      audience,
      cached: false,
      stale: false,
    });
  });

  return app;
}
