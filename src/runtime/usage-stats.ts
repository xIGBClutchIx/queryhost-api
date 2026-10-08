import type { GameId, QueryResult } from "queryhost";

import type { CacheStatus } from "../contracts.js";

/** Upper bounds, in milliseconds, of the live-query latency histogram buckets. */
export const LATENCY_BUCKETS_MS: readonly number[] = [100, 250, 500, 1_000, 2_500, 5_000];

export interface LatencyBucket {
  /** Inclusive upper bound in milliseconds, or `null` for the overflow bucket. */
  readonly le: number | null;
  readonly count: number;
}

export interface UsageSnapshot {
  readonly startedAt: string;
  readonly responses: Readonly<Record<string, number>>;
  readonly queries: Readonly<Record<CacheStatus, number>>;
  readonly games: Readonly<Record<string, number>>;
  readonly live: {
    readonly ok: number;
    readonly partial: number;
    readonly failed: number;
    readonly errors: Readonly<Record<string, number>>;
    readonly latencyMs: readonly LatencyBucket[];
  };
}

type Clock = () => number;

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sorted(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Process-local aggregate counters. Every key comes from a closed set (HTTP
 * statuses this server emits, registry game IDs, library error codes), so
 * memory stays bounded. Targets, callers, and results are never recorded.
 */
export class UsageStats {
  readonly #startedAt: number;
  readonly #responses = new Map<string, number>();
  readonly #games = new Map<string, number>();
  readonly #errors = new Map<string, number>();
  readonly #latency: number[] = Array.from({ length: LATENCY_BUCKETS_MS.length + 1 }, () => 0);
  readonly #queries: Record<CacheStatus, number> = { hit: 0, miss: 0, coalesced: 0 };
  #ok = 0;
  #partial = 0;
  #failed = 0;

  public constructor(now: Clock = Date.now) {
    this.#startedAt = now();
  }

  public recordResponse(status: number): void {
    increment(this.#responses, status.toString());
  }

  public recordQuery(game: GameId, status: CacheStatus): void {
    this.#queries[status] += 1;
    increment(this.#games, game);
  }

  public recordLive(result: QueryResult, durationMs: number): void {
    if (result.ok) {
      if (result.partial) {
        this.#partial += 1;
      } else {
        this.#ok += 1;
      }
    } else {
      this.#failed += 1;
      increment(this.#errors, result.error.code);
    }
    const found = LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
    const bucket = found === -1 ? LATENCY_BUCKETS_MS.length : found;
    this.#latency[bucket] = (this.#latency[bucket] ?? 0) + 1;
  }

  public snapshot(): UsageSnapshot {
    return {
      startedAt: new Date(this.#startedAt).toISOString(),
      responses: sorted(this.#responses),
      queries: { ...this.#queries },
      games: sorted(this.#games),
      live: {
        ok: this.#ok,
        partial: this.#partial,
        failed: this.#failed,
        errors: sorted(this.#errors),
        latencyMs: this.#latency.map((count, index) => ({
          le: LATENCY_BUCKETS_MS[index] ?? null,
          count,
        })),
      },
    };
  }
}
