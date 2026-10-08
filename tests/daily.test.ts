import { describe, expect, it } from "bun:test";
import { createApp } from "../src/server/app";
import { pickDailyReference } from "../src/server/daily-reference";
import type { DailyStore, MotdEntry, StoredReading } from "../src/server/store";

type FetcherStub = {
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
};

const DAY = "2026-10-07";

function now(): Date {
  return new Date("2026-10-07T12:00:00Z");
}

function createInMemoryStore(gospelRefs?: Map<string, string>): DailyStore {
  const refs = gospelRefs ?? new Map<string, string>();
  const rows = new Map<string, StoredReading>();
  return {
    async get(day: string, translation: string): Promise<StoredReading | null> {
      return rows.get(`${day}|${translation}`) ?? null;
    },
    async getLatest(): Promise<StoredReading | null> {
      let latest: StoredReading | null = null;
      for (const row of rows.values()) {
        if (latest === null || row.fetched_at > latest.fetched_at) {
          latest = row;
        }
      }
      return latest;
    },
    async put(row: StoredReading): Promise<void> {
      rows.set(`${row.day}|${row.translation}`, row);
    },
    async getMotd(): Promise<MotdEntry | null> {
      return null;
    },
    async getFriendsMotd(): Promise<MotdEntry | null> {
      return null;
    },
    async isFriend(): Promise<boolean> {
      return false;
    },
    async getGospelReference(day: string): Promise<string | null> {
      return refs.get(day) ?? null;
    },
    async putGospelReference(day: string, reference: string): Promise<void> {
      refs.set(day, reference);
    },
  };
}

function storeWithMotd(day: string, version: string, markdown: string): DailyStore {
  const base = createInMemoryStore();
  return {
    ...base,
    async getMotd(lookupDay: string): Promise<MotdEntry | null> {
      return lookupDay === day ? { version, markdown } : null;
    },
  };
}

function storeWithVerifyGatedMotd(day: string, version: string, markdown: string): DailyStore {
  const calls: Array<{ day: string; verify: boolean }> = [];
  const store: DailyStore = {
    ...createInMemoryStore(),
    async getMotd(lookupDay: string, opts?: { verify?: boolean }): Promise<MotdEntry | null> {
      calls.push({ day: lookupDay, verify: opts?.verify === true });
      return opts?.verify === true && lookupDay === day ? { version, markdown } : null;
    },
  };
  (store as DailyStore & { motdCalls: typeof calls }).motdCalls = calls;
  return store;
}

function paddedText(): string {
  return "\n    For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.    \n  ";
}

function bibleApiBody(reference: string) {
  return {
    reference,
    verses: [
      {
        book_id: "JHN",
        book_name: "John",
        chapter: 3,
        verse: 16,
        text: paddedText(),
      },
    ],
    text: paddedText(),
    translation_id: "web",
    translation_name: "World English Bible",
    translation_note: "Public Domain",
  };
}

function successFetcher(): FetcherStub {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url: string): Promise<Response> => {
      calls.push(url);
      const refMatch = /bible-api\.com\/([^?]*)\?/.exec(url);
      const reference = refMatch ? decodeURIComponent(refMatch[1]!) : "John 3:16";
      const trMatch = /translation=([^&]+)/.exec(url);
      const translationId = trMatch ? decodeURIComponent(trMatch[1]!) : "web";
      const body = { ...bibleApiBody(reference), translation_id: translationId };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function htmlNotFoundFetcher(): FetcherStub {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response("<html><head><title>404 Not Found</title></head></html>", {
        status: 404,
      });
    },
  };
}

function rejectingFetcher(): FetcherStub {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url: string): Promise<Response> => {
      calls.push(url);
      throw new Error("upstream down");
    },
  };
}

function makeApp(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  return createApp({ store: createInMemoryStore(), fetcher, now });
}

function makeStoredRow(day: string, fetchedAt: number): StoredReading {
  return {
    day,
    translation: "web",
    reference: "John 3:16",
    payload: JSON.stringify({
      reference: "John 3:16",
      text: "For God so loved the world, that he gave his only begotten Son.",
      verses: [
        {
          book_id: "JHN",
          book_name: "John",
          chapter: 3,
          verse: 16,
          text: "For God so loved the world, that he gave his only begotten Son.",
        },
      ],
      translation: { id: "web", name: "World English Bible" },
    }),
    fetched_at: fetchedAt,
  };
}

async function storeWithRow(day: string, fetchedAt: number): Promise<DailyStore> {
  const store = createInMemoryStore();
  await store.put(makeStoredRow(day, fetchedAt));
  return store;
}

describe("GET /api/daily", () => {
  it("returns upstream reading on cache miss", async () => {
    const store = createInMemoryStore();
    const stub = successFetcher();
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.day).toBe(DAY);
    expect(body.cached).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.reference).toBe(pickDailyReference(DAY));
    expect(body.text).toBe(body.text.trim());
    expect(body.verses[0].text).toBe(body.verses[0].text.trim());
    expect(body.translation.id).toBe("web");
    expect(body.translation.name).toBe("World English Bible");

    expect(stub.calls.filter((u) => u.includes("bible-api.com"))).toEqual([
      `https://bible-api.com/${encodeURIComponent(pickDailyReference(DAY))}?translation=web`,
    ]);

    const stored = await store.get(DAY, "web");
    expect(stored).not.toBeNull();
    expect(stored!.reference).toBe(pickDailyReference(DAY));
    expect(JSON.parse(stored!.payload).text).toBe(body.text);
  });

  it("is deterministic per day", async () => {
    expect(pickDailyReference(DAY)).toBe(pickDailyReference(DAY));

    const stubA = successFetcher();
    const stubB = successFetcher();
    const appA = makeApp(stubA.fetcher);
    const appB = makeApp(stubB.fetcher);

    await appA.request("/api/daily");
    await appB.request("/api/daily");

    expect(stubA.calls).toEqual(stubB.calls);
    const bibleCallsA = stubA.calls.filter((u) => u.includes("bible-api.com"));
    expect(bibleCallsA).toEqual([
      `https://bible-api.com/${encodeURIComponent(pickDailyReference(DAY))}?translation=web`,
    ]);
  });

  it("serves from cache on second request", async () => {
    const store = createInMemoryStore();
    const stub = successFetcher();
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const first = await app.request("/api/daily");
    expect(first.status).toBe(200);

    const second = await app.request("/api/daily");
    expect(second.status).toBe(200);

    const body = (await second.json()) as Record<string, any>;
    expect(body.cached).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.day).toBe(DAY);
    expect(stub.calls.filter((u) => u.includes("bible-api.com"))).toHaveLength(1);
  });

  it("respects ?date and ?translation for past days", async () => {
    const store = createInMemoryStore();
    const stub = successFetcher();
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily?date=2026-10-05&translation=kjv");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.day).toBe("2026-10-05");
    expect(body.translation.id).toBe("kjv");

    expect(stub.calls.filter((u) => u.includes("bible-api.com"))).toHaveLength(1);
    const bibleCalls = stub.calls.filter((u) => u.includes("bible-api.com"));
    expect(bibleCalls[0]!.startsWith("https://bible-api.com/")).toBe(true);
    expect(bibleCalls[0]!.endsWith("translation=kjv")).toBe(true);

    expect(await store.get("2026-10-05", "kjv")).not.toBeNull();
    expect(await store.get(DAY, "web")).toBeNull();
  });

  it("rejects invalid dates with 400", async () => {
    const app = makeApp(successFetcher().fetcher);
    for (const date of ["2026-13-40", "notadate"]) {
      const res = await app.request(`/api/daily?date=${encodeURIComponent(date)}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBeDefined();
    }
  });

  it("rejects future dates with 400", async () => {
    const app = makeApp(successFetcher().fetcher);
    const res = await app.request("/api/daily?date=2026-10-08");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBeDefined();
  });

  it("rejects unsupported translations with 400", async () => {
    const app = makeApp(successFetcher().fetcher);
    const res = await app.request("/api/daily?translation=niv");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBeDefined();
  });

  it("falls back to last-good reading when upstream returns an HTML 404", async () => {
    const store = await storeWithRow("2026-10-06", Date.parse("2026-10-06T06:00:00Z"));
    const stub = htmlNotFoundFetcher();
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.stale).toBe(true);
    expect(body.cached).toBe(true);
    expect(body.day).toBe("2026-10-06");
    expect(body.reference).toBe("John 3:16");
    expect(stub.calls.filter((u) => u.includes("bible-api.com"))).toHaveLength(1);
  });

  it("falls back to last-good reading when the fetcher rejects", async () => {
    const store = await storeWithRow("2026-10-06", Date.parse("2026-10-06T06:00:00Z"));
    const stub = rejectingFetcher();
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.stale).toBe(true);
    expect(body.day).toBe("2026-10-06");
  });

  it("returns 502 when upstream fails and the cache is empty", async () => {
    const stub = htmlNotFoundFetcher();
    const app = makeApp(stub.fetcher);

    const res = await app.request("/api/daily");
    expect(res.status).toBe(502);

    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("upstream_unavailable");
  });

  it("sets an s-maxage cache header on success", async () => {
    const app = makeApp(successFetcher().fetcher);

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("cache-control") ?? "";
    const match = /s-maxage=(\d+)/.exec(cacheControl);
    expect(match).not.toBeNull();

    const seconds = Number(match![1]);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(86400);
  });
});

describe("GET /api/daily when the store fails", () => {
  const CACHE_DOWN = "connect ECONNREFUSED 127.0.0.1:3000";

  function brokenStore(opts: {
    getThrows?: boolean;
    putThrows?: boolean;
    latestThrows?: boolean;
    motdThrows?: boolean;
  }): DailyStore {
    return {
      async get(): Promise<StoredReading | null> {
        if (opts.getThrows) throw new Error(CACHE_DOWN);
        return null;
      },
      async getLatest(): Promise<StoredReading | null> {
        if (opts.latestThrows) throw new Error(CACHE_DOWN);
        return null;
      },
      async put(): Promise<void> {
        if (opts.putThrows) throw new Error(CACHE_DOWN);
      },
      async getMotd(): Promise<MotdEntry | null> {
        if (opts.motdThrows) throw new Error(CACHE_DOWN);
        return null;
      },
      async getGospelReference(): Promise<string | null> {
        return null;
      },
      async putGospelReference(): Promise<void> {},
      async getFriendsMotd(): Promise<MotdEntry | null> {
        if (opts.motdThrows) throw new Error(CACHE_DOWN);
        return null;
      },
      async isFriend(): Promise<boolean> {
        if (opts.motdThrows) throw new Error(CACHE_DOWN);
        return false;
      },
    };
  }

  it("serves the fresh upstream reading when cache reads and writes fail", async () => {
    const stub = successFetcher();
    const app = createApp({
      store: brokenStore({ getThrows: true, putThrows: true }),
      fetcher: stub.fetcher,
      now,
    });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.cached).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.reference).toBe(pickDailyReference(DAY));
    expect(stub.calls.filter((u) => u.includes("bible-api.com"))).toEqual([
      `https://bible-api.com/${encodeURIComponent(pickDailyReference(DAY))}?translation=web`,
    ]);
  });

  it("reports cache_unavailable with underlying detail when upstream also fails", async () => {
    const stub = htmlNotFoundFetcher();
    const app = createApp({
      store: brokenStore({ getThrows: true, latestThrows: true }),
      fetcher: stub.fetcher,
      now,
    });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(503);

    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("cache_unavailable");
    expect(String(body.message)).toContain("ECONNREFUSED");
  });

  it("still serves the last-good reading when getLatest works even if get threw", async () => {
    const healthy = await storeWithRow("2026-10-06", Date.parse("2026-10-06T06:00:00Z"));
    const store: DailyStore = {
      get: () => Promise.reject(new Error(CACHE_DOWN)),
      getLatest: () => healthy.getLatest(),
      put: () => Promise.reject(new Error(CACHE_DOWN)),
      getMotd: () => Promise.reject(new Error(CACHE_DOWN)),
      getFriendsMotd: () => Promise.reject(new Error(CACHE_DOWN)),
      isFriend: () => Promise.reject(new Error(CACHE_DOWN)),
      getGospelReference: () => Promise.reject(new Error(CACHE_DOWN)),
      putGospelReference: () => Promise.reject(new Error(CACHE_DOWN)),
    };
    const stub = htmlNotFoundFetcher();
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.stale).toBe(true);
    expect(body.day).toBe("2026-10-06");
  });
});

describe("GET /api/daily message-of-the-day override", () => {
  const MOTD_MARKDOWN = "# Feast of the Holy Rosary\n\nCustom reflection for today.";
  const DOWN = "connect ECONNREFUSED 127.0.0.1:3000";

  it("overrides the gospel reading with the motd markdown for the day", async () => {
    const stub = successFetcher();
    const app = createApp({
      store: storeWithMotd(DAY, "1791475200000", MOTD_MARKDOWN),
      fetcher: stub.fetcher,
      now,
    });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("motd");
    expect(body.markdown).toBe(MOTD_MARKDOWN);
    expect(body.version).toBe("1791475200000");
    expect(body.day).toBe(DAY);
    expect(body.cached).toBe(false);
    expect(body.stale).toBe(false);
    expect(stub.calls).toEqual([]);
  });

  it("defaults to the gospel reading when no motd exists", async () => {
    const stub = successFetcher();
    const app = makeApp(stub.fetcher);

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("gospel");
    expect(body.reference).toBe(pickDailyReference(DAY));
    expect(stub.calls.filter((u) => u.includes("bible-api.com"))).toEqual([
      `https://bible-api.com/${encodeURIComponent(pickDailyReference(DAY))}?translation=web`,
    ]);
  });

  it("looks up the motd for the requested ?date", async () => {
    const stub = successFetcher();
    const app = createApp({
      store: storeWithMotd("2026-10-05", "1791000000000", "# Memorial"),
      fetcher: stub.fetcher,
      now,
    });

    const res = await app.request("/api/daily?date=2026-10-05");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("motd");
    expect(body.markdown).toBe("# Memorial");
    expect(body.day).toBe("2026-10-05");
    expect(stub.calls).toEqual([]);
  });

  it("does not confuse the motd of another day", async () => {
    const stub = successFetcher();
    const app = createApp({
      store: storeWithMotd("2026-10-05", "1791000000000", "# Memorial"),
      fetcher: stub.fetcher,
      now,
    });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("gospel");
  });

  it("falls back to the gospel reading when the motd lookup fails", async () => {
    const stub = successFetcher();
    const store: DailyStore = {
      get: () => Promise.resolve(null),
      getLatest: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      getMotd: () => Promise.reject(new Error(DOWN)),
      getFriendsMotd: () => Promise.reject(new Error(DOWN)),
      isFriend: () => Promise.reject(new Error(DOWN)),
      getGospelReference: () => Promise.reject(new Error(DOWN)),
      putGospelReference: () => Promise.reject(new Error(DOWN)),
    };
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("gospel");
    expect(body.reference).toBe(pickDailyReference(DAY));
  });
});

describe("GET /api/daily motd self-healing", () => {
  it("serves the healed motd transparently when the pointer was missing", async () => {
    const stub = successFetcher();
    const store = storeWithMotd(DAY, "1791479000000", "# healed");
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("motd");
    expect(body.version).toBe("1791479000000");
    expect(stub.calls).toEqual([]);
  });

  it("does not pass verify by default", async () => {
    const stub = successFetcher();
    const store = storeWithVerifyGatedMotd(DAY, "1791479000000", "# verify-only");
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily");
    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("gospel");
    expect(
      (store as DailyStore & { motdCalls: Array<{ day: string; verify: boolean }> }).motdCalls,
    ).toEqual([{ day: DAY, verify: false }]);
  });

  it("passes verify when ?verify=1", async () => {
    const stub = successFetcher();
    const store = storeWithVerifyGatedMotd(DAY, "1791479000000", "# verify-only");
    const app = createApp({ store, fetcher: stub.fetcher, now });

    const res = await app.request("/api/daily?verify=1");
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body.source).toBe("motd");
    expect(body.markdown).toBe("# verify-only");
    expect(
      (store as DailyStore & { motdCalls: Array<{ day: string; verify: boolean }> }).motdCalls,
    ).toEqual([{ day: DAY, verify: true }]);
  });
});

describe("GET /api/daily trailing slash tolerance", () => {
  it("matches /api/daily/ as well as /api/daily", async () => {
    const stub = successFetcher();
    const app = makeApp(stub.fetcher);

    const res = await app.request("/api/daily/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("gospel");
  });
});

function routingFetcher(opts: { lectionary?: object; lectionaryStatus?: number }) {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("catholic-readings-api")) {
      return new Response(JSON.stringify(opts.lectionary ?? {}), {
        status: opts.lectionaryStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    const ref = /bible-api\.com\/([^?]*)/.exec(url)![1]!;
    return new Response(
      JSON.stringify({
        reference: decodeURIComponent(ref),
        verses: [{ book_id: "LUK", book_name: "Luke", chapter: 10, verse: 38, text: " verse " }],
        text: " verse ",
        translation_id: "web",
        translation_name: "World English Bible",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { calls, fetcher };
}

describe("lectionary gospel source", () => {
  it("serves the lectionary gospel on cache miss and caches its reference", async () => {
    const refs = new Map<string, string>();
    const routing = routingFetcher({ lectionary: { readings: { gospel: "Luke 10:38-42" } } });
    const app = createApp({ store: createInMemoryStore(refs), fetcher: routing.fetcher, now });

    const res = await app.request("/api/daily");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("gospel");
    expect(String(body.reference).toLowerCase()).toBe("luke 10:38-42");
    expect(routing.calls[0]).toBe(
      "https://cpbjr.github.io/catholic-readings-api/readings/2026/10-07.json",
    );
    const bibleCalls = routing.calls.filter((u) => u.includes("bible-api.com"));
    expect(bibleCalls[0]).toContain(encodeURIComponent("luke 10:38-42"));
    expect(refs.get(DAY)).toBe("luke 10:38-42");
  });

  it("prefers a cached gospel reference without refetching the lectionary", async () => {
    const refs = new Map<string, string>([[DAY, "john 21:15-17"]]);
    const routing = routingFetcher({ lectionary: { readings: { gospel: "Luke 10:38-42" } } });
    const app = createApp({ store: createInMemoryStore(refs), fetcher: routing.fetcher, now });

    const res = await app.request("/api/daily");
    const body = (await res.json()) as Record<string, any>;
    expect(String(body.reference).toLowerCase()).toBe("john 21:15-17");
    expect(routing.calls.some((u) => u.includes("catholic-readings-api"))).toBe(false);
  });

  it("normalizes verse-letter suffixes in the citation", async () => {
    const routing = routingFetcher({ lectionary: { readings: { gospel: "Matthew 5:1-12a" } } });
    const app = createApp({ store: createInMemoryStore(), fetcher: routing.fetcher, now });

    await app.request("/api/daily");

    const bibleCalls = routing.calls.filter((u) => u.includes("bible-api.com"));
    expect(bibleCalls[0]).toContain(encodeURIComponent("matthew 5:1-12"));
  });

  it("falls back to the seeded verse when the lectionary is unavailable", async () => {
    const routing = routingFetcher({ lectionaryStatus: 404 });
    const app = createApp({ store: createInMemoryStore(), fetcher: routing.fetcher, now });

    const res = await app.request("/api/daily");
    const body = (await res.json()) as Record<string, any>;
    expect(body.reference).toBe(pickDailyReference(DAY));
  });
});

describe("citation normalization", () => {
  it("keeps comma-separated sections", async () => {
    const routing = routingFetcher({ lectionary: { readings: { gospel: "Matthew 2:13-15, 19-23" } } });
    const app = createApp({ store: createInMemoryStore(), fetcher: routing.fetcher, now });

    await app.request("/api/daily");

    const bibleCalls = routing.calls.filter((u) => u.includes("bible-api.com"));
    expect(bibleCalls[0]).toContain(encodeURIComponent("matthew 2:13-15, 19-23"));
  });

  it("strips letter suffixes anywhere in the citation", async () => {
    const routing = routingFetcher({ lectionary: { readings: { gospel: "Luke 6:20b, 24-26" } } });
    const app = createApp({ store: createInMemoryStore(), fetcher: routing.fetcher, now });

    await app.request("/api/daily");

    const bibleCalls = routing.calls.filter((u) => u.includes("bible-api.com"));
    expect(bibleCalls[0]).toContain(encodeURIComponent("luke 6:20, 24-26"));
  });
});
