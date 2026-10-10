import { detect, type DetectResult, type GameId, type QueryResult } from "queryhost";

import type { ApiConfig } from "../config.js";
import type {
  CacheMetadata,
  DetectExecutor,
  HostedDetectInput,
  HostedQueryInput,
  HostedQueryResponse,
  QueryExecutor,
} from "../contracts.js";
import {
  detectDestinationKey,
  queryCacheKey,
  queryDestinationKey,
} from "../validation/query-input.js";
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

// Detections end with a typed query of the detected game unless a probe already answered in the
// requested mode, so each is charged one start per probe plus that query.
function detectionCost(input: HostedDetectInput, maxStartsPerDestination: number): number {
  return Math.min(input.maxProbes + 1, maxStartsPerDestination);
}

/** Coordinates cache lookup, in-flight sharing, capacity admission, and live library queries. */
export class QueryService {
  readonly #executor: QueryExecutor;
  readonly #detector: DetectExecutor;
  readonly #maxStartsPerDestination: number;
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
    detector: DetectExecutor = detect,
  ) {
    this.#executor = executor;
    this.#detector = detector;
    this.#maxStartsPerDestination = config.capacity.startRate.maxStartsPerDestination;
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
    const runs = this.#inFlight.get(key) ?? [];
    // Join live work only when it had at least this caller's budget (so its
    // failures apply here too) and still finishes within this caller's deadline.
    const shared = runs.find(
      (run) => run.timeoutMs >= input.timeoutMs && run.deadline <= startedAt + input.timeoutMs,
    );
    if (shared !== undefined) {
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
      const remaining = (this.#inFlight.get(key) ?? []).filter((run) => run !== live);
      if (remaining.length === 0) {
        this.#inFlight.delete(key);
      } else {
        this.#inFlight.set(key, remaining);
      }
      this.#inFlightRuns -= 1;
    }
  }

  /**
   * Runs one live detection through the same capacity gate as queries, charged for every probe it
   * may send. Detections are never cached or shared: their probes depend on the caller's deadline.
   */
  public async detect(input: HostedDetectInput): Promise<DetectResult> {
    const result = await this.#gate.runCharged(
      detectDestinationKey(input),
      () => this.#detector(input),
      {
        cost: detectionCost(input, this.#maxStartsPerDestination),
        refundable: (detected) => !detected.ok && detected.error.code === "TARGET_BLOCKED",
      },
    );
    this.#usage.recordDetection(result);
    return result;
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
