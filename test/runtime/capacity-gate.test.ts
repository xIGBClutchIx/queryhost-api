import type { QueryResult } from "queryhost";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapacityGate, CapacityRejectedError } from "../../src/runtime/capacity-gate.js";
import { deferred, failedResult, successfulResult, testStartRate } from "../helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("capacity gate", () => {
  it("rejects beyond active and queue limits without starting extra work", async () => {
    const gate = new CapacityGate({
      maxActive: 1,
      maxQueued: 1,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate(),
    });
    const first = deferred<QueryResult>();
    let starts = 0;
    const task = (): Promise<QueryResult> => {
      starts += 1;
      return first.promise;
    };

    const active = gate.run("one", task);
    const queued = gate.run("two", () => Promise.resolve(successfulResult()));
    await expect(
      gate.run("three", () => Promise.resolve(successfulResult())),
    ).rejects.toBeInstanceOf(CapacityRejectedError);
    expect(starts).toBe(1);
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1 });

    first.resolve(successfulResult());
    await expect(active).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toMatchObject({ ok: true });
  });

  it("allows another destination while one destination is saturated", async () => {
    const gate = new CapacityGate({
      maxActive: 2,
      maxQueued: 2,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate(),
    });
    const first = deferred<QueryResult>();
    const sameDestination = vi.fn(() => Promise.resolve(successfulResult()));
    const otherDestination = vi.fn(() => Promise.resolve(successfulResult()));

    const active = gate.run("one", () => first.promise);
    const queued = gate.run("one", sameDestination);
    await expect(gate.run("two", otherDestination)).resolves.toMatchObject({ ok: true });
    expect(otherDestination).toHaveBeenCalledOnce();
    expect(sameDestination).not.toHaveBeenCalled();

    first.resolve(successfulResult());
    await active;
    await queued;
    expect(sameDestination).toHaveBeenCalledOnce();
  });

  it("delays a second start until the destination cooldown expires", async () => {
    vi.useFakeTimers();
    const gate = new CapacityGate(
      {
        maxActive: 2,
        maxQueued: 2,
        maxPerDestination: 2,
        destinationCooldownMs: 250,
        startRate: testStartRate(),
      },
      Date.now,
    );
    const task = vi.fn(() => Promise.resolve(successfulResult()));

    await gate.run("one", task);
    const delayed = gate.run("one", task);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await delayed;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("rejects excess admissions without invoking their tasks", async () => {
    const gate = new CapacityGate({
      maxActive: 2,
      maxQueued: 0,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate({ maxStarts: 1, maxStartsPerDestination: 1 }),
    });
    const task = vi.fn(() => Promise.resolve(successfulResult()));

    await expect(gate.run("one", task)).resolves.toMatchObject({ ok: true });
    const rejected = gate.run("two", task);
    await expect(rejected).rejects.toMatchObject({ retryAfterSeconds: 60 });
    expect(task).toHaveBeenCalledOnce();
  });

  it("does not spend the admission window on blocked targets", async () => {
    const gate = new CapacityGate({
      maxActive: 2,
      maxQueued: 0,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate({ maxStarts: 3, maxTrackedDestinations: 3 }),
    });
    const blocked = vi.fn(() => Promise.resolve(failedResult("TARGET_BLOCKED")));

    for (let index = 0; index < 3; index += 1) {
      await expect(gate.run(`10.0.0.${index}:28017`, blocked)).resolves.toMatchObject({
        ok: false,
        error: { code: "TARGET_BLOCKED" },
      });
    }
    expect(gate.snapshot().rate).toMatchObject({ startsInWindow: 0, trackedDestinations: 0 });
    await expect(
      gate.run("play.example.com:28017", () => Promise.resolve(successfulResult())),
    ).resolves.toMatchObject({ ok: true });
  });

  it("stops calling the executor once blocked refunds exhaust their window", async () => {
    const gate = new CapacityGate({
      maxActive: 2,
      maxQueued: 0,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate({ maxStarts: 2 }),
    });
    const blocked = vi.fn(() => Promise.resolve(failedResult("TARGET_BLOCKED")));

    for (let index = 0; index < 4; index += 1) {
      await expect(gate.run(`10.0.0.${index}:28017`, blocked)).resolves.toMatchObject({
        ok: false,
      });
    }
    await expect(gate.run("10.0.0.4:28017", blocked)).rejects.toBeInstanceOf(CapacityRejectedError);
    expect(blocked).toHaveBeenCalledTimes(4);
  });

  it("keeps the admission spent for targets that were queried", async () => {
    const gate = new CapacityGate({
      maxActive: 2,
      maxQueued: 0,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate({ maxStarts: 1 }),
    });

    await expect(
      gate.run("one", () => Promise.resolve(failedResult("TIMEOUT"))),
    ).resolves.toMatchObject({ ok: false });
    await expect(gate.run("two", () => Promise.resolve(successfulResult()))).rejects.toBeInstanceOf(
      CapacityRejectedError,
    );
  });

  it("charges custom work its cost and refunds it by the caller's rule", async () => {
    const gate = new CapacityGate({
      maxActive: 2,
      maxQueued: 0,
      maxPerDestination: 1,
      destinationCooldownMs: 0,
      startRate: testStartRate({ maxStarts: 6 }),
    });
    const charge = { cost: 4, refundable: (value: string) => value === "blocked" };

    await expect(gate.runCharged("one", () => Promise.resolve("blocked"), charge)).resolves.toBe(
      "blocked",
    );
    expect(gate.snapshot().rate).toMatchObject({ startsInWindow: 0 });
    await expect(gate.runCharged("one", () => Promise.resolve("ok"), charge)).resolves.toBe("ok");
    expect(gate.snapshot().rate).toMatchObject({ startsInWindow: 4 });
    const task = vi.fn(() => Promise.resolve("ok"));
    await expect(gate.runCharged("two", task, charge)).rejects.toBeInstanceOf(
      CapacityRejectedError,
    );
    expect(task).not.toHaveBeenCalled();
  });

  it("renews a queued charge when it starts and refuses one that expired while queued", async () => {
    vi.useFakeTimers();
    const gate = new CapacityGate({
      maxActive: 4,
      maxQueued: 4,
      maxPerDestination: 1,
      destinationCooldownMs: 1_500,
      startRate: testStartRate({ windowMs: 1_000, maxStarts: 2 }),
    });
    const ok = (): Promise<QueryResult> => Promise.resolve(successfulResult());
    await expect(gate.run("one", ok)).resolves.toMatchObject({ ok: true });
    const queuedTask = vi.fn(ok);
    const queued = expect(gate.run("one", queuedTask)).rejects.toBeInstanceOf(
      CapacityRejectedError,
    );
    expect(gate.snapshot()).toMatchObject({ queued: 1, rate: { startsInWindow: 2 } });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(gate.run("two", ok)).resolves.toMatchObject({ ok: true });
    await expect(gate.run("three", ok)).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(500);

    await queued;
    expect(queuedTask).not.toHaveBeenCalled();
    expect(gate.snapshot().rate).toMatchObject({ startsInWindow: 2 });
  });

  it("keeps a queued charge in the window from the moment its work starts", async () => {
    vi.useFakeTimers();
    const gate = new CapacityGate({
      maxActive: 4,
      maxQueued: 4,
      maxPerDestination: 1,
      destinationCooldownMs: 500,
      startRate: testStartRate({ windowMs: 1_000, maxStarts: 4 }),
    });
    const ok = (): Promise<QueryResult> => Promise.resolve(successfulResult());
    await gate.run("one", ok);
    const queued = gate.runCharged("one", ok, { cost: 2, refundable: () => false });
    await vi.advanceTimersByTimeAsync(500);
    await expect(queued).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(600);
    // The first start has expired; the renewed charge from t=500 is still counted.
    expect(gate.snapshot().rate).toMatchObject({ startsInWindow: 2 });
  });
});
