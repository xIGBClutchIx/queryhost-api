import type { ApiConfig } from "../src/config.js";
import type { HostedQueryInput } from "../src/contracts.js";
import type { StartRatePolicy } from "../src/runtime/start-rate-gate.js";
import type { QueryResult } from "queryhost";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("The deferred promise did not initialize synchronously.");
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 3_000,
    originToken: "a".repeat(32),
    maxBodyBytes: 4_096,
    capacity: {
      maxActive: 2,
      maxQueued: 3,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate(),
    },
    cache: {
      maxEntries: 10,
      maxBytes: 100_000,
      successTtlMs: 10_000,
      partialTtlMs: 5_000,
      offlineTtlMs: 2_000,
    },
    ...overrides,
  };
}

export function testStartRate(overrides: Partial<StartRatePolicy> = {}): StartRatePolicy {
  return {
    windowMs: 60_000,
    maxStarts: 100,
    maxStartsPerDestination: 100,
    maxTrackedDestinations: 100,
    ...overrides,
  };
}

export function rustInput(host = "play.example.com", timeoutMs = 5_000): HostedQueryInput {
  return {
    game: "rust",
    host,
    port: 28_015,
    queryPort: 28_017,
    mode: "full",
    timeoutMs,
  };
}

export function successfulResult(partial = false): QueryResult {
  return {
    ok: true,
    game: "rust",
    server: {
      name: "Test server",
      players: { online: 1, max: 10 },
    },
    data: { players: [] },
    sources: [{ source: "a2s-info", status: "ok", rttMs: 5 }],
    partial,
    warnings: [],
    durationMs: 8,
  };
}

export function failedResult(code: "CONNECTION_FAILED" | "INVALID_INPUT" | "TIMEOUT"): QueryResult {
  return {
    ok: false,
    game: "rust",
    error: { code, message: "Query failed." },
    sources: [],
    warnings: [],
    durationMs: 5,
  };
}
