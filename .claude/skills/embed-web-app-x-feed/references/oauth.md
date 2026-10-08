# X OAuth 2.0 + PKCE for Player Card Apps

This file details the full sign-in implementation. Read it when building auth.
Everything here assumes the app's public client setup in the X developer portal:

- Create an app (project) at developer.x.com.
- Enable **User authentication settings**: App permissions = Read; Type of App =
  Single page App / public client (no client secret); Callback URI =
  `https://<domain>/auth/callback`; Website URL = `https://<domain>/`.
- Note the **Client ID** (public). Put it in Worker config/vars.

Why PKCE public client: the frontend cannot hold secrets (it may be a sandboxed
iframe), and the backend exchanging the code needs the code_verifier it
provisioned — which doubles as proof the redirect came from a flow we started.

## Endpoints (X side)

- Authorize: `https://x.com/i/oauth2/authorize`
- Token: `https://api.x.com/2/oauth2/token` (POST, form-encoded)
- Profile: `GET https://api.x.com/2/users/me?user.fields=profile_image_url,username,name`
  (Bearer access token; requires `tweet.read users.read` scopes)

## Pending auth attempts (D1)

```sql
CREATE TABLE auth_attempts (
  poll_token   TEXT PRIMARY KEY,        -- given to the card for polling
  state        TEXT NOT NULL UNIQUE,    -- given to X in the authorize URL
  code_verifier TEXT NOT NULL,
  context      TEXT NOT NULL,           -- 'iframe' | 'standalone'
  status       TEXT NOT NULL,           -- 'pending' | 'completed' | 'expired'
  user_id      TEXT,                    -- set on completion
  session_minted INTEGER NOT NULL DEFAULT 0,  -- single-delivery flag (poll)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL         -- created_at + 10 min
);
```

- `poll_token` and `state` are separate random values. The poll token is what
  the card holds; it must never double as the OAuth state (and vice versa) so a
  leak of one doesn't compromise the other channel.
- The iframe branch picks its session up through the poll endpoint. Mint the
  session **at poll-pickup time** (first `completed` fetch) rather than
  storing a raw session token in the attempt row: only session hashes ever sit
  at rest, and the raw token is returned exactly once.
- Purge or ignore expired attempts lazily (check `expires_at` on every read).

## Starting sign-in: `GET /auth/start?context=iframe|standalone`

Backend:
1. Generate `state`, `code_verifier` (43-128 chars, unreserved chars),
   `poll_token` (URL-safe random).
2. Insert attempt with status `pending`, 10-minute expiry.
3. Build the authorize URL:

```
https://x.com/i/oauth2/authorize
  ?response_type=code
  &client_id=<CLIENT_ID>
  &redirect_uri=https://<domain>/auth/callback
  &scope=tweet.read%20users.read
  &state=<state>
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &code_challenge_method=S256
```

4. Respond JSON `{ authorize_url, poll_token }`. The card calls this with
   `fetch`, then either `window.open(authorize_url)` (iframe) or
   `location.assign(authorize_url)` after persisting `{ poll_token }` to
   sessionStorage (standalone, only if storage probe passed).

Why `fetch`-then-navigate instead of a plain link: the backend must know the
attempt's context and generate fresh secrets; a pre-generated link in HTML
would be reusable and predictable.

## Callback: `GET /auth/callback?code=...&state=...`

Backend:
1. Look up the attempt by `state`; reject if missing, expired, or not pending
   (single-use: flip status before the token exchange).
2. Exchange the code:

```
POST https://api.x.com/2/oauth2/token
grant_type=authorization_code
code=<code>
redirect_uri=https://<domain>/auth/callback
client_id=<CLIENT_ID>
code_verifier=<verifier>
```

3. Call `/2/users/me` with the access token. Upsert `users` by X user id.
4. Update the attempt: status `completed`, `user_id`. Do NOT mint the app
   session here — the poll endpoint mints it on pickup (below), so no raw
   session token is ever stored in the attempt row.
5. Respond based on context:
   - standalone: mint the session here instead (the client won't poll), then
     small HTML that clears sessionStorage's pending marker and
     `location.replace('/play/<instance>')` (or the saved return URL).
   - iframe: "You're signed in — return to the X tab" static page; the popup
     can `window.close()` in many browsers since it was user-opened.

## Polling: `GET /auth/poll?token=...` (iframe branch)

- Card polls every ~2s while its sign-in UI is visible; stop after the attempt
  expiry to avoid a zombie interval.
- While `pending`: `200 { status: "pending" }`.
- On the first `completed` fetch: atomically flip `session_minted` 0→1, mint
  the session (random 32-byte token; store only SHA-256(token) in `sessions`),
  and respond `200 { status: "completed", session_token, user }` — the single
  delivery of the raw token. The card keeps the session **in memory only**
  (sandboxed iframes have no storage) and re-auths on next card load —
  acceptable because signing in is quick.
- On later fetches of a minted attempt: `200 { status: "completed", user }`
  with no token (idempotent for the standalone resume path, harmless for the
  card).
- On expiry: `200 { status: "expired" }`; card resets its sign-in UI.
- Cap poll responses' lifetime honestly: never return another attempt's data.

## Standalone resume

On player page load, if a pending poll_token is in sessionStorage: call
`/auth/poll` once; if completed, adopt the session and clear the marker; if
pending, resume polling (user may have bailed mid-flow); if expired, clear.

## Sessions

```sql
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 hex of raw token
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL           -- 30 days
);
```

- Standalone: persist the raw token in localStorage; send as
  `Authorization: Bearer <token>` on writes. (Prefer header over cookie: the
  card may run in a context where cookies are dropped.)
- Sign-out: delete the session row (standalone clears local copy; iframe just
  drops memory).

## Error states the UI must cover

- `expired` attempt ("sign-in timed out, try again")
- storage unavailable in standalone (explain BEFORE navigating away)
- popup blocked (show a manual "open sign-in" link as fallback)
- X denies / user cancels (callback page with a retry link)

## Deployment notes (observed 2026-10)

Platform behavior that cost real debugging time. Timely — re-verify before relying on it.

- **`GET /2/users/me` can 403 with `client-not-enrolled` / `client-forbidden` even when everything you control is correct.** Seen on the Free plan and on brand-new Pay-Per-Use projects: authorize succeeds, the code exchange succeeds, and the profile lookup 403s. Causes seen in the wild: the App is not attached to a Project; a new Project/App enrolled in the wrong product (e.g. Ads instead of Pay Per Use); backend enrollment lag or bugs. X staff have fixed several of these by hand after developers posted their App ID in a devcommunity thread — that escalation path works.
- **`tweet.read` is required for `/2/users/me` even though it looks irrelevant** (the endpoint supports tweet-related expansions) — `users.read` alone 403s. Request both scopes.
- **Confidential apps require the client secret at the token exchange** (`Authorization: Basic base64(urlencode(client_id):urlencode(client_secret))`); public/SPA apps must not send it. Make the secret optional in code so both app types work, and check the app's "Type of App" if the exchange 401s. Changing an app's type can rotate the Client ID.
- **Capture the full error body** (`reason`, `title`, `detail`, `type`, `registration_url`) when the profile lookup fails — X's `detail` text is specific (e.g. "you must use keys and tokens from a developer App that is attached to a Project") and `registration_url` often links straight to the fix. None of it is secret: log it and render the reason on the failure page.
- **Identity without `/2/users/me` does not exist on any plan.** Access tokens are opaque (no JWT/id_token), the callback redirect carries no user hint, and no other Free/Pay-Per-Use endpoint reveals identity. If the endpoint is unavailable, the only options are a fallback identity or out-of-band binding (e.g. one-time claim codes distributed to known users). Do not parse logs or traces for identity — there is nothing there.
- **Session storage per context:** sandboxed iframe → memory only (re-auth per card load). Standalone → `sessionStorage` survives the OAuth redirect; `localStorage` additionally survives browser restarts, making sign-in a once-per-device event. Probe storage availability before relying on it.
