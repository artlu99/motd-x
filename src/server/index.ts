import { Hono } from "hono";
import { createApp } from "./app";
import { createAuthApp } from "./auth";
import { AuthStore } from "./auth-store";
import { LmdisDailyStore } from "./lmdis-store";
import { LmdisClient } from "./lmdis/sdk";
import { playerHtml } from "./player";

type Bindings = Env & { X_CLIENT_SECRET?: string };

const workerFetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  fetch(input, init)) as unknown as typeof fetch;

const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://x.com https://twitter.com https://platform.twitter.com";

const originOf = (url: string): string => new URL(url).origin;

const store = (c: { env: Bindings }): LmdisDailyStore =>
  new LmdisDailyStore(
    new LmdisClient({
      url: c.env.LMDIS_URL,
      token: c.env.LMDIS_REST_TOKEN,
      fetch: workerFetch,
    }),
  );

const authStore = (c: { env: Bindings }): AuthStore =>
  new AuthStore(
    new LmdisClient({
      url: c.env.LMDIS_URL,
      token: c.env.LMDIS_REST_TOKEN,
      fetch: workerFetch,
    }),
    { now: () => new Date() },
  );

const authDeps = (c: { env: Bindings }) => ({
  store: authStore(c),
  xApi: workerFetch,
  clientId: c.env.X_CLIENT_ID,
  clientSecret: c.env.X_CLIENT_SECRET,
  now: () => new Date(),
});

const app = new Hono<{ Bindings: Bindings }>({ strict: false });

app.get(
  "/",
  (c) =>
    c.html(
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>motd-x</title>
<meta name="twitter:card" content="player" />
<meta name="twitter:title" content="Message of the Day" />
<meta name="twitter:description" content="Today's reading — rendered live in this post." />
<meta name="twitter:image" content="${originOf(c.req.url)}/card.png" />
<meta name="twitter:player" content="${originOf(c.req.url)}/play" />
<meta name="twitter:player:width" content="480" />
<meta name="twitter:player:height" content="480" />
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 15vh auto 0; padding: 0 1.5rem; line-height: 1.55; }
h1 { margin-bottom: 0.25rem; }
code { background: #f2f2f2; padding: 0.1em 0.35em; border-radius: 4px; }
</style>
</head>
<body>
<h1>motd-x</h1>
<p>A daily message in your X feed: a Gospel reading for the day, overridable by a message-of-the-day.</p>
<p>API: <code>GET /api/daily</code> — try <a href="/api/daily">/api/daily</a></p>
<p>Source: <a href="https://github.com/artlu99/motd-x">github.com/artlu99/motd-x</a></p>
</body>
</html>`,
    ),
);

app.get("/play", (c) =>
  c.html(playerHtml(), 200, {
    "content-security-policy": FRAME_ANCESTORS,
    "cache-control": "private, no-store",
  }),
);

app.all("/auth/*", (c) => createAuthApp(authDeps(c)).fetch(c.req.raw));

const dailyHandler = (c: { env: Bindings; req: { raw: Request } }) =>
  createApp({
    store: store(c),
    fetcher: workerFetch,
    now: () => new Date(),
    auth: authStore(c),
  }).fetch(c.req.raw);

app.all("/api/daily", dailyHandler);
app.all("/api/daily/*", dailyHandler);

export default app;
