import type { QueryResult } from "queryhost";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapacityGate, CapacityRejectedError } from "../../src/runtime/capacity-gate.js";
import { deferred, successfulResult } from "../helpers.js";

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
    expect(gate.snapshot()).toEqual({ active: 1, queued: 1 });

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
});
