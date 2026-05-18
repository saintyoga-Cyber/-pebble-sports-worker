// Sports Timeline types — ported verbatim from the original
// shared/schema.ts in the Replit backend. Drizzle/Zod bits were
// removed because nothing in the Worker uses them.

export type GameState = "pre-game" | "in-game" | "final" | "postponed" | "canceled";

export interface NHLTeam {
  id: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  logo?: string;
  rank?: string;
  record?: string;
}

export interface NHLGame {
  id: string;
  gameId: string;
  date: string;
  time: string;
  startTime: string;
  state: GameState;
  period: string | null;
  clock: string | null;
  homeTeam: NHLTeam;
  awayTeam: NHLTeam;
  homeScore: number;
  awayScore: number;
  lastUpdated: string;
  venue?: string;
  broadcast?: string;
  sport?: "nhl" | "fifa-wc" | "nba" | "mlb" | "nfl";
  round?: string;
  seriesSummary?: string;
  statusDetail?: string;
}

export interface SportTeamInfo {
  id: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  logoHref: string;
}

// Registry entry stored in KV under key `user:<accountToken>`.
export interface UserEntry {
  timelineToken: string;
  followed: Record<string, string[]>;
  lastSeenAt: string;
  tokenInvalid?: boolean;
}

// Pin snapshot stored in KV under key `snap:<accountToken>:<gameId>`,
// used to detect score/state changes between cron ticks.
export interface PinSnapshot {
  state: GameState;
  homeScore: number;
  awayScore: number;
  period: string | null;
  clock: string | null;
  startTime: string;
  finalAt?: string;
}

// Cloudflare Worker environment bindings.
export interface Env {
  SPORTS_KV: KVNamespace;
}
