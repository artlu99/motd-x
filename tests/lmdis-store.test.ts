import { describe, expect, it } from "bun:test";
import { LmdisClient, LmdisError } from "../src/server/lmdis/sdk";
import { KEY_PREFIX, LmdisDailyStore } from "../src/server/lmdis-store";
import type { DailyStore, StoredReading } from "../src/server/store";

function clientOver(harness: {
  calls: unknown[][];
  respond: (body: unknown[]) => { status?: number; result?: unknown; body?: Record<string, unknown> };
}): LmdisClient {
  const fetchFn = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    harness.calls.push(body);
    const { status = 200, result, body: responseBody } = harness.respond(body);
    return new Response(JSON.stringify(responseBody ?? { result }), { status });
  };
  return new LmdisClient({
    url: "http://lmdis.test",
    token: "t",
    fetch: fetchFn as unknown as typeof fetch,
  });
}

function makeClient(queues: unknown[]) {
  const calls: unknown[][] = [];
  const client = clientOver({
    calls,
    respond: () => ({ result: queues[calls.length - 1] }),
  });
  return { client, calls };
}

function row(day: string, translation: string, fetchedAt: number): StoredReading {
  return {
    day,
    translation,
    reference: "John 3:16",
    payload: JSON.stringify({ verses: [{ text: "For God so loved the world…" }] }),
    fetched_at: fetchedAt,
  };
}

describe("LmdisDailyStore", () => {
  it("exports the same key prefix as the KV store", () => {
    expect(KEY_PREFIX).toBe("motd-x:daily:v1:");
  });

  it("put issues exactly two SETs: row first, latest pointer second", async () => {
    const { client, calls } = makeClient(["OK", "OK"]);
    const store: DailyStore = new LmdisDailyStore(client);
    const written = row("2026-10-07", "web", 1_000);

    await store.put(written);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "SET",
      "motd-x:daily:v1:2026-10-07:web",
      JSON.stringify(written),
    ]);
    expect(calls[1]).toEqual(["SET", "motd-x:daily:v1:latest", JSON.stringify(written)]);
  });

  it("put resolves void when both SETs acknowledge", async () => {
    const { client } = makeClient(["OK", "OK"]);
    const store: DailyStore = new LmdisDailyStore(client);

    const result = await store.put(row("2026-10-07", "web", 1_000));

    expect(result).toBeUndefined();
  });

  it("get round-trips the stored row through the wire format", async () => {
    const written = row("2026-10-07", "web", 1_000);
    const { client, calls } = makeClient([JSON.stringify(written)]);
    const store: DailyStore = new LmdisDailyStore(client);

    const read = await store.get("2026-10-07", "web");

    expect(calls[0]).toEqual(["GET", "motd-x:daily:v1:2026-10-07:web"]);
    expect(read).toEqual(written);
  });

  it("get returns null on a cache miss", async () => {
    const { client } = makeClient([null]);
    const store: DailyStore = new LmdisDailyStore(client);

    expect(await store.get("2026-10-07", "web")).toBeNull();
  });

  it("get returns null when the stored value is corrupt JSON", async () => {
    const { client } = makeClient(["{corrupt"]);
    const store: DailyStore = new LmdisDailyStore(client);

    expect(await store.get("2026-10-07", "web")).toBeNull();
  });

  it("getLatest reads the latest pointer key and round-trips the row", async () => {
    const written = row("2026-10-07", "web", 1_000);
    const { client, calls } = makeClient([JSON.stringify(written)]);
    const store: DailyStore = new LmdisDailyStore(client);

    const latest = await store.getLatest();

    expect(calls[0]).toEqual(["GET", "motd-x:daily:v1:latest"]);
    expect(latest).toEqual(written);
  });

  it("getLatest returns null on a miss", async () => {
    const { client } = makeClient([null]);
    const store: DailyStore = new LmdisDailyStore(client);

    expect(await store.getLatest()).toBeNull();
  });

  it("getLatest returns null when the pointer value is corrupt JSON", async () => {
    const { client } = makeClient(["{corrupt"]);
    const store: DailyStore = new LmdisDailyStore(client);

    expect(await store.getLatest()).toBeNull();
  });

  it("propagates transport/auth failures as LmdisError", async () => {
    const calls: unknown[][] = [];
    const client = clientOver({
      calls,
      respond: () => ({
        status: 401,
        body: { error: "Invalid authorization token", code: "UNAUTHORIZED" },
      }),
    });
    const store: DailyStore = new LmdisDailyStore(client);
    const written = row("2026-10-07", "web", 1_000);

    expect(calls).toHaveLength(0);
    await expect(store.get("2026-10-07", "web")).rejects.toBeInstanceOf(LmdisError);
    await expect(store.get("2026-10-07", "web")).rejects.toThrow("Invalid authorization token");
    await expect(store.getLatest()).rejects.toBeInstanceOf(LmdisError);
    await expect(store.put(written)).rejects.toBeInstanceOf(LmdisError);
    expect(calls).toHaveLength(4);
  });
});

describe("LmdisDailyStore.getMotd", () => {
  it("serves the pointer via a single GET when healthy", async () => {
    const { client, calls } = makeClient([{ version: "1000", markdown: "# live" }]);
    const store = new LmdisDailyStore(client);

    const entry = await store.getMotd("2026-10-07");

    expect(entry).toEqual({ version: "1000", markdown: "# live" });
    expect(calls).toEqual([["GET", "motd-x:daily:v1:motd:2026-10-07"]]);
  });

  it("self-heals a missing pointer from the newest archive version", async () => {
    const { client, calls } = makeClient([
      null,
      ["motd-x:daily:v1:motd:2026-10-07:1791479000000"],
      "# orphaned archive copy",
      "OK",
    ]);
    const store = new LmdisDailyStore(client);

    const entry = await store.getMotd("2026-10-07");

    expect(entry).toEqual({ version: "1791479000000", markdown: "# orphaned archive copy" });
    expect(calls[1]).toEqual(["KEYS", "motd-x:daily:v1:motd:2026-10-07:*"]);
    expect(calls[2]).toEqual(["GET", "motd-x:daily:v1:motd:2026-10-07:1791479000000"]);
    expect(calls[3]).toEqual([
      "SET",
      "motd-x:daily:v1:motd:2026-10-07",
      JSON.stringify({ version: "1791479000000", markdown: "# orphaned archive copy" }),
    ]);
  });

  it("returns null and does not heal when no archive versions exist", async () => {
    const { client, calls } = makeClient([null, []]);
    const store = new LmdisDailyStore(client);

    expect(await store.getMotd("2026-10-07")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("returns null and does not heal when the newest archive value is empty", async () => {
    const { client, calls } = makeClient([
      null,
      ["motd-x:daily:v1:motd:2026-10-07:1791479000000"],
      "",
    ]);
    const store = new LmdisDailyStore(client);

    expect(await store.getMotd("2026-10-07")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("serves the healed entry even when the healing pointer write fails", async () => {
    const { client, calls } = makeClient([
      null,
      ["motd-x:daily:v1:motd:2026-10-07:1791479000000"],
      "# orphaned archive copy",
    ]);
    const store = new LmdisDailyStore(client);

    const entry = await store.getMotd("2026-10-07");

    expect(entry).toEqual({ version: "1791479000000", markdown: "# orphaned archive copy" });
    expect(calls).toHaveLength(4);
    expect(calls[3]![0]).toBe("SET");
  });

  it("with verify, adopts a newer archive version over a stale pointer", async () => {
    const { client, calls } = makeClient([
      { version: "1791475000000", markdown: "# stale" },
      ["motd-x:daily:v1:motd:2026-10-07:1791479000000"],
      "# newer archive copy",
      "OK",
    ]);
    const store = new LmdisDailyStore(client);

    const entry = await store.getMotd("2026-10-07", { verify: true });

    expect(entry).toEqual({ version: "1791479000000", markdown: "# newer archive copy" });
    expect(calls[3]).toEqual([
      "SET",
      "motd-x:daily:v1:motd:2026-10-07",
      JSON.stringify({ version: "1791479000000", markdown: "# newer archive copy" }),
    ]);
  });

  it("with verify, keeps the pointer when the archive is not newer", async () => {
    const { client, calls } = makeClient([
      { version: "1791479000000", markdown: "# live" },
      ["motd-x:daily:v1:motd:2026-10-07:1791475000000"],
      "# older archive copy",
    ]);
    const store = new LmdisDailyStore(client);

    const entry = await store.getMotd("2026-10-07", { verify: true });

    expect(entry).toEqual({ version: "1791479000000", markdown: "# live" });
    expect(calls).toHaveLength(3);
  });

  it("with verify, keeps the pointer when the archive is empty", async () => {
    const { client, calls } = makeClient([{ version: "1000", markdown: "# live" }, []]);
    const store = new LmdisDailyStore(client);

    const entry = await store.getMotd("2026-10-07", { verify: true });

    expect(entry).toEqual({ version: "1000", markdown: "# live" });
    expect(calls).toHaveLength(2);
  });

  it("returns null when the pointer value is corrupt", async () => {
    const { client } = makeClient(["{corrupt", []]);
    const store = new LmdisDailyStore(client);

    expect(await store.getMotd("2026-10-07")).toBeNull();
  });

  it("returns null when the pointer value lacks a valid shape", async () => {
    const { client } = makeClient([{ markdown: "# no version field" }, []]);
    const store = new LmdisDailyStore(client);

    expect(await store.getMotd("2026-10-07")).toBeNull();
  });

  it("propagates transport/auth failures", async () => {
    const client = clientOver({
      calls: [],
      respond: () => ({
        status: 401,
        body: { error: "Invalid authorization token", code: "UNAUTHORIZED" },
      }),
    });
    const store = new LmdisDailyStore(client);

    await expect(store.getMotd("2026-10-07")).rejects.toBeInstanceOf(LmdisError);
  });
});
