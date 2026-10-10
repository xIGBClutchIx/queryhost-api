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

    expect(gate.admit("one")).toMatchObject({ admitted: true });
    expect(gate.admit("one")).toMatchObject({ admitted: true });
    expect(gate.admit("one")).toEqual({ admitted: false, retryAfterSeconds: 10 });
    expect(gate.admit("two")).toMatchObject({ admitted: true });
    expect(gate.admit("three")).toEqual({ admitted: false, retryAfterSeconds: 10 });

    now += 10_000;
    expect(gate.admit("one")).toMatchObject({ admitted: true });
  });

  it("fails closed at the tracked-destination bound and releases expired entries", () => {
    let now = 5_000;
    const gate = new StartRateGate(
      testStartRate({ windowMs: 2_000, maxTrackedDestinations: 2 }),
      () => now,
    );

    expect(gate.admit("one")).toMatchObject({ admitted: true });
    expect(gate.admit("two")).toMatchObject({ admitted: true });
    expect(gate.snapshot()).toMatchObject({ trackedDestinations: 2 });
    expect(gate.admit("three")).toEqual({ admitted: false, retryAfterSeconds: 2 });

    now += 2_000;
    expect(gate.admit("three")).toMatchObject({ admitted: true });
    expect(gate.snapshot()).toMatchObject({ trackedDestinations: 1 });
  });

  it("refunds an admission to both the global and destination windows", () => {
    let now = 1_000;
    const gate = new StartRateGate(
      testStartRate({ maxStarts: 1, maxTrackedDestinations: 1 }),
      () => now,
    );

    const blocked = gate.admit("private");
    expect(blocked).toEqual({ admitted: true, startedAt: 1_000 });
    if (!blocked.admitted) {
      return;
    }
    gate.refund("private", blocked.startedAt);
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 0, trackedDestinations: 0 });

    now += 1;
    expect(gate.admit("public")).toMatchObject({ admitted: true });
    gate.refund("public", blocked.startedAt);
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 1, trackedDestinations: 1 });
  });

  it("bounds refunds with their own rolling window", () => {
    let now = 1_000;
    const gate = new StartRateGate(testStartRate({ windowMs: 10_000, maxStarts: 2 }), () => now);
    const refundNext = (destination: string): void => {
      const decision = gate.admit(destination);
      expect(decision).toMatchObject({ admitted: true });
      if (decision.admitted) {
        gate.refund(destination, decision.startedAt);
      }
    };

    refundNext("one");
    refundNext("two");
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 0 });
    refundNext("three");
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 1, trackedDestinations: 1 });

    now += 10_000;
    refundNext("four");
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 0, trackedDestinations: 0 });
  });

  it("clears all retained admission state", () => {
    const gate = new StartRateGate(testStartRate());
    expect(gate.admit("one")).toMatchObject({ admitted: true });
    gate.clear();
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 0, trackedDestinations: 0 });
  });

  it("charges and refunds a multi-start admission as one unit", () => {
    let now = 1_000;
    const gate = new StartRateGate(
      testStartRate({ windowMs: 10_000, maxStarts: 8, maxStartsPerDestination: 5 }),
      () => now,
    );

    const detection = gate.admit("host:*", 5);
    expect(detection).toEqual({ admitted: true, startedAt: 1_000 });
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 5 });
    now += 2_000;
    expect(gate.admit("host:*")).toEqual({ admitted: false, retryAfterSeconds: 8 });
    expect(gate.admit("other:*", 4)).toEqual({ admitted: false, retryAfterSeconds: 8 });
    expect(gate.admit("other:*", 3)).toMatchObject({ admitted: true });

    if (detection.admitted) {
      gate.refund("host:*", detection.startedAt, 5);
    }
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 3, trackedDestinations: 1 });
    expect(gate.admit("host:*", 5)).toMatchObject({ admitted: true });
  });

  it("refunds a multi-start admission whole or not at all", () => {
    const gate = new StartRateGate(testStartRate({ windowMs: 10_000, maxStarts: 6 }), () => 1_000);
    const single = gate.admit("one");
    if (single.admitted) {
      gate.refund("one", single.startedAt);
    }
    const detection = gate.admit("host:*", 6);
    expect(detection).toMatchObject({ admitted: true });
    if (detection.admitted) {
      gate.refund("host:*", detection.startedAt, 6);
    }
    expect(gate.snapshot()).toMatchObject({ startsInWindow: 6, trackedDestinations: 1 });
  });
});
