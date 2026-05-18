# Pebble Sports Worker

Cloudflare Worker backend for the **Sports Simplified** Pebble watchapp.

Replaces the Replit-hosted Node.js backend. Same endpoints, same pin
behaviour, but:

- **Free, forever** — runs entirely within Cloudflare's free tier
  (100k requests/day, KV storage, unlimited cron triggers).
- **Always-on cron** — pushes timeline pins to your watch every 2
  minutes during game windows, regardless of whether the watch app
  is open. No more "must open the app to update pins".
- **No server to sleep** — Workers run on demand at the edge, no idle
  timeout, no keepalive hacks.

---

## What's inside

| File | Purpose |
|---|---|
| `wrangler.toml` | Worker config (cron + KV binding) |
| `src/index.ts` | Entry: `fetch()` + `scheduled()` handlers |
| `src/types.ts` | Game / team / registry types |
| `src/espn.ts` | ESPN API fetcher (NHL, NBA, MLB, NFL, FIFA WC) |
| `src/pin.ts` | Pin builder + Rebble Timeline push + cron tick |
| `src/registry.ts` | KV-backed user registry (replaces `sports-users.json`) |
| `src/routes.ts` | HTTP route handlers |
| `src/settings-page.ts` | Settings HTML page (verbatim from original) |
| `patched-pkjs/index.js` | Watch app pkjs with the new `COMPANION_URL` |

---

## API surface (unchanged from Replit)

| Endpoint | Purpose |
|---|---|
| `GET /settings` | Settings HTML page for team picker |
| `GET /api/sports/teams?sport=X` | Team list for picker (X = nhl, nba, mlb, nfl, fifa-wc) |
| `GET /api/sports/games?sport=X&teams=Y,Z` | Game list for followed teams |
| `GET /api/sports/fifa-wc/games?teams=...` | Legacy FIFA-WC games endpoint |
| `POST /api/sports/timeline/register` | Watch registers `timelineToken` + followed teams |
| `GET /` or `/health` | Health check |

---

## Deployment

### 1. Install Wrangler and log in

```bash
cd pebble-sports-worker
npm install
npx wrangler login
```

This opens a browser window. Sign up for a free Cloudflare account if
you don't have one and authorize Wrangler.

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create SPORTS_KV
```

Wrangler will print something like:

```
🌀 Creating namespace with title "pebble-sports-worker-SPORTS_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "SPORTS_KV"
id = "abc123def456..."
```

Copy that `id` value and paste it into `wrangler.toml` where it says
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Deploy

```bash
npx wrangler deploy
```

Wrangler will print your Worker URL, something like:

```
https://pebble-sports-worker.<your-account>.workers.dev
```

Copy that URL — that's your new `COMPANION_URL`.

### 4. Verify the Worker is alive

```bash
curl https://pebble-sports-worker.<your-account>.workers.dev/health
# → {"ok":true,"service":"pebble-sports-worker"}

curl 'https://pebble-sports-worker.<your-account>.workers.dev/api/sports/teams?sport=nhl' \
  | head -c 200
# → first ~200 chars of the NHL team list JSON
```

### 5. Update the watch app's `COMPANION_URL`

Open `pebble-sports-app/src/pkjs/index.js` in your watch app repo
(`saintyoga-Cyber/sports-simplified` or wherever it lives) and change
line 3:

```js
// BEFORE:
var COMPANION_URL = 'https://pebble-connect--saintyoga1.replit.app';
// AFTER:
var COMPANION_URL = 'https://pebble-sports-worker.<your-account>.workers.dev';
```

A pre-patched copy is in `patched-pkjs/index.js` of this repo — just
replace the placeholder URL with your real Worker URL.

### 6. Rebuild and sideload the .pbw

In the watch app repo, run your usual Pebble SDK build:

```bash
pebble build
pebble install --phone <your-phone-ip>
```

### 7. One-time registration

Open the Sports Simplified app on your watch **once**. The pkjs will:

- Read your saved teams from phone localStorage (preserved from before)
- Call `Pebble.getTimelineToken()` and POST it to the new Worker
- The Worker stores it in KV; from now on, the cron pushes pins to
  your timeline whether or not the app is open

That's it. Your timeline will start receiving pins for every followed
team's games passively, in the background.

---

## Free tier usage (your scale)

For 1–5 registered users following ~5 games/day across 5 sports:

| Resource | Free allowance | Estimated usage |
|---|---|---|
| Worker requests | 100k/day | ~600–800/day |
| KV reads | 100k/day | ~3k/day |
| KV writes | 1k/day | ~50/day |
| KV storage | 1 GB | < 1 MB |
| Cron invocations | unlimited | 480/day (skipping quiet hours) |

Comfortably free, permanently.

---

## Cron schedule details

The cron fires every 2 minutes (`*/2 * * * *` in UTC) but the handler
**skips ESPN polling during UTC 08:00–11:59** — that's 4am–8am ET /
1am–5am PT, when no major North American sports are live. This saves
~25% of ESPN calls without affecting pin delivery.

If you only follow FIFA WC and care about matches outside that
window, edit `isInCronWindowUTC()` in `src/pin.ts` to return `true`
unconditionally.

---

## What changed vs. the Replit backend

| | Replit (Node.js) | Workers (this) |
|---|---|---|
| User storage | `data/sports-users.json` file | KV (`user:<token>`) |
| Pin snapshots | In-memory + same file | KV (`snap:<token>:<gameId>`) |
| Scheduler | `setInterval` in-process | Cloudflare Cron Trigger |
| Sleep behaviour | Replit sleeps idle → pins stop | No sleep, no idle |
| ESPN team cache | In-memory `Map` (24h) | Same in-memory `Map` (24h) |
| Pin layout / colours / IDs | unchanged | unchanged |
| API endpoints | unchanged | unchanged |

The pin format pushed to Rebble is **byte-for-byte identical** to
what the Replit server pushed. Existing pins on your watch will
update in place when the Worker starts pushing.

---

## Troubleshooting

**No pins arriving after registration**

```bash
npx wrangler tail
```

This streams live Worker logs. Open the Sports app on your watch
once to trigger registration, then watch for:

```
[timeline] registered xxxxxx… followed={"nhl":["VAN","MTL"]}
[timeline] tick — users=1 games=2
[timeline] PUT sports-401688234-pre → 200
```

If you see `markTokenInvalid` or `401`/`410` responses, the timeline
token expired — open the watch app once to refresh it.

**Settings page won't open / "could not load teams"**

The pkjs opens `COMPANION_URL/settings?...`. Verify that URL works
in a desktop browser. If it does, check the `Pebble.openURL()`
permission in the Pebble app on your phone.

**Cron doesn't seem to fire**

Cron triggers can take up to 15 minutes to propagate after
`wrangler deploy`. Check the dashboard: Workers & Pages → your
Worker → Triggers → Cron Triggers. The schedule should show
`*/2 * * * *`.

---

## Local development

```bash
npx wrangler dev
```

This runs the Worker locally at `http://localhost:8787`. To simulate
a cron tick:

```bash
curl 'http://localhost:8787/__scheduled?cron=*/2+*+*+*+*'
```

Note: local dev uses a local KV mock by default. To hit the real
production KV, edit `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SPORTS_KV"
id = "..."
remote = true   # ← add this
```
