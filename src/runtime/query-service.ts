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

type Clock = () => number;

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
  readonly #inFlight = new Map<string, Promise<QueryResult>>();

  public constructor(config: ApiConfig, executor: QueryExecutor, now: Clock = Date.now) {
    this.#executor = executor;
    this.#cache = new ResultCache(config.cache, now);
    this.#gate = new CapacityGate(config.capacity, now);
    this.#policy = config.cache;
  }

  public async execute(input: HostedQueryInput): Promise<HostedQueryResponse> {
    const key = queryCacheKey(input);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return hostedResponse(cached.result, {
        status: "hit",
        ageMs: cached.ageMs,
        ttlMs: cached.ttlMs,
      });
    }

    const shared = this.#inFlight.get(key);
    if (shared !== undefined) {
      const result = await shared;
      return hostedResponse(result, {
        status: "coalesced",
        ageMs: 0,
        ttlMs: resultTtlMs(result, this.#policy),
      });
    }

    const execution = this.#gate.run(queryDestinationKey(input), () => this.#run(input, key));
    this.#inFlight.set(key, execution);
    try {
      const result = await execution;
      return hostedResponse(result, {
        status: "miss",
        ageMs: 0,
        ttlMs: resultTtlMs(result, this.#policy),
      });
    } finally {
      if (this.#inFlight.get(key) === execution) {
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
    let result: QueryResult;
    try {
      result = await this.#executor(input);
    } catch {
      result = internalFailure(input.game);
    }
    this.#cache.set(key, result);
    return result;
  }
}
