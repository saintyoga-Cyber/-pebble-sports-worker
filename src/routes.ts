// HTTP route handlers. Replaces the Express routes from the original
// server/routes.ts. Same endpoints, same response shapes; just
// Workers-style fetch() instead of (req, res).

import type { Env } from "./types";
import {
  fetchFIFAWCFollowedCountriesGames,
  fetchFollowedTeamsGames,
  fetchFollowedTeamsGamesForSport,
  getSportTeams,
  isSupportedTeamsSport,
} from "./espn";
import { listActiveUsers, putUser, validateFollowed } from "./registry";
import { processUserImmediate } from "./pin";
import { renderSettingsPage } from "./settings-page";

// CORS headers — matches the original Express setup so PebbleKit JS
// XHRs are accepted unchanged.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}

function notFound(): Response {
  return json({ error: "not found" }, 404);
}

function handleOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ---------- Handlers ----------

async function handleSettingsPage(): Promise<Response> {
  return html(renderSettingsPage());
}

// /health — live operational status.
//
// Probes KV by calling listActiveUsers() (1 KV read, same cost as one
// cron tick). Returns user counts and a live timestamp so the caller
// can distinguish a cached 200 from a genuinely healthy worker.
async function handleHealth(env: Env): Promise<Response> {
  let kvStatus = "ok";
  let total = 0;
  let active = 0;

  try {
    const users = await listActiveUsers(env);
    // listActiveUsers filters out tokenInvalid entries; we need the raw
    // index to compute total. Re-derive total from the env directly.
    // To avoid a second read, count active from listActiveUsers result
    // and read the raw index once.
    const raw = await env.SPORTS_KV.get("index:users");
    const parsed: unknown[] = raw ? JSON.parse(raw) : [];
    total = Array.isArray(parsed) ? parsed.length : 0;
    active = users.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    kvStatus = `error: ${msg}`;
  }

  return json({
    ok: kvStatus === "ok",
    service: "pebble-sports-worker",
    kv: kvStatus,
    users: { total, active },
    ts: new Date().toISOString(),
  }, kvStatus === "ok" ? 200 : 503);
}

async function handleSportsTeams(url: URL): Promise<Response> {
  const sport = url.searchParams.get("sport") || "";
  if (!sport) {
    return json({ error: "sport query param is required (nhl|fifa-wc|nba|mlb|nfl)" }, 400);
  }
  if (!isSupportedTeamsSport(sport)) {
    return json({ error: `unsupported sport: ${sport}` }, 400);
  }
  try {
    const teams = await getSportTeams(sport);
    return json(teams);
  } catch (err) {
    console.error(`[/api/sports/teams] failed to load ${sport}:`, err);
    return json({ error: "Failed to load teams from ESPN" }, 502);
  }
}

async function handleSportsGames(url: URL): Promise<Response> {
  try {
    const sport = url.searchParams.get("sport") || "";
    const teamsCsv = url.searchParams.get("teams") || "";
    const teamIds = teamsCsv
      ? teamsCsv.split(",").map(s => s.trim()).filter(Boolean)
      : undefined;

    console.log(`[sports] games request sport=${JSON.stringify(sport)} teamIds=${JSON.stringify(teamIds ?? null)}`);

    const games = sport === "fifa-wc"
      ? await fetchFIFAWCFollowedCountriesGames(teamIds)
      : sport === "nba" || sport === "mlb" || sport === "nfl"
        ? await fetchFollowedTeamsGamesForSport(sport, teamIds)
        : await fetchFollowedTeamsGames(teamIds);

    return json({ games });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch games";
    return json({ error: msg }, 500);
  }
}

async function handleSportsFIFAGames(url: URL): Promise<Response> {
  try {
    const teamsCsv = url.searchParams.get("teams") || "";
    const teamIds = teamsCsv
      ? teamsCsv.split(",").map(s => s.trim()).filter(Boolean)
      : undefined;
    const games = await fetchFIFAWCFollowedCountriesGames(teamIds);
    return json({ games });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch FIFA WC games";
    return json({ error: msg }, 500);
  }
}

interface RegisterRequest {
  accountToken?: unknown;
  timelineToken?: unknown;
  followed?: unknown;
}

async function handleSportsRegister(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let payload: RegisterRequest;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { accountToken, timelineToken, followed } = payload;

  if (!accountToken || typeof accountToken !== "string") {
    return json({ error: "accountToken is required" }, 400);
  }
  if (!timelineToken || typeof timelineToken !== "string") {
    return json({ error: "timelineToken is required" }, 400);
  }
  if (!followed || typeof followed !== "object" || Array.isArray(followed)) {
    return json({ error: "followed map is required" }, 400);
  }

  const validationErr = validateFollowed(followed as Record<string, unknown>);
  if (validationErr) {
    return json({ error: validationErr }, 400);
  }

  await putUser(env, accountToken, {
    timelineToken,
    followed: followed as Record<string, string[]>,
    lastSeenAt: new Date().toISOString(),
    tokenInvalid: false,
  });

  const tag = accountToken.substring(0, 8);
  console.log(`[timeline] registered ${tag}… followed=${JSON.stringify(followed)}`);

  // Push an immediate pin update in the background so the user sees
  // pins right after saving settings without waiting for the next
  // 2-minute cron tick. waitUntil keeps the worker alive for this.
  ctx.waitUntil(processUserImmediate(env, accountToken));

  return json({ ok: true });
}

// ---------- Main entry ----------

export async function handleHTTP(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptions();

  const url = new URL(request.url);
  const pathname = url.pathname;

  // Settings page
  if (pathname === "/settings" && request.method === "GET") {
    return handleSettingsPage();
  }

  // Sports endpoints
  if (pathname === "/api/sports/teams" && request.method === "GET") {
    return handleSportsTeams(url);
  }
  if (pathname === "/api/sports/games" && request.method === "GET") {
    return handleSportsGames(url);
  }
  if (pathname === "/api/sports/fifa-wc/games" && request.method === "GET") {
    return handleSportsFIFAGames(url);
  }
  if (pathname === "/api/sports/timeline/register" && request.method === "POST") {
    return handleSportsRegister(request, env, ctx);
  }

  // Health check — now returns live KV + user status (P2).
  if (pathname === "/" || pathname === "/health") {
    return handleHealth(env);
  }

  return notFound();
}
