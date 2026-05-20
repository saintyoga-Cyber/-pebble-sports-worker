// Pin builder + Rebble Timeline pusher. Ported from the original
// server/timeline-pusher.ts. The pin layout, team-colour maps,
// subtitle building, reminders, and notifications are unchanged so
// the watch app receives byte-for-byte the same pins.
//
// Storage is now KV-backed (registry.ts) instead of file-backed.
//
// Fix (2026-05): buildSubtitle fallback time display now uses
// America/New_York (ET) instead of UTC, so pre-game pins show the
// correct local start time for North American sports.
//
// Fix (2026-05): duration=180 added to all pins so they stay in the
// future timeline for 3 hours from kickoff, matching calendar event
// behaviour. The -pre pin is no longer deleted when a game goes live;
// instead the -live pin is pushed at the same startTime so the watch
// sees an in-place update with no gap.

import type { Env, GameState, NHLGame, NHLTeam, PinSnapshot, UserEntry } from "./types";
import {
  fetchFIFAWCFollowedCountriesGames,
  fetchFollowedTeamsGamesForSport,
} from "./espn";
import {
  deleteSnap,
  getSnap,
  getUser,
  listAccountTokens,
  listSnapGameIds,
  markTokenInvalid,
  putSnap,
} from "./registry";

type GenericSport = "nhl" | "nba" | "mlb" | "nfl";

const REBBLE_URL = "https://timeline-api.rebble.io/v1/user/pins/";

const ACTIVE_WINDOW_BEFORE_MS = 30 * 60 * 1000;
const FINAL_GRACE_MS = 5 * 60 * 1000;
const SCHEDULED_PIN_WINDOW_MS = 48 * 60 * 60 * 1000;
const REMINDER_BEFORE_MS = 15 * 60 * 1000;
const STALE_FINAL_MS = 24 * 60 * 60 * 1000;

// Duration in minutes added to every pin so PebbleOS keeps the pin in
// the "future" (upcoming) view for the full likely game window.
// 180 min = 3 hours, which safely covers any sport.
const PIN_DURATION_MIN = 180;

// ---------- Pin shape ----------

interface PinLayout {
  type: string;
  title: string;
  subtitle?: string;
  body?: string;
  tinyIcon: string;
  largeIcon?: string;
  lastUpdated?: string;
  primaryColor?: string;
  backgroundColor?: string;
  headings?: string[];
  paragraphs?: string[];
  nameAway?: string;
  nameHome?: string;
  rankAway?: string;
  rankHome?: string;
  recordAway?: string;
  recordHome?: string;
  scoreAway?: string;
  scoreHome?: string;
  sportsGameState?: string;
}

interface PinNotification { time?: string; layout: PinLayout; }
interface PinReminder { time: string; layout: PinLayout; }
interface PinAction { type: string; title: string; launchCode?: number; }

interface TimelinePin {
  id: string;
  time: string;
  duration: number;
  layout: PinLayout;
  actions?: PinAction[];
  reminders?: PinReminder[];
  createNotification?: PinNotification;
  updateNotification?: PinNotification;
}

interface PinOpts {
  isNew?: boolean;
  scoreChanged?: boolean;
  stateChanged?: boolean;
  periodChanged?: boolean;
}

// ---------- Pin helpers (verbatim from original) ----------

function teamLabel(t: NHLTeam): string {
  return (t.abbreviation || t.shortDisplayName || t.displayName || "").substring(0, 4);
}

function sportIcon(sport?: string): string {
  if (sport === "nhl") return "system://images/HOCKEY_GAME";
  if (sport === "fifa-wc") return "system://images/SOCCER_GAME";
  if (sport === "nba") return "system://images/BASKETBALL_GAME";
  if (sport === "nfl") return "system://images/AMERICAN_FOOTBALL";
  if (sport === "mlb") return "system://images/BASEBALL_GAME";
  return "system://images/SCHEDULED_EVENT";
}

const NHL_TEAM_COLORS: Record<string, string> = {
  ANA: "orange", ARI: "darkCandyAppleRed", BOS: "yellow", BUF: "blue",
  CAR: "red", CBJ: "blue", CGY: "red", CHI: "red", COL: "darkCandyAppleRed",
  DAL: "darkGreen", DET: "red", EDM: "orange", FLA: "red", LAK: "darkGray",
  MIN: "darkGreen", MTL: "red", NJD: "red", NSH: "yellow", NYI: "blue",
  NYR: "blue", OTT: "red", PHI: "orange", PIT: "yellow", SEA: "darkBlue",
  SJS: "darkBlue", STL: "blue", TBL: "blue", TOR: "blue", UTA: "darkBlue",
  VAN: "blue", VGK: "yellow", WPG: "blue", WSH: "red",
};
const NBA_TEAM_COLORS: Record<string, string> = {
  ATL: "red", BOS: "darkGreen", BKN: "darkGray", CHA: "purple", CHI: "red",
  CLE: "darkCandyAppleRed", DAL: "blue", DEN: "darkBlue", DET: "red",
  GSW: "blue", GS: "blue", HOU: "red", IND: "darkBlue", LAC: "red",
  LAL: "purple", MEM: "darkBlue", MIA: "red", MIL: "darkGreen",
  MIN: "darkBlue", NOP: "darkBlue", NO: "darkBlue", NYK: "blue", NY: "blue",
  OKC: "blue", ORL: "blue", PHI: "blue", PHX: "purple", PHO: "purple",
  POR: "red", SAC: "purple", SAS: "darkGray", SA: "darkGray", TOR: "red",
  UTAH: "darkGreen", UTA: "darkGreen", WSH: "blue", WAS: "blue",
};
const MLB_TEAM_COLORS: Record<string, string> = {
  ARI: "darkCandyAppleRed", ATL: "red", BAL: "orange", BOS: "red",
  CHC: "blue", CHW: "darkGray", CWS: "darkGray", CIN: "red", CLE: "red",
  COL: "purple", DET: "darkBlue", HOU: "orange", KC: "blue", KAN: "blue",
  LAA: "red", LAD: "blue", MIA: "blue", MIL: "darkBlue", MIN: "darkBlue",
  NYM: "blue", NYY: "darkBlue", OAK: "darkGreen", PHI: "red", PIT: "yellow",
  SD: "yellow", SDP: "yellow", SF: "orange", SFG: "orange", SEA: "darkGreen",
  STL: "red", TB: "darkBlue", TBR: "darkBlue", TEX: "blue", TOR: "blue",
  WSH: "red", WAS: "red",
};
const NFL_TEAM_COLORS: Record<string, string> = {
  ARI: "red", ATL: "red", BAL: "purple", BUF: "blue", CAR: "blue",
  CHI: "darkBlue", CIN: "orange", CLE: "orange", DAL: "blue", DEN: "orange",
  DET: "blue", GB: "darkGreen", HOU: "darkBlue", IND: "blue", JAX: "darkBlue",
  KC: "red", LAC: "blue", LAR: "blue", LV: "darkGray", OAK: "darkGray",
  MIA: "blue", MIN: "purple", NE: "darkBlue", NO: "yellow", NYG: "blue",
  NYJ: "darkGreen", PHI: "darkGreen", PIT: "yellow", SEA: "darkBlue",
  SF: "red", TB: "red", TEN: "darkBlue", WSH: "darkCandyAppleRed",
  WAS: "darkCandyAppleRed",
};

function teamColor(t: NHLTeam, sport?: string): string {
  const abbr = (t.abbreviation || "").toUpperCase();
  let map: Record<string, string>;
  if (sport === "nba") map = NBA_TEAM_COLORS;
  else if (sport === "mlb") map = MLB_TEAM_COLORS;
  else if (sport === "nfl") map = NFL_TEAM_COLORS;
  else map = NHL_TEAM_COLORS;
  return map[abbr] || "white";
}

// Format the fallback "start time" text in Eastern Time so North
// American sports fans see the correct local hour (e.g. "6:10 PM")
// regardless of where the Cloudflare Worker is running.
function formatStartTimeET(isoString: string, broadcast?: string | null): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  let s = `${get("weekday")} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
  if (broadcast) s += ` · ${broadcast.split(",")[0].trim()}`;
  return s;
}

function buildSubtitle(game: NHLGame): string {
  switch (game.state) {
    case "final": {
      const detail = (game.statusDetail || "").toUpperCase();
      if (detail.includes("OT") || detail.includes("OVERTIME")) return "Final/OT";
      if (detail.includes("SO") || detail.includes("SHOOTOUT")) return "Final/SO";
      return "Final";
    }
    case "postponed": return "Postponed";
    case "canceled": return "Canceled";
    case "pre-game": {
      const startMs = new Date(game.startTime).getTime();
      const diffMs = startMs - Date.now();
      if (diffMs > 0) {
        const totalMin = Math.round(diffMs / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        if (h > 0) return m > 0 ? `Starts in ${h}h ${m}m` : `Starts in ${h}h`;
        return `Starts in ${m}m`;
      }
      // Fallback: game time has passed (e.g. pin was created early).
      // Display start time in ET — not UTC — so North American fans
      // see the correct hour (fixes the reported timezone bug).
      return formatStartTimeET(game.startTime, game.broadcast);
    }
    case "in-game": {
      const parts: string[] = [];
      if (game.period) parts.push(game.period);
      if (game.clock) parts.push(game.clock);
      return parts.length ? parts.join(" ") : "In Progress";
    }
    default: return "";
  }
}

export function buildPin(game: NHLGame, opts: PinOpts = {}): TimelinePin {
  const away = teamLabel(game.awayTeam);
  const home = teamLabel(game.homeTeam);
  const isScoreState = game.state === "in-game" || game.state === "final";
  const matchup = `${away} @ ${home}`;
  const subtitle = buildSubtitle(game);
  const recordAway = game.awayTeam.record || "";
  const recordHome = game.homeTeam.record || "";

  let title: string;
  let bodyLines: string[];
  if (isScoreState) {
    title = `${away} ${game.awayScore} — ${home} ${game.homeScore}`;
    bodyLines = [matchup];
    if (game.state === "final" && game.seriesSummary) {
      bodyLines.push(game.seriesSummary);
    } else if (game.period || game.clock) {
      bodyLines.push([game.period, game.clock].filter(Boolean).join(" "));
    }
    if (game.venue) bodyLines.push(game.venue);
  } else {
    title = matchup;
    bodyLines = [];
    if (recordAway || recordHome) {
      bodyLines.push(`${away} ${recordAway} · ${home} ${recordHome}`.trim());
    }
    if (game.venue) bodyLines.push(game.venue);
    if (game.broadcast) bodyLines.push(game.broadcast);
  }
  const body = bodyLines.join("\n") || subtitle;

  const headings = [away, home];
  const paragraphs = isScoreState
    ? [String(game.awayScore), String(game.homeScore)]
    : [recordAway || "—", recordHome || "—"];

  const pin: TimelinePin = {
    id: "sports-" + game.gameId + (isScoreState ? "-live" : "-pre"),
    time: game.startTime,
    // duration keeps the pin in the "future/upcoming" timeline view for
    // the full game window, exactly like a calendar event. Without this,
    // PebbleOS slides the pin to the past the instant startTime passes.
    duration: PIN_DURATION_MIN,
    layout: {
      type: "sportsPin",
      title,
      subtitle,
      body,
      tinyIcon: sportIcon(game.sport),
      largeIcon: sportIcon(game.sport),
      lastUpdated: game.lastUpdated || new Date().toISOString(),
      primaryColor: teamColor(game.homeTeam, game.sport),
      backgroundColor: teamColor(game.awayTeam, game.sport),
      headings,
      paragraphs,
      nameAway: away,
      nameHome: home,
      rankAway: game.awayTeam.rank ? String(game.awayTeam.rank).substring(0, 2) : "",
      rankHome: game.homeTeam.rank ? String(game.homeTeam.rank).substring(0, 2) : "",
      recordAway,
      recordHome,
      scoreAway: isScoreState ? String(game.awayScore) : "",
      scoreHome: isScoreState ? String(game.homeScore) : "",
      sportsGameState: isScoreState ? "in-game" : "pre-game",
    },
    actions: [
      { type: "openWatchApp", title: "Open Sports App", launchCode: 1 },
    ],
  };

  if (game.state === "pre-game") {
    const startMs = new Date(game.startTime).getTime();
    const reminderTime = new Date(startMs - REMINDER_BEFORE_MS).toISOString();
    const reminderBody =
      [game.venue, game.broadcast].filter(Boolean).join(" · ") || "Game starting soon";
    pin.reminders = [{
      time: reminderTime,
      layout: { type: "genericReminder", title: matchup, body: reminderBody, tinyIcon: sportIcon(game.sport) },
    }];
  }

  if (opts.isNew) {
    pin.createNotification = {
      layout: { type: "genericNotification", title, body: buildSubtitle(game), tinyIcon: sportIcon(game.sport) },
    };
  }

  if (opts.scoreChanged) {
    pin.updateNotification = {
      time: new Date().toISOString(),
      layout: {
        type: "genericNotification",
        title: `GOAL — ${away} ${game.awayScore}-${game.homeScore} ${home}`,
        body: game.period && game.clock ? `${game.period} ${game.clock}` : buildSubtitle(game),
        tinyIcon: sportIcon(game.sport),
      },
    };
  } else if (opts.periodChanged && game.state === "in-game") {
    pin.updateNotification = {
      time: new Date().toISOString(),
      layout: {
        type: "genericNotification",
        title: `${away} ${game.awayScore}-${game.homeScore} ${home}`,
        body: game.period || "Period change",
        tinyIcon: sportIcon(game.sport),
      },
    };
  } else if (opts.stateChanged && game.state === "final") {
    pin.updateNotification = {
      time: new Date().toISOString(),
      layout: {
        type: "genericNotification",
        title: `${buildSubtitle(game)} — ${away} ${game.awayScore}-${game.homeScore} ${home}`,
        body: game.seriesSummary || "",
        tinyIcon: sportIcon(game.sport),
      },
    };
  }

  return pin;
}

// ---------- Rebble push helpers ----------

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function putPin(
  env: Env,
  pin: TimelinePin,
  token: string,
  acct: string,
): Promise<boolean> {
  try {
    const res = await fetch(REBBLE_URL + pin.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-User-Token": token },
      body: JSON.stringify(pin),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      console.log(`[timeline] PUT ${pin.id} → ${res.status}`);
      return true;
    }
    const body = await res.text().catch(() => "");
    console.log(`[timeline] PUT ${pin.id} → ${res.status} ${body}`);
    if (res.status === 401 || res.status === 410) await markTokenInvalid(env, acct);
    return false;
  } catch (err) {
    console.error(`[timeline] PUT ${pin.id} error:`, errMsg(err));
    return false;
  }
}

async function deletePin(
  env: Env,
  pinId: string,
  token: string,
  acct: string,
): Promise<boolean> {
  try {
    const res = await fetch(REBBLE_URL + pinId, {
      method: "DELETE",
      headers: { "X-User-Token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok || res.status === 404 || res.status === 410) {
      console.log(`[timeline] DELETE ${pinId} → ${res.status}`);
      return true;
    }
    const body = await res.text().catch(() => "");
    console.log(`[timeline] DELETE ${pinId} → ${res.status} ${body}`);
    if (res.status === 401) await markTokenInvalid(env, acct);
    return false;
  } catch (err) {
    console.error(`[timeline] DELETE ${pinId} error:`, errMsg(err));
    return false;
  }
}

// ---------- Active-window logic ----------

function isInActiveWindow(game: NHLGame, snap: PinSnapshot | undefined, now: number): boolean {
  const startMs = new Date(game.startTime).getTime();
  if (game.state === "in-game") return true;
  if (game.state === "pre-game" && (startMs - now) <= ACTIVE_WINDOW_BEFORE_MS && (startMs - now) >= 0) return true;
  if (
    (game.state === "final" || game.state === "postponed" || game.state === "canceled") &&
    snap?.finalAt
  ) {
    const finalMs = new Date(snap.finalAt).getTime();
    if ((now - finalMs) <= FINAL_GRACE_MS) return true;
  }
  if (game.state === "final" && !snap?.finalAt) return true;
  return false;
}

function teamMatchesFollowed(
  team: { id: string; abbreviation: string },
  lowerFilter: Set<string>,
): boolean {
  return (
    lowerFilter.has((team.id || "").toLowerCase()) ||
    lowerFilter.has((team.abbreviation || "").toLowerCase())
  );
}

function userFollowsGame(user: UserEntry, game: NHLGame): boolean {
  if (!game.sport) return false;
  const ids = user.followed[game.sport];
  if (!ids?.length) return false;
  const lowerSet = new Set(ids.map(s => s.toLowerCase()));
  return teamMatchesFollowed(game.awayTeam, lowerSet) || teamMatchesFollowed(game.homeTeam, lowerSet);
}

// ---------- Per-user processing ----------

async function fetchUserGames(user: UserEntry): Promise<NHLGame[]> {
  const all: NHLGame[] = [];
  for (const [sport, ids] of Object.entries(user.followed)) {
    if (!ids?.length) continue;
    try {
      const games =
        sport === "fifa-wc"
          ? await fetchFIFAWCFollowedCountriesGames(ids)
          : await fetchFollowedTeamsGamesForSport(sport as GenericSport, ids);
      all.push(...games);
    } catch (err) {
      console.error(`[timeline] fetch ${sport} failed:`, err);
    }
  }
  return all;
}

export async function processUserWithGames(
  env: Env,
  acct: string,
  allGames: Map<string, NHLGame> | null,
): Promise<void> {
  const user = await getUser(env, acct);
  if (!user) return;
  if (user.tokenInvalid) return;

  const games: NHLGame[] = [];
  if (allGames) {
    for (const g of allGames.values()) {
      if (userFollowsGame(user, g)) games.push(g);
    }
  } else {
    games.push(...(await fetchUserGames(user)));
  }

  const now = Date.now();
  const currentGameIds = new Set<string>();
  const existingGameIds = new Set(await listSnapGameIds(env, acct));

  for (const game of games) {
    const gid = game.gameId;
    currentGameIds.add(gid);
    const startMs = new Date(game.startTime).getTime();
    const diffMs = startMs - now;

    const eligible =
      game.state === "in-game" ||
      (game.state === "pre-game" && diffMs >= 0 && diffMs <= SCHEDULED_PIN_WINDOW_MS) ||
      game.state === "final" || game.state === "postponed" || game.state === "canceled";
    if (!eligible) continue;

    const prev = await getSnap(env, acct, gid);

    if (
      (game.state === "final" || game.state === "postponed" || game.state === "canceled") &&
      !prev
    ) {
      const lastMs = game.lastUpdated ? new Date(game.lastUpdated).getTime() : NaN;
      if (!isNaN(lastMs) && now - lastMs > STALE_FINAL_MS) continue;
    }

    const isNew = !prev;
    const scoreChanged = !!prev && (prev.homeScore !== game.homeScore || prev.awayScore !== game.awayScore);
    const stateChanged = !!prev && prev.state !== game.state;
    const periodChanged = !!prev && prev.period !== game.period;
    const clockChanged = !!prev && prev.clock !== game.clock;

    // Do NOT delete the -pre pin when a game goes live. The -live pin
    // is pushed at the same startTime+duration so PebbleOS updates it
    // in-place. Deleting causes a brief gap where the pin vanishes from
    // the timeline, which is the bug users reported.

    if (isNew || scoreChanged || stateChanged || periodChanged || clockChanged) {
      const pin = buildPin(game, { isNew, scoreChanged, stateChanged, periodChanged });
      if (await putPin(env, pin, user.timelineToken, acct)) {
        const snap: PinSnapshot = {
          state: game.state,
          homeScore: game.homeScore,
          awayScore: game.awayScore,
          period: game.period,
          clock: game.clock,
          startTime: game.startTime,
        };
        if (
          (game.state === "final" || game.state === "postponed" || game.state === "canceled") &&
          (!prev || prev.state !== game.state)
        ) {
          snap.finalAt = new Date().toISOString();
        } else if (prev?.finalAt) {
          snap.finalAt = prev.finalAt;
        }
        await putSnap(env, acct, gid, snap);
      }
    }
  }

  for (const gid of existingGameIds) {
    if (!currentGameIds.has(gid)) {
      await deletePin(env, "sports-" + gid + "-pre", user.timelineToken, acct);
      await deletePin(env, "sports-" + gid + "-live", user.timelineToken, acct);
      await deleteSnap(env, acct, gid);
    }
  }
}

// ---------- Cron entry-point ----------

function computeUnionTeamsForUsers(users: UserEntry[]): Record<string, Set<string>> {
  const union: Record<string, Set<string>> = {};
  for (const user of users) {
    if (user.tokenInvalid) continue;
    for (const [sport, ids] of Object.entries(user.followed)) {
      if (!union[sport]) union[sport] = new Set();
      for (const id of ids) union[sport].add(id);
    }
  }
  return union;
}

async function fetchUnionGames(users: UserEntry[]): Promise<Map<string, NHLGame>> {
  const union = computeUnionTeamsForUsers(users);
  const gameMap = new Map<string, NHLGame>();
  for (const [sport, teamSet] of Object.entries(union)) {
    const ids = Array.from(teamSet);
    if (!ids.length) continue;
    try {
      const games =
        sport === "fifa-wc"
          ? await fetchFIFAWCFollowedCountriesGames(ids)
          : await fetchFollowedTeamsGamesForSport(sport as GenericSport, ids);
      for (const g of games) gameMap.set(g.gameId, g);
    } catch (err) {
      console.error(`[timeline] union fetch ${sport} failed:`, err);
    }
  }
  return gameMap;
}

function isInCronWindowUTC(): boolean {
  const hour = new Date().getUTCHours();
  return hour < 8 || hour >= 12;
}

export async function runScheduledTick(env: Env): Promise<void> {
  if (!isInCronWindowUTC()) {
    console.log("[timeline] outside UTC cron window (08:00–11:59 quiet) — skipping");
    return;
  }
  const accts = await listAccountTokens(env);
  if (accts.length === 0) {
    console.log("[timeline] no registered users — skipping tick");
    return;
  }

  const users: UserEntry[] = [];
  for (const acct of accts) {
    const u = await getUser(env, acct);
    if (u) users.push(u);
  }

  const allGames = await fetchUnionGames(users);
  console.log(`[timeline] tick — users=${accts.length} games=${allGames.size}`);

  for (const acct of accts) {
    try {
      await processUserWithGames(env, acct, allGames);
    } catch (err) {
      console.error("[timeline] tick error:", err);
    }
  }
}

export async function processUserImmediate(env: Env, acct: string): Promise<void> {
  try {
    await processUserWithGames(env, acct, null);
  } catch (err) {
    console.error("[timeline] immediate poll failed:", err);
  }
}
