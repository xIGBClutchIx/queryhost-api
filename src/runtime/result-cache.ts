import { Buffer } from "node:buffer";

import type { QueryResult } from "queryhost";

export interface CachePolicy {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly successTtlMs: number;
  readonly partialTtlMs: number;
  readonly offlineTtlMs: number;
}

export interface CacheSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface CacheLookup {
  readonly result: QueryResult;
  readonly ageMs: number;
  readonly ttlMs: number;
}

interface CacheEntry {
  readonly result: QueryResult;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly ttlMs: number;
  readonly bytes: number;
}

type Clock = () => number;

const OFFLINE_CODES: ReadonlySet<string> = new Set(["CONNECTION_FAILED", "DNS_FAILED", "TIMEOUT"]);

/** Selects the short hosted TTL for a completed library result. */
export function resultTtlMs(result: QueryResult, policy: CachePolicy): number {
  if (result.ok) {
    return result.partial ? policy.partialTtlMs : policy.successTtlMs;
  }
  return OFFLINE_CODES.has(result.error.code) ? policy.offlineTtlMs : 0;
}

/** Process-local byte- and entry-bounded LRU for short query results. */
export class ResultCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #policy: CachePolicy;
  readonly #now: Clock;
  #bytes = 0;

  public constructor(policy: CachePolicy, now: Clock = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  public get(key: string): CacheLookup | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }

    const now = this.#now();
    if (now >= entry.expiresAt) {
      this.#delete(key, entry);
      return undefined;
    }

    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { result: entry.result, ageMs: Math.max(0, now - entry.storedAt), ttlMs: entry.ttlMs };
  }

  public set(key: string, result: QueryResult): number {
    const ttlMs = resultTtlMs(result, this.#policy);
    if (ttlMs === 0) {
      return 0;
    }

    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > this.#policy.maxBytes) {
      return 0;
    }

    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#delete(key, existing);
    }

    const storedAt = this.#now();
    this.#entries.set(key, {
      result,
      storedAt,
      expiresAt: storedAt + ttlMs,
      ttlMs,
      bytes,
    });
    this.#bytes += bytes;
    this.#evict();
    return ttlMs;
  }

  public snapshot(): CacheSnapshot {
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxEntries: this.#policy.maxEntries,
      maxBytes: this.#policy.maxBytes,
    };
  }

  #delete(key: string, entry: CacheEntry): void {
    if (this.#entries.delete(key)) {
      this.#bytes -= entry.bytes;
    }
  }

  #evict(): void {
    while (this.#entries.size > this.#policy.maxEntries || this.#bytes > this.#policy.maxBytes) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) {
        return;
      }
      const [key, entry] = oldest;
      this.#delete(key, entry);
    }
  }
}
