---
name: embed-web-app-x-feed
description: >
  Build interactive web apps that run inside X (Twitter) posts via Player Cards:
  the post embeds a small live web app (polls, games, guestbooks, leaderboards,
  quizzes, predictions) where users sign in with their X account and take verified
  actions. Use this skill whenever the user wants to embed a web app in an X post
  or timeline, build a "playable" or interactive tweet card, put an app inside the
  X feed, use X Player Cards or twitter:card=player, verify users via X OAuth
  sign-in, or generalize the pattern of apps like a guestbook that lives inside a
  post. Also use it when the user mentions "X-embedded app", "in-feed app",
  "player card app", or wants an app shared as a post that readers can interact
  with without leaving X.
---

# X-Embedded Web Apps (Player Cards)

Build a web app that lives inside an X post. X's Player Card feature normally
embeds audio/video players in posts, but nothing forces the "player" to be media:
it can be any HTTPS web page. That page is your app, rendered in a small iframe in
the timeline. Proven reference implementation: a guestbook at
guestbook.stupidtech.net (sign in with X, leave a signature, all inside a post).

## How the trick works

When a post URL is shared, X's crawler (`Twitterbot`) reads raw HTML meta tags.
It does NOT run JavaScript. The shared URL's server response must include:

```html
<meta name="twitter:card" content="player" />
<meta name="twitter:title" content="Sign the guestbook" />
<meta name="twitter:description" content="Add your name to the book." />
<meta name="twitter:image" content="https://example.com/card.png" />
<meta name="twitter:player" content="https://example.com/play/book-1" />
<meta name="twitter:player:width" content="480" />
<meta name="twitter:player:height" content="480" />
```

- `twitter:player` points at the app page X renders in an iframe (480x480 is a
  good square; the timeline card is narrow, design for ~440px width).
- `twitter:image` is the fallback preview shown where players don't render.
- Metadata must be server-rendered on the shared URL. Client-side SPA index.html
  tags are invisible to the crawler if the server can't emit them.
- The player URL may carry app state in its path (e.g. `/play/book-1`,
  `/play/poll/42`) so one deployment can serve many app instances.
- The player page must be framable: never send `X-Frame-Options: DENY` or
  `SAMEORIGIN` on it. If you set CSP `frame-ancestors`, allow
  `https://x.com`, `https://twitter.com`, and `https://platform.twitter.com`.
  A blocked frame is the most common "card shows but won't play" failure.

## Three runtime contexts (design for all three)

The same player URL runs in different environments with different capabilities.
Detect at runtime; never assume:

1. **iframe inside x.com (web)** — small viewport, likely sandboxed with an
   opaque origin: cookies, localStorage, and sessionStorage may throw
   SecurityError or be unavailable. Sign-in happens in a separate popup tab;
   the card polls the backend to learn when auth completed. Session state then
   lives in memory only.
2. **Fullscreen viewer in the native X app** — opens the player URL in the
   app's web viewer. Storage usually works; sign-in can redirect in the same
   view and return.
3. **Standalone browser** (direct link) — a normal web app. Storage works.

Context detection pattern:

```ts
const inIframe = window.self !== window.top;
const storageOk = (() => {
  try { sessionStorage.setItem("__probe", "1"); sessionStorage.removeItem("__probe"); return true; }
  catch { return false; }
})();
```

Always render the read-only view first (public data), then upgrade to the
signed-in experience once auth completes. The card must be useful before
sign-in — most viewers read, few sign in.

## Auth: X OAuth 2.0 + PKCE, backend-only tokens

Being embedded in a post tells you nothing about who the user is. No referrer
checks, no iframe identity, no postMessage trust. Identity comes only from a
completed OAuth 2.0 authorization code flow with PKCE (public client):

- Scopes: `tweet.read users.read` (X requires these for the `/2/users/me`
  profile lookup; request nothing more unless truly needed).
- Backend generates `state` + `code_verifier` (S256 challenge), stores a
  pending auth attempt with a ~10 minute expiry, redirects to
  `https://x.com/i/oauth2/authorize?...`.
- Backend callback exchanges the code for tokens, calls
  `GET https://api.x.com/2/users/me?user.fields=profile_image_url,username,name`,
  upserts the user, then issues the app its OWN session token (random, stored
  hashed server-side, ~30 day expiry). X access/refresh tokens stay server-side,
  never sent to the frontend.
- Two UX branches:
  - iframe: `window.open(authUrl)`; card polls `GET /auth/poll?token=...` with
    a per-attempt poll token (separate from the OAuth state) until status flips
    to completed/expired, then receives the session in the poll response.
    Polling beats postMessage here: the popup's `window.opener` link can be
    severed (COOP) and message delivery isn't guaranteed, while the backend is
    always reachable from the card.
  - standalone/fullscreen: persist the pending attempt in sessionStorage (probe
    availability first; if unavailable, explain before navigating), redirect
    same-window, resume after returning from X.

Full details, endpoints, and schema: read `references/oauth.md`.

## Reference architecture (opinionated)

Vanilla TypeScript + Vite frontend; Hono app on Cloudflare Workers serving the
share-page meta tags, the player page, and the JSON API; Cloudflare D1 for data.
One Worker can do all three. Data model that generalizes well:

- `users` — X id (PK), username, display name, avatar URL
- `entries` — per-app-instance record: instance id + user id + payload
  (message, vote, score...), `UNIQUE(instance_id, user_id)` so repeat actions
  update rather than duplicate
- `auth_attempts` — state, code_verifier, poll_token, context, status, expiry
- `sessions` — token_hash, user_id, expiry

Details, schema SQL, project layout, and key code: `references/architecture.md`.

## Security invariants (non-negotiable)

These exist because the app runs inside someone else's page and inside iframes:

1. Identity ONLY from completed OAuth server-side. Never from iframe context,
   referrer, origin of postMessage, or "the request came from the card".
2. All writes validated against a verified session (or completed auth attempt
   in the iframe flow).
3. X access tokens never leave the backend.
4. Auth attempts expire (~10 min) and are single-use; validate `state`.
5. Server stores session token hashes, not raw tokens.
6. Public reads are safe by design; rate-limit them anyway.

## Build order

1. **Define the concept.** What is the shared object ("book #1", "poll 42")?
   What is the one verified action (sign, vote, guess, submit)? Can a repeat
   action update instead of duplicate (one entry per user per instance)?
2. **Scaffold.** Vite vanilla-TS frontend; Hono Worker with D1. Server-render
   the meta tags on the share URL and serve the player page from the same
   Worker. Add a square `card.png` fallback image.
3. **Read-only path first.** Player page renders public data immediately, in
   all three contexts, without auth. This is the bulk of real usage.
4. **Auth.** Implement `references/oauth.md` both branches. Show distinct
   states: loading / read-only / pending-signin / signed-in / error.
5. **Verified writes.** POST with session (or poll-flow completion), upsert on
   the unique constraint, refresh the public list.
6. **Deploy.** Custom domain (stable HTTPS share URL is the product), then:
   - Verify with `curl -s https://domain/ | grep twitter:player` — the crawler
     sees raw HTML only.
   - Validate the card in X's card validator; X caches card metadata, so
     cache-bust via a query param on the share URL (`?v=2`) when tags change.
7. **Test the untestable.** You cannot fully reproduce X's sandboxed iframe
   locally. Build a local harness page that iframes the player URL with
   `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` and a
   480x480 viewport to approximate it; confirm graceful degradation when
   storage is unavailable. Final check: real post on X.

## Pitfalls

- Serving meta tags only to Twitterbot UA or redirecting the crawler: fragile
  and against the spirit of the platform; just serve the tags to everyone.
- Building auth iframe-first: the popup+poll flow is the hard part; leave it
  until the read-only view works.
- Forgetting the iframe branch when issuing sessions: iframe users may not be
  able to hold cookies; deliver the session token in the poll response and keep
  it in memory, accepting re-auth per card load.
- Long relative timestamps and layout overflow: the card is tiny; test at
  440x480.
- X's card cache: after changing meta tags, an unchanged share URL may keep
  showing the old card. Bust with a query param.
