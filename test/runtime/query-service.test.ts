import type { QueryResult } from "queryhost";
import { describe, expect, it, vi } from "vitest";

import type { HostedQueryInput, QueryExecutor } from "../../src/contracts.js";
import { CapacityRejectedError } from "../../src/runtime/capacity-gate.js";
import { QueryService } from "../../src/runtime/query-service.js";
import { UsageStats } from "../../src/runtime/usage-stats.js";
import {
  deferred,
  failedResult,
  rustInput,
  successfulResult,
  testConfig,
  testStartRate,
} from "../helpers.js";

describe("query service", () => {
  it("coalesces concurrent identical requests and then serves the cache", async () => {
    let now = 1_000;
    const execution = deferred<QueryResult>();
    const executor = vi.fn(() => execution.promise);
    const service = new QueryService(testConfig(), executor, () => now);

    const first = service.execute(rustInput());
    const second = service.execute(rustInput());
    expect(executor).toHaveBeenCalledOnce();
    expect(service.snapshot().inFlight).toBe(1);

    execution.resolve(successfulResult());
    await expect(first).resolves.toMatchObject({ cache: { status: "miss", ageMs: 0 } });
    await expect(second).resolves.toMatchObject({ cache: { status: "coalesced", ageMs: 0 } });
    expect(service.snapshot().capacity.rate.startsInWindow).toBe(1);

    now = 1_250;
    await expect(service.execute(rustInput())).resolves.toMatchObject({
      cache: { status: "hit", ageMs: 250, ttlMs: 10_000 },
    });
    expect(executor).toHaveBeenCalledOnce();
    expect(service.snapshot().capacity.rate.startsInWindow).toBe(1);
  });

  it("does not let one waiter cancel shared live work", async () => {
    const execution = deferred<QueryResult>();
    let executedInput: HostedQueryInput | undefined;
    const execute = (input: HostedQueryInput): Promise<QueryResult> => {
      executedInput = input;
      return execution.promise;
    };
    const executor: QueryExecutor = execute;
    const service = new QueryService(testConfig(), executor);

    const abandonedWaiter = service.execute(rustInput());
    const remainingWaiter = service.execute(rustInput());
    execution.resolve(successfulResult());

    await expect(remainingWaiter).resolves.toMatchObject({ ok: true });
    await expect(abandonedWaiter).resolves.toMatchObject({ ok: true });
    expect(executedInput).toBeDefined();
    expect(executedInput?.signal).toBeUndefined();
  });

  it("releases failed in-flight work and converts executor exceptions", async () => {
    const executor = vi.fn(() => Promise.reject(new Error("private implementation detail")));
    const service = new QueryService(testConfig(), executor);

    await expect(service.execute(rustInput())).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The hosted query failed unexpectedly." },
      cache: { status: "miss", ttlMs: 0 },
    });
    expect(service.snapshot().inFlight).toBe(0);

    await service.execute(rustInput());
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("enforces a hard work ceiling under a burst of unique targets", async () => {
    const executions: Array<ReturnType<typeof deferred<QueryResult>>> = [];
    let active = 0;
    let peakActive = 0;
    const executor = vi.fn((): Promise<QueryResult> => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      const execution = deferred<QueryResult>();
      executions.push(execution);
      return execution.promise.finally(() => {
        active -= 1;
      });
    });
    const service = new QueryService(
      testConfig({
        capacity: {
          maxActive: 2,
          maxQueued: 3,
          maxPerDestination: 1,
          destinationCooldownMs: 0,
          startRate: testStartRate(),
        },
      }),
      executor,
    );

    const accepted = Array.from({ length: 5 }, (_, index) =>
      service.execute(rustInput(`server-${index}.example.com`)),
    );
    const rejected = service.execute(rustInput("server-5.example.com"));

    await expect(rejected).rejects.toBeInstanceOf(CapacityRejectedError);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(service.snapshot().capacity).toMatchObject({ active: 2, queued: 3 });

    let completed = 0;
    while (completed < accepted.length) {
      const execution = executions.shift();
      if (execution === undefined) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continue;
      }
      execution.resolve(successfulResult());
      completed += 1;
      await Promise.resolve();
    }
    await Promise.all(accepted);
    expect(peakActive).toBe(2);
    expect(executor).toHaveBeenCalledTimes(5);
  });

  it("shares results across deadlines without serving a shorter deadline's failure", async () => {
    const executor = vi.fn((input: HostedQueryInput): Promise<QueryResult> =>
      Promise.resolve(input.timeoutMs < 5_000 ? failedResult("TIMEOUT") : successfulResult()),
    );
    const service = new QueryService(testConfig(), executor);

    await expect(service.execute(rustInput("play.example.com", 3_000))).resolves.toMatchObject({
      ok: false,
      cache: { status: "miss" },
    });
    await expect(service.execute(rustInput("play.example.com", 1_000))).resolves.toMatchObject({
      ok: false,
      cache: { status: "hit" },
    });
    await expect(service.execute(rustInput())).resolves.toMatchObject({
      ok: true,
      cache: { status: "miss" },
    });
    await expect(service.execute(rustInput("play.example.com", 3_000))).resolves.toMatchObject({
      ok: true,
      cache: { status: "hit" },
    });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("coalesces only onto live work that fits the caller's deadline and budget", async () => {
    let now = 0;
    const executions: Array<ReturnType<typeof deferred<QueryResult>>> = [];
    const executor = vi.fn((): Promise<QueryResult> => {
      const execution = deferred<QueryResult>();
      executions.push(execution);
      return execution.promise;
    });
    const config = testConfig({
      capacity: { ...testConfig().capacity, maxPerDestination: 4 },
    });
    const service = new QueryService(config, executor, () => now);

    const long = service.execute(rustInput("play.example.com", 5_000));
    now = 500;
    // Shorter budget, but the shared run could outlast this caller's deadline.
    const short = service.execute(rustInput("play.example.com", 1_000));
    // Same budget, ends after the in-flight run: safe to share.
    const later = service.execute(rustInput("play.example.com", 5_000));
    expect(executor).toHaveBeenCalledTimes(2);

    for (const execution of executions) {
      execution.resolve(successfulResult());
    }
    await expect(long).resolves.toMatchObject({ cache: { status: "miss" } });
    await expect(short).resolves.toMatchObject({ cache: { status: "miss" } });
    await expect(later).resolves.toMatchObject({ cache: { status: "coalesced" } });
  });

  it("counts cache outcomes, live results, and latency without recording targets", async () => {
    let now = 0;
    const usage = new UsageStats(() => now);
    const executor = vi.fn((input: HostedQueryInput): Promise<QueryResult> => {
      now += input.host === "slow.example.com" ? 6_000 : 80;
      return Promise.resolve(
        input.host === "slow.example.com" ? failedResult("TIMEOUT") : successfulResult(true),
      );
    });
    const service = new QueryService(testConfig(), executor, () => now, usage);

    await service.execute(rustInput());
    await service.execute(rustInput());
    await service.execute(rustInput("slow.example.com"));

    const snapshot = usage.snapshot();
    expect(snapshot).toMatchObject({
      queries: { hit: 1, miss: 2, coalesced: 0 },
      games: { rust: 3 },
      live: { ok: 0, partial: 1, failed: 1, errors: { TIMEOUT: 1 } },
    });
    expect(snapshot.live.latencyMs[0]).toEqual({ le: 100, count: 1 });
    expect(snapshot.live.latencyMs.at(-1)).toEqual({ le: null, count: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
  });

  it("coalesces a burst of short-deadline requests behind a longer incompatible run", async () => {
    let now = 0;
    const executions: Array<ReturnType<typeof deferred<QueryResult>>> = [];
    const executor = vi.fn((): Promise<QueryResult> => {
      const execution = deferred<QueryResult>();
      executions.push(execution);
      return execution.promise;
    });
    const config = testConfig({
      capacity: { ...testConfig().capacity, maxPerDestination: 4 },
    });
    const service = new QueryService(config, executor, () => now);

    const long = service.execute(rustInput("play.example.com", 5_000));
    now = 100;
    const shorts = Array.from({ length: 3 }, () =>
      service.execute(rustInput("play.example.com", 3_000)),
    );
    expect(executor).toHaveBeenCalledTimes(2);
    expect(service.snapshot().inFlight).toBe(2);

    for (const execution of executions) {
      execution.resolve(successfulResult());
    }
    await expect(long).resolves.toMatchObject({ cache: { status: "miss" } });
    const statuses = (await Promise.all(shorts)).map((result) => result.cache.status);
    expect(statuses).toEqual(["miss", "coalesced", "coalesced"]);
    expect(service.snapshot().inFlight).toBe(0);
  });
});
