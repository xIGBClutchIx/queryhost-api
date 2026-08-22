import type { GameDefinition, GameId, QueryInput, QueryMode, QueryResult } from "queryhost";

/** Fully normalized query accepted by the hosted runtime. */
export interface HostedQueryInput extends QueryInput<GameId> {
  readonly game: GameId;
  readonly host: string;
  readonly port: number;
  readonly queryPort: number;
  readonly mode: QueryMode;
  readonly timeoutMs: number;
}

export type QueryExecutor = (input: HostedQueryInput) => Promise<QueryResult>;

export type CacheStatus = "hit" | "miss" | "coalesced";

/** Hosted cache provenance attached without changing the library result contract. */
export interface CacheMetadata {
  readonly status: CacheStatus;
  readonly ageMs: number;
  readonly ttlMs: number;
}

export type HostedQueryResponse = QueryResult & {
  readonly cache: CacheMetadata;
};

export interface GamesResponse {
  readonly games: readonly GameDefinition[];
}

export interface HealthCapacity {
  readonly active: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly startsInWindow: number;
  readonly maxStartsInWindow: number;
  readonly trackedDestinations: number;
  readonly maxTrackedDestinations: number;
}

export interface HealthCache {
  readonly entries: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface HealthResponse {
  readonly status: "ok";
  readonly uptimeSeconds: number;
  readonly capacity: HealthCapacity;
  readonly cache: HealthCache;
}

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "BODY_TOO_LARGE"
  | "INTERNAL_ERROR"
  | "METHOD_NOT_ALLOWED"
  | "NOT_FOUND"
  | "ORIGIN_UNAUTHORIZED"
  | "OVERLOADED"
  | "UNSUPPORTED_MEDIA_TYPE";

export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}
