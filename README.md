# motd_x

Daily message service for an X Player Card app. Serves a Gospel reading
(bible-api.com, cached in lmdis) that can be overridden by a message-of-the-day
(MOTD) markdown document stored in lmdis.

Stack: Hono on Cloudflare Workers, lmdis (self-hosted, bearer auth) as the
only data store.

## GET /api/daily

Returns today's message: the MOTD for the day if one exists, otherwise the
Gospel reading (the default).

### Query parameters

| Param         | Values                        | Effect                                                                |
| ------------- | ----------------------------- | --------------------------------------------------------------------- |
| `date`        | `YYYY-MM-DD`, not in future   | Look up that day instead of today (UTC).                              |
| `translation` | bible-api translation id      | Gospel translation. Default `web`.                                    |
| `verify`      | `1`                           | Re-check the MOTD archive and heal the pointer (see Cron section).    |

### Responses

Gospel (default, or MOTD miss/failure):

```json
{
  "day": "2026-10-07",
  "source": "gospel",
  "reference": "Psalms 16:8",
  "text": "I have set Yahweh always before me. ...",
  "verses": [{ "book_id": "PSA", "book_name": "Psalms", "chapter": 16, "verse": 8, "text": "..." }],
  "translation": { "id": "web", "name": "World English Bible" },
  "cached": true,
  "stale": false
}
```

MOTD override:

```json
{
  "day": "2026-10-07",
  "source": "motd",
  "markdown": "# Message of the Day\n\n...",
  "version": "1791479000000",
  "cached": false,
  "stale": false
}
```

- `cached` / `stale` describe the Gospel cache only; `stale: true` means the
  last-good reading was served because bible-api.com was unreachable.
- Success responses carry `Cache-Control: public, s-maxage=<seconds to UTC
  midnight>`.

### Errors

| Status | Body                                        | Meaning                                                      |
| ------ | ------------------------------------------- | ------------------------------------------------------------ |
| 400    | `{"error":"invalid_date"}`                  | Malformed or impossible `date` (`2026-02-30`).               |
| 400    | `{"error":"future_date"}`                   | `date` after today (UTC).                                    |
| 400    | `{"error":"invalid_translation"}`           | Unknown translation id.                                      |
| 502    | `{"error":"upstream_unavailable"}`          | bible-api.com failed and the Gospel cache is empty.          |
| 503    | `{"error":"cache_unavailable","message":…}` | lmdis is unreachable/unauthorized while bible-api.com also failed. |

## Cron: periodic self-healing

```bash
curl -fsS "https://<your-domain>/api/daily?verify=1" > /dev/null
```

`?verify=1` is safe to run on a schedule (hourly is plenty):

- Healthy pointer → 2 extra lmdis ops (KEYS + GET), no writes, no behavior
  change. A no-op costs almost nothing.
- Pointer missing/corrupt (upload's second POST failed) → the Worker adopts
  the newest archive version and re-writes the pointer.
- Pointer older than the newest archive version → the Worker repoints to it.

Healing is best-effort: if the healing write fails, the discovered entry is
still served and the next cron run retries. The endpoint is idempotent.

Example crontab:

```
17 * * * * curl -fsS "https://<your-domain>/api/daily?verify=1" > /dev/null
```

## Uploading a MOTD (out-of-band)

Two POSTs to lmdis — archive first, then the pointer (order matters: a crash
between them is healed by the endpoint above):

```bash
DAY=2026-10-07
TS=$(date +%s%3N)

# 1. immutable archive copy (raw markdown)
curl -sS -X POST "$LMDIS_URL/" -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[\"SET\",\"motd-x:daily:v1:motd:$DAY:$TS\",\"# Message ...\"]"

# 2. the pointer the Worker reads (JSON envelope)
curl -sS -X POST "$LMDIS_URL/" -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[\"SET\",\"motd-x:daily:v1:motd:$DAY\",\"{\\\"version\\\":\\\"$TS\\\",\\\"markdown\\\":\\\"# Message ...\\\"}\"]"
```

Key layout:

| Key                                        | Value                 | Role                                        |
| ------------------------------------------ | --------------------- | ------------------------------------------- |
| `motd-x:daily:v1:motd:{day}`               | `{"version","markdown"}` JSON | Pointer — the only key the Worker reads first |
| `motd-x:daily:v1:motd:{day}:{epoch-ms}`    | raw markdown          | Immutable archive, used for healing/verify  |
| `motd-x:daily:v1:{day}:{translation}`      | JSON Gospel reading   | Gospel cache                                |
| `motd-x:daily:v1:latest`                   | JSON Gospel reading   | Most recent Gospel cache entry (stale fallback) |

Notes:

- Versions never get deleted by the service; older ones are history.
- An empty `markdown` in the pointer means "no message today" — a kill switch
  that does not require deleting anything.
- Gospel readings cache themselves for the day on first request; no cron
  needed for the Gospel path.

## Local development

```bash
bun install
cp .dev.vars.example .dev.vars   # paste your lmdis dev token
bun test
bun run dev                      # wrangler dev on :8787
```

## Deploy

```bash
wrangler secret put LMDIS_REST_TOKEN
bun run deploy
```
