import { Hono } from "hono";
import type { AuthStore, XUser } from "./auth-store";

const ATTEMPT_TTL_MS = 600_000;
const SESSION_TTL_MS = 30 * 86_400_000;
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";
const USERS_ME_ENDPOINT =
  "https://api.x.com/2/users/me?user.fields=profile_image_url,username,name";
const SCOPE = "tweet.read users.read";

export type AuthDeps = {
  store: AuthStore;
  xApi: (url: string, init?: RequestInit) => Promise<Response>;
  clientId: string;
  clientSecret?: string;
  now?: () => Date;
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const randomToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
};

const sha256hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const s256Challenge = async (verifier: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

const logAuth = (
  evt: string,
  fields: Record<string, unknown>,
  level: "log" | "error" = "log",
): void => {
  const line = JSON.stringify({ evt, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

const parseXUser = (value: unknown): XUser | null => {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.username !== "string" ||
    typeof row.name !== "string"
  ) {
    return null;
  }
  const user: XUser = { id: row.id, username: row.username, name: row.name };
  if (typeof row.profile_image_url === "string") user.profile_image_url = row.profile_image_url;
  return user;
};

const escapeReason = (reason: string): string =>
  reason.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const failurePage = (reason?: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><p>Sign-in could not be completed.</p>${
    reason ? `<p>Reason: ${escapeReason(reason)}</p>` : ""
  }<p><a href="/play">Try again</a></p></body></html>`;

const iframeSuccessPage = (): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head><body><p>You are signed in — closing…</p><script>window.close();</script></body></html>`;

const standaloneSuccessPage = (sessionToken: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head><body><p>You are signed in — continuing…</p><script>sessionStorage.setItem("motd_session", ${JSON.stringify(sessionToken)});location.replace("/play");</script></body></html>`;

export function createAuthApp(deps: AuthDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const app = new Hono({ strict: false });

  app.get("/auth/start", async (c) => {
    const context = c.req.query("context");
    if (context !== "iframe" && context !== "standalone") {
      return c.html(failurePage(), 400);
    }
    const state = randomToken();
    const pollToken = randomToken();
    const codeVerifier = randomToken();
    const codeChallenge = await s256Challenge(codeVerifier);
    const redirectUri = `${new URL(c.req.url).origin}/auth/callback`;
    const authorizeUrl =
      `${AUTHORIZE_URL}?response_type=code` +
      `&client_id=${encodeURIComponent(deps.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(SCOPE)}` +
      `&state=${encodeURIComponent(state)}` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&code_challenge_method=S256`;
    const nowMs = now().getTime();
    await deps.store.createAttempt({
      poll_token: pollToken,
      state,
      code_verifier: codeVerifier,
      context,
      status: "pending",
      user_id: null,
      created_at: nowMs,
      expires_at: nowMs + ATTEMPT_TTL_MS,
    });
    logAuth("auth.start", { context, attempt_ttl_ms: ATTEMPT_TTL_MS });
    return c.json({ authorize_url: authorizeUrl, poll_token: pollToken });
  });

  app.get("/auth/callback", async (c) => {
    const xError = c.req.query("error");
    logAuth("auth.callback", {
      has_code: (c.req.query("code") ?? "") !== "",
      has_state: (c.req.query("state") ?? "") !== "",
      error: xError || undefined,
    }, xError ? "error" : "log");
    if (xError !== undefined && xError !== "") {
      const description = c.req.query("error_description") ?? "";
      const reason = `${xError}${description ? `: ${description}` : ""}`;
      logAuth("auth.callback.failed", { reason }, "error");
      return c.html(failurePage(reason), 400);
    }
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const attempt = state === "" ? null : await deps.store.getAttemptByState(state);
    logAuth("auth.state", {
      found: attempt !== null,
      status: attempt?.status ?? null,
    }, attempt && attempt.status === "pending" ? "log" : "error");
    if (attempt === null || attempt.status !== "pending") {
      return c.html(failurePage("unknown or expired sign-in attempt"), 400);
    }
    if (!(await deps.store.claimCallback(state))) {
      logAuth("auth.claim", { won: false }, "error");
      return c.html(failurePage("sign-in attempt already completed"), 400);
    }
    const fail = async (reason: string): Promise<Response> => {
      logAuth("auth.callback.failed", { reason }, "error");
      await deps.store.releaseCallback(state);
      return c.html(failurePage(reason), 400);
    };
    const origin = new URL(c.req.url).origin;
    const tokenHeaders: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (deps.clientSecret !== undefined) {
      tokenHeaders.authorization =
        "Basic " +
        btoa(`${encodeURIComponent(deps.clientId)}:${encodeURIComponent(deps.clientSecret)}`);
    }
    const tokenRes = await deps.xApi(TOKEN_ENDPOINT, {
      method: "POST",
      headers: tokenHeaders,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${origin}/auth/callback`,
        client_id: deps.clientId,
        code_verifier: attempt.code_verifier,
      }),
    });
    logAuth("auth.token", { status: tokenRes.status }, tokenRes.ok ? "log" : "error");
    if (!tokenRes.ok) {
      const detail = (await tokenRes.json().catch(() => null)) as { error?: unknown } | null;
      const reason =
        typeof detail?.error === "string"
          ? detail.error
          : `token request failed with status ${tokenRes.status}`;
      return fail(reason);
    }
    const tokenBody = (await tokenRes.json().catch(() => null)) as {
      access_token?: unknown;
    } | null;
    const accessToken =
      typeof tokenBody?.access_token === "string" ? tokenBody.access_token : null;
    if (accessToken === null) return fail("token response contained no access_token");
    const meRes = await deps.xApi(USERS_ME_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    let user: XUser | null = null;
    if (meRes.ok) {
      const meBody = (await meRes.json().catch(() => null)) as { data?: unknown } | null;
      user = parseXUser(meBody?.data);
    }
    logAuth("auth.profile", { status: meRes.status }, meRes.ok ? "log" : "error");
    let synthetic = false;
    if (user === null) {
      const meDetail = meRes.ok
        ? null
        : ((await meRes.json().catch(() => null)) as Record<string, unknown> | null);
      logAuth("auth.profile.failed", {
        status: meRes.status,
        reason: typeof meDetail?.reason === "string" ? meDetail.reason : null,
        title: typeof meDetail?.title === "string" ? meDetail.title : null,
        detail: typeof meDetail?.detail === "string" ? meDetail.detail : null,
        type: typeof meDetail?.type === "string" ? meDetail.type : null,
        registration_url:
          typeof meDetail?.registration_url === "string" ? meDetail.registration_url : null,
      }, "error");
      synthetic = true;
      user = { id: "unknown", username: "friend", name: "friend" };
    }
    await deps.store.completeAttempt(state, user.id);
    await deps.store.upsertUser(user);
    logAuth("auth.complete", {
      username: user.username,
      synthetic,
      context: attempt.context,
    });
    if (attempt.context === "standalone") {
      const sessionToken = randomToken();
      const nowMs = now().getTime();
      await deps.store.saveSession(
        await sha256hex(sessionToken),
        user.id,
        nowMs,
        nowMs + SESSION_TTL_MS,
      );
      return c.html(standaloneSuccessPage(sessionToken));
    }
    return c.html(iframeSuccessPage());
  });

  app.get("/auth/poll", async (c) => {
    const token = c.req.query("token") ?? "";
    const attempt = token === "" ? null : await deps.store.getAttemptByPollToken(token);
    if (attempt === null || attempt.status === "expired") {
      logAuth("auth.poll", { found: attempt !== null, status: "expired" });
      return c.json({ status: "expired" });
    }
    if (attempt.status === "pending") {
      return c.json({ status: "pending" });
    }
    const user = attempt.user_id === null ? null : await deps.store.getUser(attempt.user_id);
    if (attempt.context === "iframe" && (await deps.store.beginMint(token))) {
      const sessionToken = randomToken();
      const nowMs = now().getTime();
      await deps.store.saveSession(
        await sha256hex(sessionToken),
        attempt.user_id ?? "",
        nowMs,
        nowMs + SESSION_TTL_MS,
      );
      return c.json({ status: "completed", session_token: sessionToken, user });
    }
    return c.json({ status: "completed", user });
  });

  return app;
}
