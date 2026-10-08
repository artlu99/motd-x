import { describe, expect, it, spyOn } from "bun:test";
import { LmdisClient } from "../src/server/lmdis/sdk";
import { AuthStore } from "../src/server/auth-store";
import type { AuthAttempt, XUser } from "../src/server/auth-store";
import { createAuthApp } from "../src/server/auth";

const AUTH_NS = "motd-x:daily:v1:auth:";

const attemptKey = (pollToken: string): string => `${AUTH_NS}attempt:${pollToken}`;
const stateKey = (state: string): string => `${AUTH_NS}state:${state}`;
const mintedKey = (pollToken: string): string => `${AUTH_NS}minted:${pollToken}`;
const sessionKey = (hash: string): string => `${AUTH_NS}session:${hash}`;
const userKey = (userId: string): string => `${AUTH_NS}user:${userId}`;

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeFakeLmdis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, number>>();
  const expiresAt = new Map<string, number>();
  const calls: unknown[][] = [];

  const live = (key: string): boolean => {
    const exp = expiresAt.get(key);
    if (exp === undefined) return true;
    if (Date.now() / 1000 >= exp) {
      strings.delete(key);
      hashes.delete(key);
      expiresAt.delete(key);
      return false;
    }
    return true;
  };

  const fetchFn = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const cmd = JSON.parse(String(init?.body)) as unknown[];
    calls.push(cmd);
    const op = String(cmd[0]);
    const key = String(cmd[1]);
    let result: unknown = null;
    if (op === "SET") {
      strings.set(key, String(cmd[2]));
      expiresAt.delete(key);
      if (cmd[3] === "EX") expiresAt.set(key, Math.floor(Date.now() / 1000) + Number(cmd[4]));
      if (cmd[3] === "EXAT") expiresAt.set(key, Number(cmd[4]));
      result = "OK";
    } else if (op === "GET") {
      result = live(key) ? (strings.get(key) ?? null) : null;
    } else if (op === "DEL") {
      result = strings.delete(key) || hashes.delete(key) ? 1 : 0;
      expiresAt.delete(key);
    } else if (op === "HINCR") {
      const field = String(cmd[2]);
      const hash = hashes.get(key) ?? new Map<string, number>();
      const next = (hash.get(field) ?? 0) + Number(cmd[3]);
      hash.set(field, next);
      hashes.set(key, hash);
      result = next;
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  };

  const client = new LmdisClient({
    url: "http://lmdis.test",
    token: "t",
    fetch: fetchFn as unknown as typeof fetch,
  });
  return { client, calls, strings, hashes, expiresAt };
}

function attemptRow(pollToken: string, state: string): AuthAttempt {
  const nowMs = Date.now();
  return {
    poll_token: pollToken,
    state,
    code_verifier: "v".repeat(43),
    context: "iframe",
    status: "pending",
    user_id: null,
    created_at: nowMs,
    expires_at: nowMs + 600_000,
  };
}

describe("AuthStore", () => {
  const t0 = 1_700_000_000_000;

  it("createAttempt writes the attempt row and state index with EX seconds until expiry", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client, { now: () => new Date(t0) });
    const row = {
      poll_token: "pt",
      state: "st",
      code_verifier: "ver",
      context: "iframe" as const,
      status: "pending" as const,
      user_id: null,
      created_at: t0,
      expires_at: t0 + 600_000,
    };

    await store.createAttempt(row);

    expect(lmdis.calls).toHaveLength(2);
    const attemptCall = lmdis.calls[0]!;
    expect(attemptCall[0]).toBe("SET");
    expect(attemptCall[1]).toBe(attemptKey("pt"));
    expect(JSON.parse(String(attemptCall[2]))).toEqual(row);
    expect(attemptCall[3]).toBe("EX");
    expect(attemptCall[4]).toBe(600);
    const stateCall = lmdis.calls[1]!;
    expect(stateCall[0]).toBe("SET");
    expect(stateCall[1]).toBe(stateKey("st"));
    expect(stateCall[2]).toBe("pt");
    expect(stateCall[3]).toBe("EX");
    expect(stateCall[4]).toBe(600);
  });

  it("createAttempt round-trips through getAttemptByPollToken as pending", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client);
    const row = attemptRow("pt", "st");

    await store.createAttempt(row);

    expect(await store.getAttemptByPollToken("pt")).toEqual(row);
  });

  it("getAttemptByPollToken returns null for a missing attempt", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client);

    expect(await store.getAttemptByPollToken("ghost")).toBeNull();
  });

  it("getAttemptByPollToken reports expired once expires_at is reached", async () => {
    const lmdis = makeFakeLmdis();
    const row = attemptRow("pt", "st");
    await new AuthStore(lmdis.client).createAttempt(row);

    const atExpiry = new AuthStore(lmdis.client, { now: () => new Date(row.expires_at) });
    expect(await atExpiry.getAttemptByPollToken("pt")).toEqual({ ...row, status: "expired" });

    const past = new AuthStore(lmdis.client, { now: () => new Date(row.expires_at + 1) });
    expect(await past.getAttemptByPollToken("pt")).toEqual({ ...row, status: "expired" });
  });

  it("getAttemptByState resolves the index and shares missing and expiry semantics", async () => {
    const lmdis = makeFakeLmdis();
    const row = attemptRow("pt", "st");
    await new AuthStore(lmdis.client).createAttempt(row);

    expect(await new AuthStore(lmdis.client).getAttemptByState("st")).toEqual(row);
    expect(await new AuthStore(lmdis.client).getAttemptByState("ghost")).toBeNull();

    const past = new AuthStore(lmdis.client, { now: () => new Date(row.expires_at + 1) });
    expect(await past.getAttemptByState("st")).toEqual({ ...row, status: "expired" });
  });

  it("completeAttempt completes the pending attempt and rewrites both keys with remaining TTL", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client, { now: () => new Date(t0) });
    const row = {
      poll_token: "pt",
      state: "st",
      code_verifier: "ver",
      context: "iframe" as const,
      status: "pending" as const,
      user_id: null,
      created_at: t0,
      expires_at: t0 + 600_000,
    };
    await store.createAttempt(row);
    const before = lmdis.calls.length;

    await store.completeAttempt("st", "123");

    const sets = lmdis.calls.slice(before).filter((c) => c[0] === "SET");
    expect(sets).toHaveLength(2);
    const attemptSet = sets.find((c) => c[1] === attemptKey("pt"))!;
    expect(JSON.parse(String(attemptSet[2]))).toEqual({ ...row, status: "completed", user_id: "123" });
    expect(attemptSet[3]).toBe("EX");
    expect(attemptSet[4]).toBe(600);
    const stateSet = sets.find((c) => c[1] === stateKey("st"))!;
    expect(stateSet[2]).toBe("pt");
    expect(stateSet[3]).toBe("EX");
    expect(stateSet[4]).toBe(600);
    expect(await store.getAttemptByPollToken("pt")).toEqual({
      ...row,
      status: "completed",
      user_id: "123",
    });
  });

  it("completeAttempt clamps the rewritten TTL to at least one second", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client, { now: () => new Date(t0) });
    await store.createAttempt({
      poll_token: "pt",
      state: "st",
      code_verifier: "ver",
      context: "standalone",
      status: "pending",
      user_id: null,
      created_at: t0,
      expires_at: t0 + 600_000,
    });
    const finisher = new AuthStore(lmdis.client, { now: () => new Date(t0 + 599_500) });

    await finisher.completeAttempt("st", "123");

    const sets = lmdis.calls.filter((c) => c[0] === "SET");
    const attemptSet = sets.find((c) => c[1] === attemptKey("pt"))!;
    expect(attemptSet[4]).toBe(1);
    const stateSet = sets.find((c) => c[1] === stateKey("st"))!;
    expect(stateSet[4]).toBe(1);
  });

  it("completeAttempt is idempotent once completed", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client, { now: () => new Date(t0) });
    const row = {
      poll_token: "pt",
      state: "st",
      code_verifier: "ver",
      context: "iframe" as const,
      status: "pending" as const,
      user_id: null,
      created_at: t0,
      expires_at: t0 + 600_000,
    };
    await store.createAttempt(row);
    await store.completeAttempt("st", "123");
    const before = lmdis.calls.length;

    await store.completeAttempt("st", "999");

    expect(lmdis.calls.slice(before).filter((c) => c[0] === "SET")).toHaveLength(0);
    expect(await store.getAttemptByPollToken("pt")).toEqual({
      ...row,
      status: "completed",
      user_id: "123",
    });
  });

  it("beginMint wins the mint exactly once per poll token", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client);

    expect(await store.beginMint("pt")).toBe(true);
    expect(await store.beginMint("pt")).toBe(false);
    expect(await store.beginMint("other")).toBe(true);

    expect(lmdis.calls[0]).toEqual(["HINCR", mintedKey("pt"), "n", "1"]);
    expect(lmdis.calls[1]).toEqual(["HINCR", mintedKey("pt"), "n", "1"]);
    expect(lmdis.calls[2]).toEqual(["HINCR", mintedKey("other"), "n", "1"]);
  });

  it("saveSession writes the session payload keyed by token hash with EX until expiry", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client, { now: () => new Date(t0) });
    const hash = await sha256hex("tok");

    await store.saveSession(hash, "123", t0, t0 + 600_000);

    const call = lmdis.calls[0]!;
    expect(call[0]).toBe("SET");
    expect(call[1]).toBe(sessionKey(hash));
    expect(JSON.parse(String(call[2]))).toEqual({
      user_id: "123",
      created_at: t0,
      expires_at: t0 + 600_000,
    });
    expect(call[3]).toBe("EX");
    expect(call[4]).toBe(600);
  });

  it("getSessionUser resolves only live sessions", async () => {
    const lmdis = makeFakeLmdis();
    const hash = await sha256hex("tok");
    await new AuthStore(lmdis.client, { now: () => new Date(t0) }).saveSession(
      hash,
      "123",
      t0,
      t0 + 600_000,
    );

    expect(await new AuthStore(lmdis.client).getSessionUser(hash)).toBe("123");
    expect(await new AuthStore(lmdis.client).getSessionUser(await sha256hex("ghost"))).toBeNull();

    const atExpiry = new AuthStore(lmdis.client, { now: () => new Date(t0 + 600_000) });
    expect(await atExpiry.getSessionUser(hash)).toBeNull();
  });

  it("upsertUser writes the user row without a TTL", async () => {
    const lmdis = makeFakeLmdis();
    const store = new AuthStore(lmdis.client);
    const user: XUser = {
      id: "123",
      username: "alice",
      name: "Alice",
      profile_image_url: "https://p/img.png",
    };

    await store.upsertUser(user);

    const call = lmdis.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call[0]).toBe("SET");
    expect(call[1]).toBe(userKey("123"));
    expect(JSON.parse(String(call[2]))).toEqual(user);

    await store.upsertUser({ id: "456", username: "bob", name: "Bob" });
    expect(JSON.parse(String(lmdis.calls[1]![2]))).toEqual({
      id: "456",
      username: "bob",
      name: "Bob",
    });
  });
});

type AuthApp = ReturnType<typeof createAuthApp>;

const CLIENT_ID = "cid-123";
const ORIGIN = "https://motd-x.artlu.xyz";

function toWire(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

function makeXApi() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const xApi = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url === "https://api.x.com/2/oauth2/token") {
      return Response.json({
        token_type: "bearer",
        expires_in: 7200,
        access_token: "AT-1",
        scope: "tweet.read users.read",
        refresh_token: "R-1",
      });
    }
    if (url.startsWith("https://api.x.com/2/users/me")) {
      return Response.json({
        data: {
          id: "123",
          username: "alice",
          name: "Alice",
          profile_image_url: "https://p/img.png",
        },
      });
    }
    return new Response("unexpected x api call", { status: 500 });
  };
  return { xApi, calls };
}

function makeApp(now?: () => Date, lmdis = makeFakeLmdis()) {
  const x = makeXApi();
  const store = new AuthStore(lmdis.client, { now });
  const app = createAuthApp({ store, xApi: x.xApi, clientId: CLIENT_ID, now });
  return { lmdis, store, x, app };
}

async function start(app: AuthApp, context: string): Promise<Record<string, any>> {
  const res = await app.request(`${ORIGIN}/auth/start?context=${context}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

async function poll(app: AuthApp, token: string): Promise<Record<string, any>> {
  const res = await app.request(`${ORIGIN}/auth/poll?token=${encodeURIComponent(token)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

function callbackUrl(state: string, code: string): string {
  return `${ORIGIN}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

describe("createAuthApp", () => {
  it("start iframe returns an authorize URL, a distinct poll token, and persists a pending attempt", async () => {
    const { app, store } = makeApp();

    const res = await app.request(`${ORIGIN}/auth/start?context=iframe`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(typeof body.authorize_url).toBe("string");
    expect(body.authorize_url.startsWith("https://x.com/i/oauth2/authorize?")).toBe(true);
    expect(body.authorize_url).toContain("response_type=code");
    expect(body.authorize_url).toContain(`client_id=${CLIENT_ID}`);
    expect(body.authorize_url).toContain(
      "redirect_uri=https%3A%2F%2Fmotd-x.artlu.xyz%2Fauth%2Fcallback",
    );
    expect(body.authorize_url).toContain("scope=tweet.read%20users.read");

    const params = new URL(body.authorize_url).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(params.get("scope")).toBe("tweet.read users.read");
    expect(params.get("code_challenge_method")).toBe("S256");
    const state = params.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);
    const challenge = params.get("code_challenge") ?? "";
    expect(challenge).toHaveLength(43);

    expect(typeof body.poll_token).toBe("string");
    expect((body.poll_token as string).length).toBeGreaterThan(0);
    expect(body.poll_token).not.toBe(state);

    const attempt = await store.getAttemptByPollToken(body.poll_token);
    expect(attempt).not.toBeNull();
    expect(attempt!.poll_token).toBe(body.poll_token);
    expect(attempt!.state).toBe(state);
    expect(typeof attempt!.code_verifier).toBe("string");
    expect(attempt!.context).toBe("iframe");
    expect(attempt!.status).toBe("pending");
    expect(attempt!.user_id).toBeNull();
    expect(attempt!.expires_at).toBeGreaterThan(attempt!.created_at);
    expect(attempt!.expires_at - attempt!.created_at).toBe(600_000);
  });

  it("start rejects a missing or unknown context", async () => {
    const { app } = makeApp();

    expect((await app.request(`${ORIGIN}/auth/start?context=widget`)).status).toBe(400);
    expect((await app.request(`${ORIGIN}/auth/start`)).status).toBe(400);
  });

  it("start derives the S256 challenge from the persisted verifier", async () => {
    const { app, store } = makeApp();

    const body = await start(app, "iframe");
    const attempt = await store.getAttemptByPollToken(body.poll_token);
    expect(attempt).not.toBeNull();
    const verifier = attempt!.code_verifier;
    expect(verifier.length).toBeGreaterThanOrEqual(43);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(new URL(body.authorize_url).searchParams.get("code_challenge")).toBe(
      base64url(new Uint8Array(digest)),
    );
  });

  it("iframe flow mints the session at poll, never exposing a token at callback", async () => {
    const { app, store, x } = makeApp();

    const startBody = await start(app, "iframe");
    const attempt = await store.getAttemptByPollToken(startBody.poll_token);
    expect(attempt).not.toBeNull();

    const callback = await app.request(callbackUrl(attempt!.state, "CODE"));
    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-type")).toContain("text/html");
    const html = await callback.text();
    expect(html).toMatch(/signed in/i);
    expect(html).not.toContain("session_token");

    expect(x.calls).toHaveLength(2);
    const tokenCall = x.calls.find((c) => c.url === "https://api.x.com/2/oauth2/token")!;
    expect(String(tokenCall.init?.method ?? "GET").toUpperCase()).toBe("POST");
    const tokenForm = toWire(tokenCall.init);
    expect(tokenForm.get("grant_type")).toBe("authorization_code");
    expect(tokenForm.get("code")).toBe("CODE");
    expect(tokenForm.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(tokenForm.get("client_id")).toBe(CLIENT_ID);
    expect(tokenForm.get("code_verifier")).toBe(attempt!.code_verifier);
    const meCall = x.calls.find((c) => c.url.startsWith("https://api.x.com/2/users/me"))!;
    expect(new Headers(meCall.init?.headers).get("authorization")).toBe("Bearer AT-1");

    const first = await poll(app, startBody.poll_token);
    expect(first.status).toBe("completed");
    expect(typeof first.session_token).toBe("string");
    expect(first.user).toEqual({
      id: "123",
      username: "alice",
      name: "Alice",
      profile_image_url: "https://p/img.png",
    });

    const second = await poll(app, startBody.poll_token);
    expect(second.status).toBe("completed");
    expect("session_token" in second).toBe(false);
    expect(second.user).toEqual({
      id: "123",
      username: "alice",
      name: "Alice",
      profile_image_url: "https://p/img.png",
    });

    expect(await store.getSessionUser(await sha256hex(first.session_token))).toBe("123");
  });

  it("standalone flow hands the raw session token to the page at callback", async () => {
    const { app, store } = makeApp();

    const startBody = await start(app, "standalone");
    const attempt = await store.getAttemptByPollToken(startBody.poll_token);
    expect(attempt).not.toBeNull();

    const callback = await app.request(callbackUrl(attempt!.state, "CODE"));
    expect(callback.status).toBe(200);
    const html = await callback.text();
    expect(html).toContain("location.replace");
    expect(html).toContain("/play");
    expect(html).toContain("sessionStorage");

    const matches: string[] = html.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? [];
    let mintedForAlice = "";
    for (const candidate of new Set(matches)) {
      const userId = await store.getSessionUser(await sha256hex(candidate));
      if (userId === "123") mintedForAlice = candidate;
    }
    expect(mintedForAlice.length).toBeGreaterThan(0);

    const body = await poll(app, startBody.poll_token);
    expect(body.status).toBe("completed");
    expect("session_token" in body).toBe(false);
    expect(body.user).toEqual({
      id: "123",
      username: "alice",
      name: "Alice",
      profile_image_url: "https://p/img.png",
    });
  });

  it("callback rejects an unknown state without touching the X API", async () => {
    const { app, x } = makeApp();

    const res = await app.request(callbackUrl("ghost", "CODE"));

    expect(res.status).toBe(400);
    expect(x.calls).toHaveLength(0);
  });

  it("callback is single-use per attempt", async () => {
    const { app, store, x } = makeApp();

    const startBody = await start(app, "iframe");
    const attempt = await store.getAttemptByPollToken(startBody.poll_token);
    expect(attempt).not.toBeNull();
    expect((await app.request(callbackUrl(attempt!.state, "CODE"))).status).toBe(200);
    const xCallsAfterFirst = x.calls.length;

    const second = await app.request(callbackUrl(attempt!.state, "CODE2"));

    expect(second.status).toBe(400);
    expect(x.calls).toHaveLength(xCallsAfterFirst);
  });

  it("an expired attempt rejects the callback and poll reports expired", async () => {
    const first = makeApp();
    const startBody = await start(first.app, "iframe");
    const attempt = await first.store.getAttemptByPollToken(startBody.poll_token);
    expect(attempt).not.toBeNull();

    const later = makeApp(() => new Date(Date.now() + 11 * 60_000), first.lmdis);

    const callback = await later.app.request(callbackUrl(attempt!.state, "CODE"));
    expect(callback.status).toBe(400);
    expect(later.x.calls).toHaveLength(0);

    expect(await poll(later.app, startBody.poll_token)).toEqual({ status: "expired" });
  });

  it("poll reports expired for an unknown token", async () => {
    const { app } = makeApp();

    expect(await poll(app, "ghost")).toEqual({ status: "expired" });
  });

  it("poll reports pending before the callback", async () => {
    const { app } = makeApp();

    const startBody = await start(app, "iframe");

    expect(await poll(app, startBody.poll_token)).toEqual({ status: "pending" });
  });

  it("two starts produce distinct states and poll tokens", async () => {
    const { app, store } = makeApp();

    const first = await start(app, "iframe");
    const second = await start(app, "standalone");

    expect(first.poll_token).not.toBe(second.poll_token);
    const firstAttempt = await store.getAttemptByPollToken(first.poll_token);
    const secondAttempt = await store.getAttemptByPollToken(second.poll_token);
    expect(firstAttempt).not.toBeNull();
    expect(secondAttempt).not.toBeNull();
    expect(firstAttempt!.state).not.toBe(secondAttempt!.state);
  });
});

describe("AuthStore.resolveSession", () => {
  it("resolves a raw session token to its user id", async () => {
    const store = new AuthStore(makeFakeLmdis().client);
    const raw = "raw-session-token-for-resolve";
    await store.saveSession(await sha256hex(raw), "123", 1000, 9999999999999);

    expect(await store.resolveSession(raw)).toBe("123");
    expect(await store.resolveSession("wrong-token")).toBeNull();
  });
});

describe("confidential client support and failure diagnostics", () => {
  const secret = "s3cr3t";

  const tokenCallFor = async (
    depsOverride: Partial<Parameters<typeof createAuthApp>[0]>,
  ): Promise<{ headers: Record<string, string>; status: number; html: string }> => {
    const lmdis = makeFakeLmdis();
    const x = makeXApi();
    const store = new AuthStore(lmdis.client);
    const app = createAuthApp({
      store,
      xApi: x.xApi,
      clientId: CLIENT_ID,
      ...depsOverride,
    });
    const body = await start(app, "standalone");
    const state = new URL(body.authorize_url).searchParams.get("state") ?? "";
    const res = await app.request(`${ORIGIN}/auth/callback?code=C1&state=${state}`);
    const tokenCall = x.calls.find((c) => c.url === "https://api.x.com/2/oauth2/token")!;
    return {
      headers: (tokenCall.init?.headers ?? {}) as Record<string, string>,
      status: res.status,
      html: await res.text(),
    };
  };

  it("sends Basic client auth on the token exchange when a client secret is configured", async () => {
    const { headers } = await tokenCallFor({ clientSecret: secret });
    const expected =
      "Basic " + btoa(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(secret)}`);
    expect(headers["authorization"]).toBe(expected);
  });

  it("omits Authorization on the token exchange for public clients", async () => {
    const { headers } = await tokenCallFor({});
    expect(headers["authorization"]).toBeUndefined();
  });

  it("surfaces X's error redirect on the failure page without calling the X API", async () => {
    const { app, x } = makeApp();
    const res = await app.request(
      `${ORIGIN}/auth/callback?error=access_denied&error_description=denied%20by%20user`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Sign-in could not be completed");
    expect(html).toContain("access_denied");
    expect(html).toContain("denied by user");
    expect(x.calls).toHaveLength(0);
  });

  it("surfaces the token endpoint failure reason on the failure page", async () => {
    const lmdis = makeFakeLmdis();
    const failingX = async (url: string): Promise<Response> => {
      if (url === "https://api.x.com/2/oauth2/token") {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({ data: { id: "1", username: "u", name: "U" } });
    };
    const store = new AuthStore(lmdis.client);
    const app = createAuthApp({ store, xApi: failingX, clientId: CLIENT_ID });

    const body = await start(app, "iframe");
    const state = new URL(body.authorize_url).searchParams.get("state") ?? "";
    const res = await app.request(`${ORIGIN}/auth/callback?code=X&state=${state}`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_client");
  });
});

describe("profile lookup failure diagnostics", () => {
  it("completes sign-in with a synthetic friend identity when the profile lookup fails", async () => {
    const lmdis = makeFakeLmdis();
    const x = async (url: string): Promise<Response> => {
      if (url === "https://api.x.com/2/oauth2/token") {
        return Response.json({ access_token: "AT-1" });
      }
      return Response.json(
        { detail: "Forbidden", title: "Client Forbidden", reason: "client-not-enrolled" },
        { status: 403 },
      );
    };
    const store = new AuthStore(lmdis.client);
    const app = createAuthApp({ store, xApi: x, clientId: CLIENT_ID });

    const body = await start(app, "iframe");
    const state = new URL(body.authorize_url).searchParams.get("state") ?? "";
    const res = await app.request(`${ORIGIN}/auth/callback?code=X&state=${state}`);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("signed in");
    const attempt = await store.getAttemptByState(state);
    expect(attempt!.status).toBe("completed");
    expect(attempt!.user_id).toBe("unknown");
    expect(await store.getUser("unknown")).toEqual({
      id: "unknown",
      username: "friend",
      name: "friend",
    });
    const pollBody = await poll(app, body.poll_token);
    expect(pollBody.status).toBe("completed");
    expect(pollBody.user).toEqual({ id: "unknown", username: "friend", name: "friend" });
    if (typeof pollBody.session_token === "string") {
      expect(await store.resolveSession(pollBody.session_token)).toBe("unknown");
    }
  });
});

describe("auth checkpoint logging", () => {
  const eventsOf = (spy: { mock: { calls: unknown[][] } }): Array<Record<string, any>> =>
    spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as Record<string, any>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, any> => e !== null);

  it("logs structured checkpoints through the standalone happy path", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const { app, store } = makeApp();
    const body = await start(app, "standalone");
    const state = new URL(body.authorize_url).searchParams.get("state") ?? "";
    await app.request(`${ORIGIN}/auth/callback?code=C9&state=${state}`);
    await poll(app, body.poll_token);

    const events = [...eventsOf(logSpy), ...eventsOf(errSpy)];
    expect(events.some((e) => e.evt === "auth.start" && e.context === "standalone")).toBe(true);
    expect(events.some((e) => e.evt === "auth.callback" && e.has_code === true)).toBe(true);
    expect(events.some((e) => e.evt === "auth.token" && e.status === 200)).toBe(true);
    expect(events.some((e) => e.evt === "auth.profile" && e.status === 200)).toBe(true);
    const done = events.find((e) => e.evt === "auth.complete")!;
    expect(done.username).toBe("alice");
    expect(done.synthetic).toBe(false);
    expect(JSON.stringify(events)).not.toContain("AT-1");
    expect(JSON.stringify(events)).not.toContain(body.poll_token);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("logs failures with the upstream reason at the failing checkpoint", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const lmdis = makeFakeLmdis();
    const failingX = async (url: string): Promise<Response> => {
      if (url === "https://api.x.com/2/oauth2/token") {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({ data: { id: "1", username: "u", name: "U" } });
    };
    const store = new AuthStore(lmdis.client);
    const app = createAuthApp({ store, xApi: failingX, clientId: CLIENT_ID });

    const body = await start(app, "iframe");
    const state = new URL(body.authorize_url).searchParams.get("state") ?? "";
    await app.request(`${ORIGIN}/auth/callback?code=X&state=${state}`);

    const events = [...eventsOf(logSpy), ...eventsOf(errSpy)];
    const failure = events.find((e) => e.evt === "auth.callback.failed")!;
    expect(failure.reason).toBe("invalid_client");
    expect(events.some((e) => e.evt === "auth.profile")).toBe(false);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("logs the synthetic fallback when the profile lookup fails", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const lmdis = makeFakeLmdis();
    const x = async (url: string): Promise<Response> => {
      if (url === "https://api.x.com/2/oauth2/token") return Response.json({ access_token: "AT-9" });
      return Response.json({ reason: "client-not-enrolled" }, { status: 403 });
    };
    const store = new AuthStore(lmdis.client);
    const app = createAuthApp({ store, xApi: x, clientId: CLIENT_ID });

    const body = await start(app, "standalone");
    const state = new URL(body.authorize_url).searchParams.get("state") ?? "";
    await app.request(`${ORIGIN}/auth/callback?code=C&state=${state}`);

    const events = [...eventsOf(logSpy), ...eventsOf(errSpy)];
    const profileFail = events.find((e) => e.evt === "auth.profile.failed")!;
    expect(profileFail.status).toBe(403);
    expect(profileFail.reason).toBe("client-not-enrolled");
    const done = events.find((e) => e.evt === "auth.complete")!;
    expect(done.synthetic).toBe(true);
    expect(done.username).toBe("friend");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
