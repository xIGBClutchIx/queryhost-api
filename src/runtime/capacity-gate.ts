import type { QueryResult } from "queryhost";

import type { CapacityConfig } from "../config.js";
import { StartRateGate, type StartRateSnapshot } from "./start-rate-gate.js";

type Clock = () => number;

interface QueueEntry {
  readonly destination: string;
  /** Starts the admitted work and settles its caller's promise; never rejects. */
  /**
   * Renews the entry's start-rate charge just before it starts. A refused renewal settles the
   * caller's promise and returns false, and the entry is dropped without starting.
   */
  readonly renew: () => boolean;
  readonly start: () => Promise<void>;
  readonly reject: (error: Error) => void;
}

/** How one unit of gated work is charged against the start-rate windows. */
export interface CapacityCharge<T> {
  /** Starts the work consumes in the rolling windows, such as one per detection probe. */
  readonly cost: number;
  /** Whether a finished task never reached the network, so its starts are refunded. */
  readonly refundable: (result: T) => boolean;
}

export interface CapacitySnapshot {
  readonly active: number;
  readonly queued: number;
  readonly rate: StartRateSnapshot;
}

// The library rejects blocked targets before sending any game-query packet. Refunding them keeps
// queries to private hosts from locking every caller out of the admission window.
const QUERY_CHARGE: CapacityCharge<QueryResult> = {
  cost: 1,
  refundable: (result) => !result.ok && result.error.code === "TARGET_BLOCKED",
};

export class CapacityRejectedError extends Error {
  public readonly retryAfterSeconds: number;

  public constructor(message = "The query service is at capacity.", retryAfterSeconds = 1) {
    super(message);
    this.name = "CapacityRejectedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Bounds active and waiting work while applying per-destination limits and start cooldowns. */
export class CapacityGate {
  readonly #config: CapacityConfig;
  readonly #now: Clock;
  readonly #startRate: StartRateGate;
  readonly #activeByDestination = new Map<string, number>();
  readonly #lastStartByDestination = new Map<string, number>();
  readonly #queue: QueueEntry[] = [];
  #active = 0;
  #closed = false;
  #cooldownCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(config: CapacityConfig, now: Clock = Date.now) {
    this.#config = config;
    this.#now = now;
    this.#startRate = new StartRateGate(config.startRate, now);
  }

  /** Runs one live query, charged a single start. */
  public run(destination: string, task: () => Promise<QueryResult>): Promise<QueryResult> {
    return this.runCharged(destination, task, QUERY_CHARGE);
  }

  /** Runs gated work whose start-rate cost and refund rule the caller supplies. */
  public runCharged<T>(
    destination: string,
    task: () => Promise<T>,
    charge: CapacityCharge<T>,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new CapacityRejectedError("The query service is shutting down."));
    }

    const canStart = this.#canStart(destination);
    if (!canStart && this.#queue.length >= this.#config.maxQueued) {
      return Promise.reject(new CapacityRejectedError());
    }

    const admission = this.#startRate.admit(destination, charge.cost);
    if (!admission.admitted) {
      return Promise.reject(
        new CapacityRejectedError(
          "The query service admission rate is limited.",
          admission.retryAfterSeconds,
        ),
      );
    }

    let startedAt = admission.startedAt;
    const admittedTask = async (): Promise<T> => {
      const result = await task();
      if (charge.refundable(result)) {
        this.#startRate.refund(destination, startedAt, charge.cost);
      }
      return result;
    };

    if (canStart) {
      return this.#start(destination, admittedTask);
    }

    return new Promise<T>((resolve, reject) => {
      // Queued work may wait past its window, so its charge is renewed as it starts.
      const renew = (): boolean => {
        const renewed = this.#startRate.renew(destination, startedAt, charge.cost);
        if (!renewed.admitted) {
          reject(
            new CapacityRejectedError(
              "The query service admission rate is limited.",
              renewed.retryAfterSeconds,
            ),
          );
          return false;
        }
        startedAt = renewed.startedAt;
        return true;
      };
      const start = (): Promise<void> => admittedTask().then(resolve, reject);
      this.#queue.push({ destination, renew, start, reject });
      this.#drain();
    });
  }

  public snapshot(): CapacitySnapshot {
    return { active: this.#active, queued: this.#queue.length, rate: this.#startRate.snapshot() };
  }

  public close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#cooldownCleanupTimer !== undefined) {
      clearTimeout(this.#cooldownCleanupTimer);
      this.#cooldownCleanupTimer = undefined;
    }
    const error = new CapacityRejectedError("The query service is shutting down.");
    for (const entry of this.#queue.splice(0)) {
      entry.reject(error);
    }
    this.#startRate.clear();
  }

  #canStart(destination: string): boolean {
    if (this.#active >= this.#config.maxActive) {
      return false;
    }
    if ((this.#activeByDestination.get(destination) ?? 0) >= this.#config.maxPerDestination) {
      return false;
    }
    return this.#cooldownRemaining(destination) === 0;
  }

  #cooldownRemaining(destination: string): number {
    const lastStart = this.#lastStartByDestination.get(destination);
    if (lastStart === undefined) {
      return 0;
    }
    return Math.max(0, lastStart + this.#config.destinationCooldownMs - this.#now());
  }

  #start<T>(destination: string, task: () => Promise<T>): Promise<T> {
    this.#active += 1;
    this.#activeByDestination.set(
      destination,
      (this.#activeByDestination.get(destination) ?? 0) + 1,
    );
    this.#lastStartByDestination.set(destination, this.#now());
    this.#scheduleCooldownCleanup();

    return task().finally(() => {
      this.#active -= 1;
      const destinationActive = (this.#activeByDestination.get(destination) ?? 1) - 1;
      if (destinationActive === 0) {
        this.#activeByDestination.delete(destination);
      } else {
        this.#activeByDestination.set(destination, destinationActive);
      }
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#closed || this.#active >= this.#config.maxActive || this.#queue.length === 0) {
      return;
    }

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    let earliestCooldown: number | undefined;
    let index = 0;
    while (index < this.#queue.length && this.#active < this.#config.maxActive) {
      const entry = this.#queue[index];
      if (entry === undefined) {
        break;
      }

      const destinationActive = this.#activeByDestination.get(entry.destination) ?? 0;
      const cooldown = this.#cooldownRemaining(entry.destination);
      if (destinationActive < this.#config.maxPerDestination && cooldown === 0) {
        this.#queue.splice(index, 1);
        if (entry.renew()) {
          void this.#start(entry.destination, entry.start);
        }
        continue;
      }

      if (destinationActive < this.#config.maxPerDestination && cooldown > 0) {
        earliestCooldown = Math.min(earliestCooldown ?? cooldown, cooldown);
      }
      index += 1;
    }

    if (
      this.#queue.length > 0 &&
      this.#active < this.#config.maxActive &&
      earliestCooldown !== undefined
    ) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#drain();
      }, earliestCooldown);
    }
  }

  #scheduleCooldownCleanup(): void {
    if (
      this.#config.destinationCooldownMs === 0 ||
      this.#cooldownCleanupTimer !== undefined ||
      this.#closed
    ) {
      return;
    }

    this.#cooldownCleanupTimer = setTimeout(() => {
      this.#cooldownCleanupTimer = undefined;
      const now = this.#now();
      for (const [destination, lastStart] of this.#lastStartByDestination) {
        if (lastStart + this.#config.destinationCooldownMs <= now) {
          this.#lastStartByDestination.delete(destination);
        }
      }
      if (this.#lastStartByDestination.size > 0) {
        this.#scheduleCooldownCleanup();
      }
    }, this.#config.destinationCooldownMs);
    this.#cooldownCleanupTimer.unref();
  }
}
