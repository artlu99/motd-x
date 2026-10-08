import { describe, expect, it } from "bun:test";
import { createApp } from "../src/server/app";
import type { DailyStore, MotdEntry, StoredReading } from "../src/server/store";
import type { XUser } from "../src/server/auth-store";

const DAY = "2026-10-07";

function now(): Date {
  return new Date(`${DAY}T12:00:00Z`);
}

interface MeStoreOpts {
  friends?: string[];
  friendsMotd?: MotdEntry;
}

function memStore(opts: MeStoreOpts): DailyStore {
  return {
    async get(): Promise<StoredReading | null> {
      return null;
    },
    async getLatest(): Promise<StoredReading | null> {
      return null;
    },
    async put(): Promise<void> {},
    async getMotd(): Promise<MotdEntry | null> {
      return null;
    },
    async getFriendsMotd(day: string): Promise<MotdEntry | null> {
      return opts.friendsMotd && day === DAY ? opts.friendsMotd : null;
    },
    async isFriend(identifier: string): Promise<boolean> {
      return (opts.friends ?? []).includes(identifier);
    },
    async getGospelReference(): Promise<string | null> {
      return null;
    },
    async putGospelReference(): Promise<void> {},
  };
}

const authFor = (users: Record<string, XUser | null>) => ({
  async resolveSession(raw: string): Promise<string | null> {
    return raw === "tok-good" ? "u1" : null;
  },
  async getUser(userId: string): Promise<XUser | null> {
    return users[userId] ?? null;
  },
});

const BOB: XUser = { id: "u1", username: "bob", name: "Bob" };

function meApp(store: DailyStore, users: Record<string, XUser | null> = { u1: BOB }) {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url);
    return new Response("{}", { status: 200 });
  };
  const app = createApp({ store, fetcher, now, auth: authFor(users) });
  const me = (query = "") =>
    app.request(`${"https://motd-x.artlu.xyz"}/api/daily/me${query}`, {
      headers: { authorization: "Bearer tok-good" },
    });
  return { app, me, calls };
}

describe("GET /api/daily/me", () => {
  it("requires a bearer token", async () => {
    const { app, me } = meApp(memStore({}));

    const noHeader = await app.request(`${"https://motd-x.artlu.xyz"}/api/daily/me`);
    expect(noHeader.status).toBe(401);
    expect(((await noHeader.json()) as Record<string, any>).error).toBe("unauthorized");

    const badToken = await me("?x=1");
    void badToken;
    const bad = await app.request(`${"https://motd-x.artlu.xyz"}/api/daily/me`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
  });

  it("returns 401 when auth deps are missing entirely", async () => {
    const app = createApp({
      store: memStore({}),
      fetcher: async () => new Response("{}", { status: 200 }),
      now,
    });

    const res = await app.request(`${"https://motd-x.artlu.xyz"}/api/daily/me`, {
      headers: { authorization: "Bearer tok-good" },
    });
    expect(res.status).toBe(401);
  });

  it("greets signed-in non-friends by handle", async () => {
    const { app, me, calls } = meApp(memStore({ friends: ["someone-else"] }));

    const res = await me();
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe("motd");
    expect(body.audience).toBe("greeting");
    expect(body.markdown).toBe("Hello bob I see you 👀");
    expect(body.version).toBe("greeting");
    expect(body.day).toBe(DAY);
    expect(calls).toEqual([]);
  });

  it("greets friends by handle when no friends motd exists", async () => {
    const { app, me } = meApp(memStore({ friends: ["u1"] }));

    const res = await me();
    const body = (await res.json()) as Record<string, any>;
    expect(body.audience).toBe("friend");
    expect(body.markdown).toBe("Hello bob I see you 👀");
  });

  it("serves the friends motd with {username} interpolated when present", async () => {
    const { app, me } = meApp(
      memStore({
        friends: ["u1"],
        friendsMotd: { version: "1791479000000", markdown: "# secret deck for {username}\n\n👀" },
      }),
    );

    const res = await me();
    const body = (await res.json()) as Record<string, any>;
    expect(body.audience).toBe("friend");
    expect(body.source).toBe("motd");
    expect(body.markdown).toBe("# secret deck for bob\n\n👀");
    expect(body.version).toBe("1791479000000");
  });

  it("recognizes friends by username", async () => {
    const { app, me } = meApp(memStore({ friends: ["bob"] }));

    const res = await me();
    const body = (await res.json()) as Record<string, any>;
    expect(body.audience).toBe("friend");
  });

  it("falls back to the default handle friend when the profile is unavailable", async () => {
    const { app, me } = meApp(memStore({}), { u1: null });

    const res = await me();
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.audience).toBe("greeting");
    expect(body.markdown).toBe("Hello friend I see you 👀");
  });

  it("honors ?date for the greeting", async () => {
    const { app, me } = meApp(memStore({}));

    const res = await me("?date=2026-10-05");
    const body = (await res.json()) as Record<string, any>;
    expect(body.day).toBe("2026-10-05");
    expect(body.markdown).toBe("Hello bob I see you 👀");
  });
});
