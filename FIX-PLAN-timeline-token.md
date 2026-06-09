# Fix Plan: Timeline Token — `emulated-dummy-token` Root Cause

**Status:** Planned  
**Repos affected:** `sports-simplified` (pkjs), `-pebble-sports-worker` (Cloudflare Worker)  
**Symptom:** Background cron worker fails to push pin updates to Rebble. Pins appear on first app open but never auto-update.

---

## Root Cause Analysis

### The SDK Contract

Per the [Pebble SDK timeline docs](https://developer.rebble.io/guides/pebble-timeline/):

> "The timeline token is unique for each user/app combination. In order for timeline tokens to be available, the app must be submitted to the Pebble appstore."

`Pebble.getTimelineToken()` is an **asynchronous call** that contacts Rebble's token service. It resolves via:

- **Success callback** — with either a real token OR the placeholder `"emulated-dummy-token"`
- **Error callback** — only on a hard network/auth failure

The placeholder `"emulated-dummy-token"` is returned when the Rebble companion app **has not yet completed its internal session token exchange** with Rebble's cloud at the moment the call is made. It is a non-empty, non-null string — so a simple falsy guard does not catch it.

### Why `ready` Fires Too Early

`Pebble.addEventListener('ready', ...)` fires when PebbleKit JS is initialised — **not** when the Rebble companion's timeline session is ready. The call to `getTimelineToken()` inside `ready` races against Rebble's internal auth handshake. If the handshake hasn't completed yet, the success callback returns `"emulated-dummy-token"`.

There is **no SDK event** that signals when the real token is available. Polling via retry is the only conformant approach.

### The Two-Path Architecture

| Path | Used by | Token source | Affected? |
|---|---|---|---|
| **Local push** | `pkjs` → `timeline.insertUserPin()` | Pebble app internal session (opaque, never exposed) | ❌ Not affected — always works when Rebble is logged in |
| **Server push** | Cloudflare Worker → `PUT timeline-api.rebble.io` | `Pebble.getTimelineToken()` → stored in KV | ✅ **Broken when KV holds dummy token** |

This is why pins appear on first app open (local push path) but never auto-update (server push path, KV token poisoned).

### Why the KV Entry Is Never Corrected

Once `"emulated-dummy-token"` is written to KV, it is only overwritten if `registerWithServer()` is called again with a real token. This happens on:

- Next `ready` event (app reopen)
- `webviewclosed` event (settings save)

But **both paths call `getTimelineToken()` again** — and will write the dummy token again if the Rebble session still hasn't resolved, perpetuating the problem indefinitely.

### Why Retrying Doesn't Help (Previous Attempt)

A retry triggered from the **error callback** doesn't solve this. The dummy token arrives via the **success callback** — the retry logic never fires. The root condition (Rebble session not yet ready) can also persist across multiple rapid retries if the delay is insufficient.

---

## Fix Strategy

Two independent layers. Each is deployable separately. **Fix 1 is the root fix. Fix 2 is defence-in-depth.**

> ⚠️ These are **two separate deployments**. They must never be bundled together. Fix 1 touches core registration functionality. Fix 2 is a worker-side safety net only.

---

### Fix 1 — pkjs: Retry Loop Until Real Token (ROOT FIX)

**File:** `sports-simplified/src/pkjs/index.js`  
**Function:** `registerWithServer()`  
**Criticality:** CRITICAL — core functionality, deploy alone first

Replace the current single-shot `getTimelineToken()` call with a retry loop that re-calls the API until a genuine token is received.

**Parameters:**
- `MAX_RETRIES = 5`
- `RETRY_DELAY_MS = 3000` (3 seconds between attempts)
- Known dummy values to reject: `['emulated-dummy-token', 'emulated-user-token']`

**Logic:**
```
getTimelineToken()
  → success callback:
      if token is falsy OR in DUMMY_TOKENS list:
          if retryCount < MAX_RETRIES → setTimeout(registerWithServer, 3000, retryCount+1)
          else → log warning, do not register (graceful degradation)
      else:
          proceed with XHR POST to /api/sports/timeline/register (existing code)
  → error callback:
      if retryCount < MAX_RETRIES → setTimeout(registerWithServer, 6000, retryCount+1)
      else → log warning, do not register
```

**Degraded state when all retries fail:** The user gets no background worker updates that session. No crash, no error visible to user. On the next app open, `ready` fires again and the retry loop runs again — eventually succeeding once Rebble's session resolves.

**No changes to any other code path.**

---

### Fix 2 — Worker: Reject Dummy Tokens at Ingestion (SAFETY NET)

**File:** `-pebble-sports-worker/src/routes.ts`  
**Function:** `handleSportsRegister()`  
**Criticality:** NON-CRITICAL — defence-in-depth only, never deploy bundled with Fix 1

Add a validation step after the existing `timelineToken` string check:

```typescript
const DUMMY_TOKENS = new Set([
  'emulated-dummy-token',
  'emulated-user-token',
]);

if (DUMMY_TOKENS.has(timelineToken) || timelineToken.startsWith('emulated-')) {
  console.warn(`[register] rejected dummy token for acct=${accountToken.substring(0, 8)}`);
  return json({ error: 'timeline token not yet available — please try again' }, 400);
}
```

**Effect:** KV is never written with a dummy token. The next valid registration overwrites any previously poisoned entry. The 400 response to pkjs is harmless — pkjs does not act on the registration response body.

**No changes to any other code path.**

---

## Deployment Order

| Step | Action | Repo | Risk |
|---|---|---|---|
| 1 | Deploy Fix 1 (pkjs retry loop) | `sports-simplified` | Low — additive logic only |
| 2 | Build and sideload new `.pbw` | — | None |
| 3 | Verify real token appears in KV via `/health` endpoint | — | None |
| 4 | Deploy Fix 2 (worker guard) | `-pebble-sports-worker` | Very low — single validation check |

> ⚠️ Fix 2 **must not** be deployed before Fix 1. If Fix 2 goes first without Fix 1, all registrations from users still receiving dummy tokens will be rejected and those users will never register.

---

## Verification

After deploying Fix 1 and sideloading:

1. Open the Pebble app with the new build
2. Check Cloudflare Worker logs for: `[timeline] registered <token_prefix>…`
3. Check that the token stored in KV is **not** `emulated-dummy-token` (visible via `/health` → `users.active` count, or directly in Cloudflare KV dashboard)
4. Wait for the next cron tick (≤2 min) and confirm `[timeline] tick — users=1 games=N` log appears
5. Confirm a pin update arrives on watch without opening the app

---

## What Was Ruled Out

| Hypothesis | Why Ruled Out |
|---|---|
| Cron trigger not firing | Verified in Cloudflare dashboard — ticks every 2 min |
| App UUID not registered | Ruled out — pins DO appear on first app open |
| KV registry logic bug | Code audit confirmed `registry.ts` is correct |
| `timeline.insertUserPin()` using same token | SDK confirms it uses Pebble's internal opaque session token — cannot be read or reused |
| Rebble timeline API down | Ruled out — local push path works |
| Retry on error callback solves it | Ruled out — dummy token arrives via **success** callback, not error callback |
