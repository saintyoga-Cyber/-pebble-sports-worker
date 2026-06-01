// KV-backed user registry.
//
// KV layout:
//   user:<accountToken>          → UserEntry  (source of truth)
//   snap:<accountToken>:<gameId> → PinSnapshot (7-day TTL)
//   index:users                  → UserEntry[] (denormalised read cache)
//
// index:users stores full UserEntry objects so runScheduledTick can
// hydrate all users in a single KV read instead of N reads.
// On every write (putUser, markTokenInvalid) both the individual key
// and the index are updated. The individual user:<token> key remains
// the authoritative record; the index is a read cache for the cron
// hot path.
//
// Migration: if index:users contains the old string[] format it is
// discarded and self-heals as users re-register (putUser rebuilds it).

import type { Env, UserEntry, PinSnapshot } from "./types";

const USERS_INDEX_KEY = "index:users";
const SNAP_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const ALLOWED_SPORTS = new Set(["nhl", "fifa-wc", "nba", "mlb", "nfl"]);

export function validateFollowed(followed: Record<string, unknown>): string | null {
  for (const [sport, ids] of Object.entries(followed)) {
    if (!ALLOWED_SPORTS.has(sport)) return `unknown sport: ${sport}`;
    if (!Array.isArray(ids)) return `followed.${sport} must be an array`;
    if (ids.length > 30) return `followed.${sport} exceeds 30 teams`;
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0 || id.length > 10)
        return `followed.${sport} contains invalid team id`;
    }
  }
  return null;
}

// ---------- Index helpers ----------

async function getIndex(env: Env): Promise<UserEntry[]> {
  const raw = await env.SPORTS_KV.get(USERS_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Migration guard: old format was string[] of tokens.
    // If the first element is a string, discard the index — it will
    // self-heal on the next putUser call from any active user.
    if (parsed.length > 0 && typeof parsed[0] === "string") return [];
    return parsed as UserEntry[];
  } catch {
    return [];
  }
}

// Upsert a UserEntry into the index: replace if token exists, append if new.
async function upsertInIndex(env: Env, entry: UserEntry): Promise<void> {
  const idx = await getIndex(env);
  const i = idx.findIndex(u => u.accountToken === entry.accountToken);
  if (i === -1) idx.push(entry);
  else idx[i] = entry;
  await env.SPORTS_KV.put(USERS_INDEX_KEY, JSON.stringify(idx));
}

// ---------- User CRUD ----------

export async function getUser(env: Env, accountToken: string): Promise<UserEntry | null> {
  const raw = await env.SPORTS_KV.get(`user:${accountToken}`);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as UserEntry;
    entry.accountToken = accountToken;
    return entry;
  } catch {
    return null;
  }
}

export async function putUser(env: Env, accountToken: string, entry: UserEntry): Promise<void> {
  entry.accountToken = accountToken;
  // Write source-of-truth key and update the index in parallel.
  // upsertInIndex does its own read-modify-write internally; running
  // both writes concurrently is safe because they target different keys.
  await Promise.all([
    env.SPORTS_KV.put(`user:${accountToken}`, JSON.stringify(entry)),
    upsertInIndex(env, entry),
  ]);
}

export async function markTokenInvalid(env: Env, accountToken: string): Promise<void> {
  const user = await getUser(env, accountToken);
  if (!user || user.tokenInvalid) return;
  user.tokenInvalid = true;
  // Update both the source-of-truth key and the index so the next cron
  // tick sees the invalid state immediately and skips this user.
  await Promise.all([
    env.SPORTS_KV.put(`user:${accountToken}`, JSON.stringify(user)),
    upsertInIndex(env, user),
  ]);
}

// Returns all users whose token is still valid. Costs exactly 1 KV read
// regardless of user count — the hot path for runScheduledTick.
export async function listActiveUsers(env: Env): Promise<UserEntry[]> {
  const idx = await getIndex(env);
  return idx.filter(u => !u.tokenInvalid);
}

// ---------- Snap CRUD ----------

export async function getSnap(
  env: Env,
  accountToken: string,
  gameId: string,
): Promise<PinSnapshot | null> {
  const raw = await env.SPORTS_KV.get(`snap:${accountToken}:${gameId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PinSnapshot;
  } catch {
    return null;
  }
}

export async function putSnap(
  env: Env,
  accountToken: string,
  gameId: string,
  snap: PinSnapshot,
): Promise<void> {
  // 7-day TTL: Cloudflare KV expires the key automatically so stale
  // snaps never accumulate. A snap older than 7 days means the game
  // finished long ago and treating it as new on the next tick is correct.
  await env.SPORTS_KV.put(
    `snap:${accountToken}:${gameId}`,
    JSON.stringify(snap),
    { expirationTtl: SNAP_TTL_SECONDS },
  );
}

export async function deleteSnap(
  env: Env,
  accountToken: string,
  gameId: string,
): Promise<void> {
  await env.SPORTS_KV.delete(`snap:${accountToken}:${gameId}`);
}

// Used by the orphan-cleanup path in processUserWithGames to find every
// snap key for a user. kv.list() never returns expired keys so TTL-expired
// snaps are automatically excluded from this result.
export async function listSnapGameIds(env: Env, accountToken: string): Promise<string[]> {
  const prefix = `snap:${accountToken}:`;
  const out: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await env.SPORTS_KV.list({ prefix, cursor });
    for (const k of page.keys) {
      out.push(k.name.substring(prefix.length));
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}
