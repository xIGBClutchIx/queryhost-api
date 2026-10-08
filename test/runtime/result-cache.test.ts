import { describe, expect, it } from "vitest";

import { ResultCache } from "../../src/runtime/result-cache.js";
import { failedResult, successfulResult, testConfig } from "../helpers.js";

describe("result cache", () => {
  it("uses result-specific TTLs and never serves stale entries", () => {
    let now = 1_000;
    const cache = new ResultCache(testConfig().cache, () => now);

    expect(cache.set("success", successfulResult(), 5_000)).toBe(10_000);
    expect(cache.set("partial", successfulResult(true), 5_000)).toBe(5_000);
    expect(cache.set("offline", failedResult("TIMEOUT"), 5_000)).toBe(2_000);
    expect(cache.set("invalid", failedResult("INVALID_INPUT"), 5_000)).toBe(0);

    now = 2_500;
    expect(cache.get("offline", 5_000)).toMatchObject({ ageMs: 1_500, ttlMs: 2_000 });
    now = 3_000;
    expect(cache.get("offline", 5_000)).toBeUndefined();
    expect(cache.get("invalid", 5_000)).toBeUndefined();
  });

  it("evicts the least recently used entry at the entry bound", () => {
    const config = testConfig({
      cache: { ...testConfig().cache, maxEntries: 2 },
    });
    const cache = new ResultCache(config.cache);

    cache.set("first", successfulResult(), 5_000);
    cache.set("second", successfulResult(), 5_000);
    expect(cache.get("first", 5_000)).toBeDefined();
    cache.set("third", successfulResult(), 5_000);

    expect(cache.get("first", 5_000)).toBeDefined();
    expect(cache.get("second", 5_000)).toBeUndefined();
    expect(cache.get("third", 5_000)).toBeDefined();
    expect(cache.snapshot().entries).toBe(2);
  });

  it("does not retain an entry larger than the byte budget", () => {
    const cache = new ResultCache({ ...testConfig().cache, maxBytes: 10 });
    expect(cache.set("large", successfulResult(), 5_000)).toBe(0);
    expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("evicts least-recently-used entries at the cumulative byte bound", () => {
    const probe = new ResultCache(testConfig().cache);
    probe.set("probe", successfulResult(), 5_000);
    const entryBytes = probe.snapshot().bytes;
    const cache = new ResultCache({ ...testConfig().cache, maxBytes: entryBytes * 2 });

    cache.set("first", successfulResult(), 5_000);
    cache.set("second", successfulResult(), 5_000);
    expect(cache.get("first", 5_000)).toBeDefined();
    cache.set("third", successfulResult(), 5_000);

    expect(cache.get("first", 5_000)).toBeDefined();
    expect(cache.get("second", 5_000)).toBeUndefined();
    expect(cache.get("third", 5_000)).toBeDefined();
    expect(cache.snapshot().bytes).toBeLessThanOrEqual(entryBytes * 2);
  });

  it("reuses successes for any deadline but failures only for equal or shorter ones", () => {
    const cache = new ResultCache(testConfig().cache);

    cache.set("ok", successfulResult(), 1_000);
    expect(cache.get("ok", 5_000)).toBeDefined();

    cache.set("offline", failedResult("TIMEOUT"), 3_000);
    expect(cache.get("offline", 1_000)).toBeDefined();
    expect(cache.get("offline", 3_000)).toBeDefined();
    expect(cache.get("offline", 5_000)).toBeUndefined();
    expect(cache.snapshot().entries).toBe(2);
  });

  it("keeps a fresh success when an overlapping run fails", () => {
    let now = 1_000;
    const cache = new ResultCache(testConfig().cache, () => now);

    cache.set("target", successfulResult(), 5_000);
    expect(cache.set("target", failedResult("TIMEOUT"), 1_000)).toBe(0);
    expect(cache.get("target", 5_000)?.result.ok).toBe(true);

    now = 20_000;
    expect(cache.set("target", failedResult("TIMEOUT"), 1_000)).toBe(2_000);
    expect(cache.get("target", 1_000)?.result.ok).toBe(false);
  });
});
