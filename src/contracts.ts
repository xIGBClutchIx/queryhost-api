import type {
  DetectInput,
  DetectResult,
  GameDefinition,
  GameId,
  QueryInput,
  QueryMode,
  QueryResult,
  QuerySourceEvent,
} from "queryhost";

/** Fully normalized query accepted by the hosted runtime. */
export interface HostedQueryInput extends QueryInput<GameId> {
  readonly game: GameId;
  readonly host: string;
  readonly port: number;
  readonly queryPort: number;
  readonly mode: QueryMode;
  readonly timeoutMs: number;
}

/** Runs one live query, reporting each source's progress through `onSource`. */
export type QueryExecutor = (
  input: HostedQueryInput,
  onSource: (event: QuerySourceEvent) => void,
) => Promise<QueryResult>;

/** Normalized detection accepted by the hosted runtime; the probe budget comes from config. */
export interface HostedDetectInput extends DetectInput {
  readonly host: string;
  readonly mode: QueryMode;
  readonly timeoutMs: number;
  readonly maxProbes: number;
}

export type DetectExecutor = (input: HostedDetectInput) => Promise<DetectResult>;

/** Detection results are returned uncached, exactly as the library reports them. */
export type HostedDetectResponse = DetectResult;

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

/**
 * One line of a streamed `POST /query` response: source progress as the library reports it,
 * then exactly one final `result` line carrying the same body as the JSON response.
 */
export type QueryStreamLine =
  QuerySourceEvent | { readonly type: "result"; readonly result: HostedQueryResponse };

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
