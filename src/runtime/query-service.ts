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
import { ResultCache, resultTtlMs, type CacheSnapshot } from "./result-cache.js";
import { UsageStats } from "./usage-stats.js";

type Clock = () => number;

interface InFlightQuery {
  readonly result: Promise<QueryResult>;
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
  readonly #inFlight = new Map<string, InFlightQuery>();

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

  public async execute(input: HostedQueryInput): Promise<HostedQueryResponse> {
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
    const shared = this.#inFlight.get(key);
    // Join live work only when it had at least this caller's budget (so its
    // failures apply here too) and still finishes within this caller's deadline.
    if (
      shared !== undefined &&
      shared.timeoutMs >= input.timeoutMs &&
      shared.deadline <= startedAt + input.timeoutMs
    ) {
      const result = await shared.result;
      this.#usage.recordQuery(input.game, "coalesced");
      return hostedResponse(result, {
        status: "coalesced",
        ageMs: 0,
        ttlMs: resultTtlMs(result, this.#policy),
      });
    }

    const execution = this.#gate.run(queryDestinationKey(input), () => this.#run(input, key));
    const live: InFlightQuery = {
      result: execution,
      timeoutMs: input.timeoutMs,
      deadline: startedAt + input.timeoutMs,
    };
    // Keep advertising the run with the larger budget: it is the one later
    // callers can safely join.
    if (shared === undefined || live.timeoutMs > shared.timeoutMs) {
      this.#inFlight.set(key, live);
    }
    try {
      const result = await execution;
      this.#usage.recordQuery(input.game, "miss");
      return hostedResponse(result, {
        status: "miss",
        ageMs: 0,
        ttlMs: resultTtlMs(result, this.#policy),
      });
    } finally {
      if (this.#inFlight.get(key) === live) {
        this.#inFlight.delete(key);
      }
    }
  }

  public snapshot(): QueryServiceSnapshot {
    return {
      capacity: this.#gate.snapshot(),
      cache: this.#cache.snapshot(),
      inFlight: this.#inFlight.size,
    };
  }

  public close(): void {
    this.#gate.close();
  }

  async #run(input: HostedQueryInput, key: string): Promise<QueryResult> {
    const startedAt = this.#now();
    let result: QueryResult;
    try {
      result = await this.#executor(input);
    } catch {
      result = internalFailure(input.game);
    }
    this.#usage.recordLive(result, Math.max(0, this.#now() - startedAt));
    this.#cache.set(key, result, input.timeoutMs);
    return result;
  }
}
