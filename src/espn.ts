// ESPN scoreboard + team-list fetcher. Ported from the original
// server/espn.ts in the Replit backend. Behaviour is preserved:
// the same windows (-1..+7 for NHL/NBA/MLB/NFL, -3..+14 for FIFA-WC),
// the same 60s scoreboard cache, the same rank/state/period parsing.
//
// Adapted for Cloudflare Workers:
// - All network calls already use fetch(); nothing else needed.
// - In-memory caches still work within a single Worker isolate; they
//   simply don't survive across isolates, which is fine — the 60s
//   TTL is short enough that occasional re-fetches don't matter.

import type { GameState, NHLGame, NHLTeam, SportTeamInfo } from "./types";

const ESPN_NHL_BASE = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl";
const ESPN_SOCCER_FIFA_WC_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WC";
const ESPN_NBA_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const ESPN_MLB_BASE = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
const ESPN_NFL_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

type GenericSport = "nhl" | "nba" | "mlb" | "nfl";
type AnySport = GenericSport | "fifa-wc";

const SPORT_BASES: Record<GenericSport, string> = {
  nhl: ESPN_NHL_BASE,
  nba: ESPN_NBA_BASE,
  mlb: ESPN_MLB_BASE,
  nfl: ESPN_NFL_BASE,
};

// ---------- Scoreboard cache (60s, in-memory, single-flight) ----------
const SCOREBOARD_TTL_MS = 60_000;

type ScoreboardCacheEntry =
  | { kind: "ready"; value: NHLGame[]; expiresAt: number }
  | { kind: "pending"; promise: Promise<NHLGame[]> };

const scoreboardCache = new Map<string, ScoreboardCacheEntry>();

async function getCachedScoreboard(
  key: string,
  ttlMs: number,
  loader: () => Promise<NHLGame[]>,
): Promise<NHLGame[]> {
  const now = Date.now();
  const existing = scoreboardCache.get(key);
  if (existing) {
    if (existing.kind === "pending") return existing.promise;
    if (existing.expiresAt > now) return existing.value;
  }
  const promise = loader();
  scoreboardCache.set(key, { kind: "pending", promise });
  try {
    const value = await promise;
    scoreboardCache.set(key, { kind: "ready", value, expiresAt: Date.now() + ttlMs });
    return value;
  } catch (err) {
    scoreboardCache.delete(key);
    throw err;
  }
}

// ---------- ESPN response types ----------

interface ESPNCompetitor {
  id: string;
  team: {
    id: string;
    abbreviation: string;
    displayName: string;
    shortDisplayName: string;
    logo?: string;
  };
  score?: string;
  homeAway: "home" | "away";
  records?: Array<{ summary: string }>;
  seed?: number | string | null;
  curatedRank?: { current?: number | null } | null;
  rank?: number | string | null;
}

interface ESPNCompetition {
  id: string;
  date: string;
  status: {
    type: {
      id: string;
      name: string;
      state: string;
      completed: boolean;
      detail?: string;
      shortDetail?: string;
    };
    period?: number;
    displayClock?: string;
  };
  competitors: ESPNCompetitor[];
  venue?: { fullName: string };
  broadcasts?: Array<{ names: string[] }>;
  notes?: Array<{ headline?: string; type?: string }>;
  series?: { summary?: string };
}

interface ESPNEvent {
  id: string;
  date: string;
  name: string;
  competitions: ESPNCompetition[];
  season?: { type?: { name?: string; slug?: string } };
}

interface ESPNScoreboardResponse {
  events: ESPNEvent[];
}

// ---------- Parsers (verbatim from original) ----------

function parseGameState(status: ESPNCompetition["status"]): GameState {
  const name = (status.type.name || "").toUpperCase();
  if (name.includes("POSTPONED")) return "postponed";
  if (name.includes("CANCELED") || name.includes("CANCELLED")) return "canceled";
  const state = status.type.state.toLowerCase();
  if (state === "pre") return "pre-game";
  if (state === "in") return "in-game";
  return "final";
}

function getPeriodName(period: number): string {
  if (period === 1) return "1st";
  if (period === 2) return "2nd";
  if (period === 3) return "3rd";
  if (period > 3) return "OT";
  return "";
}

function getSoccerPeriodName(period: number): string {
  if (period === 1) return "1st Half";
  if (period === 2) return "2nd Half";
  if (period === 3) return "Extra Time";
  if (period >= 4) return "Penalties";
  return "";
}

function getQuarterName(period: number): string {
  if (period === 1) return "1st";
  if (period === 2) return "2nd";
  if (period === 3) return "3rd";
  if (period === 4) return "4th";
  if (period > 4) return "OT";
  return "";
}

function getInningName(period: number): string {
  if (period <= 0) return "";
  const suffix = period === 1 ? "st" : period === 2 ? "nd" : period === 3 ? "rd" : "th";
  return period + suffix;
}

const PERIOD_FORMATTERS: Record<AnySport, (p: number) => string> = {
  nhl: getPeriodName,
  "fifa-wc": getSoccerPeriodName,
  nba: getQuarterName,
  nfl: getQuarterName,
  mlb: getInningName,
};

function pickRank(competitor: ESPNCompetitor): string | undefined {
  if (competitor.seed != null && competitor.seed !== "") return String(competitor.seed);
  const curated = competitor.curatedRank?.current;
  if (curated != null && String(curated) !== "99") return String(curated);
  if (competitor.rank != null && competitor.rank !== "") return String(competitor.rank);
  return undefined;
}

function parseCompetitor(competitor: ESPNCompetitor): NHLTeam {
  return {
    id: competitor.team.id,
    abbreviation: competitor.team.abbreviation,
    displayName: competitor.team.displayName,
    shortDisplayName: competitor.team.shortDisplayName,
    logo: competitor.team.logo,
    record: competitor.records?.[0]?.summary,
    rank: pickRank(competitor),
  };
}

function humanizeSlug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function parseRound(competition: ESPNCompetition, event: ESPNEvent, sport?: AnySport): string | undefined {
  const noteHeadline = competition.notes?.find(n => n.headline && n.headline.trim() !== "")?.headline?.trim();
  if (noteHeadline) return noteHeadline;
  if (sport === "fifa-wc") {
    const seasonTypeName = event.season?.type?.name?.trim();
    if (seasonTypeName && seasonTypeName !== "") return seasonTypeName;
    const seasonSlug = event.season?.type?.slug?.trim();
    if (seasonSlug && seasonSlug !== "") return humanizeSlug(seasonSlug);
  }
  return undefined;
}

function parseSeries(competition: ESPNCompetition): string | undefined {
  const summary = competition.series?.summary?.trim();
  return summary || undefined;
}

function parseGame(event: ESPNEvent, periodFormatter?: (p: number) => string, sport?: AnySport): NHLGame | null {
  const competition = event.competitions[0];
  if (!competition) return null;
  const homeCompetitor = competition.competitors.find(c => c.homeAway === "home");
  const awayCompetitor = competition.competitors.find(c => c.homeAway === "away");
  if (!homeCompetitor || !awayCompetitor) return null;

  const gameState = parseGameState(competition.status);
  const gameDate = new Date(competition.date || event.date);
  const formatter = periodFormatter || getPeriodName;

  const isoTime = gameDate.toISOString();
  const period = gameState === "in-game" && competition.status.period
    ? formatter(competition.status.period)
    : null;
  const clock = gameState === "in-game" && competition.status.displayClock
    ? competition.status.displayClock
    : null;
  const homeScoreNum = homeCompetitor.score != null ? parseInt(homeCompetitor.score, 10) : NaN;
  const awayScoreNum = awayCompetitor.score != null ? parseInt(awayCompetitor.score, 10) : NaN;

  return {
    id: event.id,
    gameId: event.id,
    date: gameDate.toISOString().split("T")[0],
    time: isoTime,
    startTime: isoTime,
    state: gameState,
    period,
    clock,
    homeTeam: parseCompetitor(homeCompetitor),
    awayTeam: parseCompetitor(awayCompetitor),
    homeScore: Number.isFinite(homeScoreNum) ? homeScoreNum : 0,
    awayScore: Number.isFinite(awayScoreNum) ? awayScoreNum : 0,
    lastUpdated: new Date().toISOString(),
    venue: competition.venue?.fullName,
    broadcast: competition.broadcasts?.[0]?.names?.join(", "),
    sport,
    round: parseRound(competition, event, sport),
    seriesSummary: parseSeries(competition),
    statusDetail: competition.status.type.detail || competition.status.type.shortDetail || competition.status.type.name || undefined,
  };
}

// ---------- Generic scoreboard fetch ----------

async function fetchScoreboardForSport(sport: GenericSport, dateStr?: string): Promise<NHLGame[]> {
  return getCachedScoreboard(`${sport}:${dateStr || "today"}`, SCOREBOARD_TTL_MS, async () => {
    try {
      let url = `${SPORT_BASES[sport]}/scoreboard`;
      if (dateStr) url += `?dates=${dateStr.replace(/-/g, "")}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`ESPN ${sport} API error: ${response.status}`);
      const data = (await response.json()) as ESPNScoreboardResponse;
      const games: NHLGame[] = [];
      const formatter = PERIOD_FORMATTERS[sport] || getPeriodName;
      for (const event of data.events) {
        const game = parseGame(event, formatter, sport);
        if (game) games.push(game);
      }
      return games;
    } catch (error) {
      console.error(`Error fetching ${sport} scoreboard:`, error);
      return [];
    }
  });
}

// ---------- Public API for the routes/cron ----------

function buildLowerFilter(values: string[]): Set<string> {
  return new Set(values.map(v => v.toLowerCase()));
}

function teamMatchesFilter(team: { id: string; abbreviation: string }, lowerFilter: Set<string>): boolean {
  return (
    lowerFilter.has((team.id || "").toLowerCase()) ||
    lowerFilter.has((team.abbreviation || "").toLowerCase())
  );
}

export async function fetchFollowedTeamsGamesForSport(
  sport: GenericSport,
  teamIds?: string[],
): Promise<NHLGame[]> {
  if (!teamIds || teamIds.length === 0) return [];

  const today = new Date();
  const games: NHLGame[] = [];
  const seenIds = new Set<string>();
  const followedFilter = buildLowerFilter(teamIds);

  for (let i = -1; i <= 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split("T")[0];
    const dayGames = await fetchScoreboardForSport(sport, dateStr);
    for (const game of dayGames) {
      const isFollowedTeam =
        teamMatchesFilter(game.homeTeam, followedFilter) ||
        teamMatchesFilter(game.awayTeam, followedFilter);
      if (isFollowedTeam && !seenIds.has(game.id)) {
        seenIds.add(game.id);
        games.push(game);
      }
    }
  }
  games.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return games;
}

// Default NHL scoreboard wrapper kept for the legacy /api/sports/games
// path when no sport is specified.
export async function fetchFollowedTeamsGames(teamIds?: string[]): Promise<NHLGame[]> {
  return fetchFollowedTeamsGamesForSport("nhl", teamIds);
}

// FIFA WC has a wider date window and a 400-status special case for
// off-tournament dates.
async function fetchFIFAWCScoreboardRaw(dateStr?: string): Promise<NHLGame[]> {
  return getCachedScoreboard(`fifa-wc:${dateStr || "today"}`, SCOREBOARD_TTL_MS, async () => {
    let url = `${ESPN_SOCCER_FIFA_WC_BASE}/scoreboard`;
    if (dateStr) url += `?dates=${dateStr.replace(/-/g, "")}`;
    const response = await fetch(url);
    if (response.status === 400 || response.status === 404) return [];
    if (!response.ok) throw new Error(`ESPN Soccer API error: ${response.status}`);
    const data = (await response.json()) as ESPNScoreboardResponse;
    const games: NHLGame[] = [];
    for (const event of data.events || []) {
      const game = parseGame(event, getSoccerPeriodName, "fifa-wc");
      if (game) games.push(game);
    }
    return games;
  });
}

export async function fetchFIFAWCFollowedCountriesGames(countryIds?: string[]): Promise<NHLGame[]> {
  if (!countryIds || countryIds.length === 0) return [];
  try {
    const today = new Date();
    const games: NHLGame[] = [];
    const seenIds = new Set<string>();
    const lowerFilter = buildLowerFilter(countryIds);

    for (let i = -3; i <= 14; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split("T")[0];
      const dayGames = await fetchFIFAWCScoreboardRaw(dateStr);
      for (const game of dayGames) {
        const isFollowed =
          teamMatchesFilter(game.homeTeam, lowerFilter) ||
          teamMatchesFilter(game.awayTeam, lowerFilter);
        if (isFollowed && !seenIds.has(game.id)) {
          seenIds.add(game.id);
          games.push(game);
        }
      }
    }
    games.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    return games;
  } catch (error) {
    console.error("Error fetching FIFA WC games:", error);
    return [];
  }
}

// ---------- Team-list fetcher (powers /settings picker) ----------

const ESPN_TEAMS_URLS: Record<string, string> = {
  "nhl": "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams",
  "fifa-wc": "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams",
  "nba": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams",
  "mlb": "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams",
  "nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams",
};

const TEAMS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface TeamsCacheEntry {
  fetchedAt: number;
  teams: SportTeamInfo[];
}

const teamsCache: Map<string, TeamsCacheEntry> = new Map();
const teamsInflight: Map<string, Promise<SportTeamInfo[]>> = new Map();

interface ESPNTeamsResponse {
  sports?: Array<{
    leagues?: Array<{
      teams?: Array<{
        team?: {
          id?: string;
          abbreviation?: string;
          displayName?: string;
          shortDisplayName?: string;
          logos?: Array<{ href?: string }>;
        };
      }>;
    }>;
  }>;
}

const ESPN_TEAMS_REQUEST_TIMEOUT_MS = 10_000;

async function fetchSportTeamsFromESPN(sport: string): Promise<SportTeamInfo[]> {
  const url = ESPN_TEAMS_URLS[sport];
  if (!url) throw new Error(`Unsupported sport: ${sport}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESPN_TEAMS_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`ESPN ${sport} teams HTTP ${res.status}`);

  const data = (await res.json()) as ESPNTeamsResponse;
  const rawTeams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];

  const out: SportTeamInfo[] = [];
  for (const wrapper of rawTeams) {
    const t = wrapper?.team;
    if (!t || !t.id) continue;
    out.push({
      id: String(t.id),
      abbreviation: t.abbreviation ?? "",
      displayName: t.displayName ?? "",
      shortDisplayName: t.shortDisplayName ?? "",
      logoHref: t.logos?.[0]?.href ?? "",
    });
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}

export async function getSportTeams(sport: string): Promise<SportTeamInfo[]> {
  const cached = teamsCache.get(sport);
  if (cached && Date.now() - cached.fetchedAt < TEAMS_CACHE_TTL_MS) return cached.teams;

  const existing = teamsInflight.get(sport);
  if (existing) return existing;

  const p = (async () => {
    try {
      const teams = await fetchSportTeamsFromESPN(sport);
      teamsCache.set(sport, { fetchedAt: Date.now(), teams });
      return teams;
    } finally {
      teamsInflight.delete(sport);
    }
  })();
  teamsInflight.set(sport, p);
  return p;
}

export function isSupportedTeamsSport(sport: string): boolean {
  return Object.prototype.hasOwnProperty.call(ESPN_TEAMS_URLS, sport);
}

// Used by the cron path to fan out one fetch per sport across all
// followed teams (across all registered users). Matches the union
// approach of the original timeline-pusher.
export { teamMatchesFilter as _teamMatchesFilter };
