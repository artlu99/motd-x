# Reference Architecture: Hono + Cloudflare Workers + D1 + Vite

One Worker serves everything: share-page meta tags, the player page, static
assets, and the JSON API. Read this when scaffolding or wiring the backend.

## Project layout

```
/
├── src/
│   ├── server/
│   │   ├── index.ts        # Hono app: meta pages, player shell, API, auth
│   │   ├── meta.ts         # server-rendered card meta tags (share URLs)
│   │   └── db.ts           # D1 query helpers
│   └── client/
│       ├── player/         # player page app (entry: index.html + main.ts)
│       │   ├── main.ts
│       │   ├── context.ts  # iframe/storage detection
│       │   └── auth.ts     # sign-in branches (popup+poll / redirect)
│       └── landing/        # share URL landing page (also card host)
├── public/card.png         # fallback preview image (square, legible at ~130px)
├── migrations/0001_init.sql
├── vite.config.ts          # multi-page: landing + player entries
├── wrangler.toml / wrangler.jsonc
└── package.json
```

## Vite multi-page

```ts
// vite.config.ts
import { defineConfig } from "vite";
export default defineConfig({
  build: { rollupOptions: { input: {
    landing: "index.html",
    player: "src/client/player/index.html",
  }}},
});
```

Two build outputs. The Worker embeds or serves both; the player shell HTML is
what `twitter:player` points at (`/play/:id`). Keep the player bundle small —
it loads inside a card.

## Serving meta tags + player shell from Hono

The share URL (landing) must emit player meta tags from the server. The player
URL itself does NOT need the tags (the crawler doesn't render it), but serving
plain HTML there is fine.

```ts
const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.html(renderLandingMeta(c)));        // share URL: <head> with player tags
app.get("/play/:id", (c) => c.html(playerShell(c.req.param("id"))));
app.route("/auth", authRoutes);
app.route("/api", apiRoutes);
app.use("/assets/*", serveAssets ...);                     // Workers static assets
```

With Cloudflare Workers Static Assets, attach the built assets to the Worker
and add `run_worker_first` for the HTML routes, or simply inline the two tiny
HTML shells in the Worker and serve JS/CSS from assets.

Keep the player route framable: no `X-Frame-Options` header at all, or CSP
`frame-ancestors https://x.com https://twitter.com https://platform.twitter.com`.
A default-secure template that ships `X-Frame-Options: SAMEORIGIN` will break
the card silently — check headers on every route that X iframes.

Validate locally what the crawler sees:

```bash
curl -s http://localhost:8787/ | grep -E 'twitter:(card|player)'
```

## D1 schema (generalized)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,      -- X user id (string, big numbers!)
  username      TEXT NOT NULL,
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE entries (
  instance_id   TEXT NOT NULL,         -- app instance, e.g. 'book-1', 'poll-42'
  user_id       TEXT NOT NULL,
  payload       TEXT NOT NULL,         -- JSON: message, choice, score...
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (instance_id, user_id)   -- one entry per user per instance;
);                                     -- INSERT ... ON CONFLICT DO UPDATE upserts

CREATE TABLE auth_attempts (  -- see references/oauth.md for full version
  poll_token TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  context TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id TEXT,
  session_minted INTEGER NOT NULL DEFAULT 0,  -- poll delivers raw session once
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_instance ON entries (instance_id, updated_at DESC);
```

X user ids exceed JavaScript's safe integer range in some clients — treat them
as strings everywhere.

## API surface (generalized)

- `GET /api/instances/:id/entries` — public, newest-first, capped (e.g. 50).
  Include profile info per entry (join or batch user lookup).
- `POST /api/instances/:id/entries` — requires `Authorization: Bearer
  <session>`; body `{ payload }`; upsert on PK; returns the updated entry.
- `DELETE /api/instances/:id/entries` — optional: remove own entry.
- Auth routes: see references/oauth.md.

Validation: instance ids against an allowlist/regex, payload size (e.g.
messages ≤ 280 chars), and content-type. Public reads get basic rate limiting
(e.g. per-IP via Workers rate limiting binding or a KV counter) — cheap
insurance, not identity.

## Hono + D1 idiom

```ts
app.post("/api/instances/:id/entries", async (c) => {
  const user = await requireSession(c);           // hash lookup in sessions
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const payload = await parseAndValidate(c);      // size/type checks
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO entries (instance_id, user_id, payload, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (instance_id, user_id) DO UPDATE SET payload = ?3, updated_at = ?4`
  ).bind(c.req.param("id"), user.id, JSON.stringify(payload), now).run();
  return c.json({ ok: true });
});
```

## Config

`wrangler.jsonc`: D1 binding `DB`, vars `CLIENT_ID`, secrets via
`wrangler secret put`: none needed for public-client PKCE unless you add
token persistence (then store X refresh tokens encrypted or not at all — the
reference guestbook stores only the profile it already fetched).

Deploy: `bunx wrangler deploy` (or `npx wrangler deploy`), attach the custom
domain in the Cloudflare dashboard — the share URL is stable product identity;
do not ship on `*.workers.dev` if you can avoid it.

## Local dev + iframe harness

- `bunx wrangler dev` + `bun run build --watch` (or Vite dev server proxying
  API) for the loop.
- You cannot reproduce X's real iframe. Approximate it:

```html
<!-- harness.html, served from a different port/origin -->
<iframe src="https://localhost:8787/play/book-1"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        width="440" height="480"></iframe>
```

This strips storage and same-origin access like a sandboxed card would. Confirm
the read-only view renders, sign-in opens a popup, polling completes, and the
card recovers when storage probes fail. Then validate the real card on X
(card validator + a test post on a throwaway account if needed).
