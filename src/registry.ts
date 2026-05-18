// KV-backed user registry. Replaces the file-based
// data/sports-users.json in the original timeline-pusher.
//
// KV layout:
//   user:<accountToken>             → UserEntry (registered watch)
//   snap:<accountToken>:<gameId>    → PinSnapshot (last-pushed pin state)
//   index:users                     → string[] of accountTokens
//
// The index:users key exists so the scheduled() handler can iterate
// over registered users WITHOUT calling kv.list(), which on the free
// tier counts as one operation per page but has higher latency than
// a direct get(). For a personal-scale deployment this stays trivial.

import type { Env, UserEntry, PinSnapshot } from "./types";

const USERS_INDEX_KEY = "index:users";

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

export async function getUser(env: Env, accountToken: string): Promise<UserEntry | null> {
  const raw = await env.SPORTS_KV.get(`user:${accountToken}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserEntry;
  } catch {
    return null;
  }
}

export async function putUser(env: Env, accountToken: string, entry: UserEntry): Promise<void> {
  await env.SPORTS_KV.put(`user:${accountToken}`, JSON.stringify(entry));
  await ensureInIndex(env, accountToken);
}

export async function markTokenInvalid(env: Env, accountToken: string): Promise<void> {
  const user = await getUser(env, accountToken);
  if (!user || user.tokenInvalid) return;
  user.tokenInvalid = true;
  await env.SPORTS_KV.put(`user:${accountToken}`, JSON.stringify(user));
}

async function getIndex(env: Env): Promise<string[]> {
  const raw = await env.SPORTS_KV.get(USERS_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function ensureInIndex(env: Env, accountToken: string): Promise<void> {
  const idx = await getIndex(env);
  if (idx.includes(accountToken)) return;
  idx.push(accountToken);
  await env.SPORTS_KV.put(USERS_INDEX_KEY, JSON.stringify(idx));
}

export async function listAccountTokens(env: Env): Promise<string[]> {
  return getIndex(env);
}

// Pin snapshots — one per (user, gameId).

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
  await env.SPORTS_KV.put(`snap:${accountToken}:${gameId}`, JSON.stringify(snap));
}

export async function deleteSnap(
  env: Env,
  accountToken: string,
  gameId: string,
): Promise<void> {
  await env.SPORTS_KV.delete(`snap:${accountToken}:${gameId}`);
}

// Used by cleanup paths to find every snap key for a user. KV list is
// fine here — we only do this occasionally (on re-register / unfollow).
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
