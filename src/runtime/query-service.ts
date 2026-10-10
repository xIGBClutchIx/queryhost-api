import type { GameId, QueryResult } from "queryhost";

import type { ApiConfig } from "../config.js";
import type {
  CacheMetadata,
  HostedQueryInput,
  HostedQueryResponse,
  QueryExecutor,
} from "../contracts.js";
import { queryCacheKey, queryDestinationKey } from "../validation/query-input.js";
import { CapacityGate, type CapacitySnapshot } from "./capacity-gate.js";
import { QueryProgress, type ProgressListener } from "./query-progress.js";
import { ResultCache, resultTtlMs, type CacheSnapshot } from "./result-cache.js";
import { UsageStats } from "./usage-stats.js";

type Clock = () => number;

interface InFlightQuery {
  readonly result: Promise<QueryResult>;
  readonly progress: QueryProgress;
  readonly timeoutMs: number;
  readonly deadline: number;
}

export interface QueryServiceSnapshot {
  readonly capacity: CapacitySnapshot;
  readonly cache: CacheSnapshot;
  readonly inFlight: number;
}

function internalFailure(game: GameId): QueryResult {
  return {
    ok: false,
    game,
    error: {
      code: "INTERNAL_ERROR",
      message: "The hosted query failed unexpectedly.",
    },
    durationMs: 0,
    sources: [],
    warnings: [],
  };
}

function hostedResponse(result: QueryResult, cache: CacheMetadata): HostedQueryResponse {
  return { ...result, cache };
}

/** Coordinates cache lookup, in-flight sharing, capacity admission, and live library queries. */
export class QueryService {
  readonly #executor: QueryExecutor;
  readonly #cache: ResultCache;
  readonly #gate: CapacityGate;
  readonly #policy: ApiConfig["cache"];
  readonly #usage: UsageStats;
  readonly #now: Clock;
  // Each key can have several live runs with different deadlines; every one
  // is an admitted capacity-gate task, so the lists stay bounded by capacity.
  readonly #inFlight = new Map<string, InFlightQuery[]>();
  #inFlightRuns = 0;

  public constructor(
    config: ApiConfig,
    executor: QueryExecutor,
    now: Clock = Date.now,
    usage: UsageStats = new UsageStats(now),
  ) {
    this.#executor = executor;
    this.#cache = new ResultCache(config.cache, now);
    this.#gate = new CapacityGate(config.capacity, now);
    this.#policy = config.cache;
    this.#usage = usage;
    this.#now = now;
  }

  /**
   * Answers one query from the cache, shared live work, or a new live run. `onSource` receives
   * the live run's source progress, including events it missed when joining shared work; a
   * cached answer reports none.
   */
  public async execute(
    input: HostedQueryInput,
    onSource?: ProgressListener,
  ): Promise<HostedQueryResponse> {
    const key = queryCacheKey(input);
    const cached = this.#cache.get(key, input.timeoutMs);
    if (cached !== undefined) {
      this.#usage.recordQuery(input.game, "hit");
      return hostedResponse(cached.result, {
        status: "hit",
        ageMs: cached.ageMs,
        ttlMs: cached.ttlMs,
      });
    }

    const startedAt = this.#now();
    const runs = this.#inFlight.get(key) ?? [];
    // Join live work only when it had at least this caller's budget (so its
    // failures apply here too) and still finishes within this caller's deadline.
    const shared = runs.find(
      (run) => run.timeoutMs >= input.timeoutMs && run.deadline <= startedAt + input.timeoutMs,
    );
    if (shared !== undefined) {
      const unsubscribe = onSource === undefined ? undefined : shared.progress.subscribe(onSource);
      let result: QueryResult;
      try {
        result = await shared.result;
      } finally {
        unsubscribe?.();
      }
      this.#usage.recordQuery(input.game, "coalesced");
      return hostedResponse(result, {
        status: "coalesced",
        ageMs: 0,
        ttlMs: resultTtlMs(result, this.#policy),
      });
    }

    const progress = new QueryProgress();
    // Subscribe before admission: a started task may report progress synchronously.
    const unsubscribe = onSource === undefined ? undefined : progress.subscribe(onSource);
    const execution = this.#gate.run(queryDestinationKey(input), () =>
      this.#run(input, key, progress),
    );
    const live: InFlightQuery = {
      result: execution,
      progress,
      timeoutMs: input.timeoutMs,
      deadline: startedAt + input.timeoutMs,
    };
    this.#inFlight.set(key, [...runs, live]);
    this.#inFlightRuns += 1;
    try {
      const result = await execution;
      this.#usage.recordQuery(input.game, "miss");
      return hostedResponse(result, {
        status: "miss",
        ageMs: 0,
        ttlMs: resultTtlMs(result, this.#policy),
      });
    } finally {
      unsubscribe?.();
      const remaining = (this.#inFlight.get(key) ?? []).filter((run) => run !== live);
      if (remaining.length === 0) {
        this.#inFlight.delete(key);
      } else {
        this.#inFlight.set(key, remaining);
      }
      this.#inFlightRuns -= 1;
    }
  }

  public snapshot(): QueryServiceSnapshot {
    return {
      capacity: this.#gate.snapshot(),
      cache: this.#cache.snapshot(),
      inFlight: this.#inFlightRuns,
    };
  }

  public close(): void {
    this.#gate.close();
  }

  async #run(input: HostedQueryInput, key: string, progress: QueryProgress): Promise<QueryResult> {
    const startedAt = this.#now();
    let result: QueryResult;
    try {
      result = await this.#executor(input, (event) => {
        progress.publish(event);
      });
    } catch {
      result = internalFailure(input.game);
    }
    this.#usage.recordLive(result, Math.max(0, this.#now() - startedAt));
    this.#cache.set(key, result, input.timeoutMs);
    return result;
  }
}
