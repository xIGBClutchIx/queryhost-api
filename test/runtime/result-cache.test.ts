import { describe, expect, it } from "vitest";

import { ResultCache } from "../../src/runtime/result-cache.js";
import { failedResult, successfulResult, testConfig } from "../helpers.js";

describe("result cache", () => {
  it("uses result-specific TTLs and never serves stale entries", () => {
    let now = 1_000;
    const cache = new ResultCache(testConfig().cache, () => now);

    expect(cache.set("success", successfulResult())).toBe(10_000);
    expect(cache.set("partial", successfulResult(true))).toBe(5_000);
    expect(cache.set("offline", failedResult("TIMEOUT"))).toBe(2_000);
    expect(cache.set("invalid", failedResult("INVALID_INPUT"))).toBe(0);

    now = 2_500;
    expect(cache.get("offline")).toMatchObject({ ageMs: 1_500, ttlMs: 2_000 });
    now = 3_000;
    expect(cache.get("offline")).toBeUndefined();
    expect(cache.get("invalid")).toBeUndefined();
  });

  it("evicts the least recently used entry at the entry bound", () => {
    const config = testConfig({
      cache: { ...testConfig().cache, maxEntries: 2 },
    });
    const cache = new ResultCache(config.cache);

    cache.set("first", successfulResult());
    cache.set("second", successfulResult());
    expect(cache.get("first")).toBeDefined();
    cache.set("third", successfulResult());

    expect(cache.get("first")).toBeDefined();
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toBeDefined();
    expect(cache.snapshot().entries).toBe(2);
  });

  it("does not retain an entry larger than the byte budget", () => {
    const cache = new ResultCache({ ...testConfig().cache, maxBytes: 10 });
    expect(cache.set("large", successfulResult())).toBe(0);
    expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("evicts least-recently-used entries at the cumulative byte bound", () => {
    const probe = new ResultCache(testConfig().cache);
    probe.set("probe", successfulResult());
    const entryBytes = probe.snapshot().bytes;
    const cache = new ResultCache({ ...testConfig().cache, maxBytes: entryBytes * 2 });

    cache.set("first", successfulResult());
    cache.set("second", successfulResult());
    expect(cache.get("first")).toBeDefined();
    cache.set("third", successfulResult());

    expect(cache.get("first")).toBeDefined();
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toBeDefined();
    expect(cache.snapshot().bytes).toBeLessThanOrEqual(entryBytes * 2);
  });
});
