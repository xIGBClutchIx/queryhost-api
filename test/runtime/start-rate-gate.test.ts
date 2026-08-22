import { describe, expect, it } from "vitest";

import { StartRateGate } from "../../src/runtime/start-rate-gate.js";
import { testStartRate } from "../helpers.js";

describe("start rate gate", () => {
  it("enforces global and per-destination rolling windows", () => {
    let now = 1_000;
    const gate = new StartRateGate(
      testStartRate({ windowMs: 10_000, maxStarts: 3, maxStartsPerDestination: 2 }),
      () => now,
    );

    expect(gate.admit("one")).toEqual({ admitted: true });
    expect(gate.admit("one")).toEqual({ admitted: true });
    expect(gate.admit("one")).toEqual({ admitted: false, retryAfterSeconds: 10 });
    expect(gate.admit("two")).toEqual({ admitted: true });
    expect(gate.admit("three")).toEqual({ admitted: false, retryAfterSeconds: 10 });

    now += 10_000;
    expect(gate.admit("one")).toEqual({ admitted: true });
  });

  it("fails closed at the tracked-destination bound and releases expired entries", () => {
    let now = 5_000;
    const gate = new StartRateGate(
      testStartRate({ windowMs: 2_000, maxTrackedDestinations: 2 }),
      () => now,
    );

    expect(gate.admit("one")).toEqual({ admitted: true });
    expect(gate.admit("two")).toEqual({ admitted: true });
    expect(gate.snapshot()).toMatchObject({ trackedDestinations: 2 });
    expect(gate.admit("three")).toEqual({ admitted: false, retryAfterSeconds: 2 });

    now += 2_000;
    expect(gate.admit("three")).toEqual({ admitted: true });
    expect(gate.snapshot()).toMatchObject({ trackedDestinations: 1 });
  });

  it("clears all retained admission state", () => {
    const gate = new StartRateGate(testStartRate());
    expect(gate.admit("one")).toEqual({ admitted: true });
    gate.clear();
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 0, trackedDestinations: 0 });
  });
});
