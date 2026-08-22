import type { QueryResult } from "queryhost";

import type { CapacityConfig } from "../config.js";

type Clock = () => number;
type QueryTask = () => Promise<QueryResult>;

interface QueueEntry {
  readonly destination: string;
  readonly task: QueryTask;
  readonly resolve: (result: QueryResult) => void;
  readonly reject: (error: Error) => void;
}

export interface CapacitySnapshot {
  readonly active: number;
  readonly queued: number;
}

export class CapacityRejectedError extends Error {
  public constructor(message = "The query service is at capacity.") {
    super(message);
    this.name = "CapacityRejectedError";
  }
}

/** Bounds active and waiting work while applying per-destination limits and start cooldowns. */
export class CapacityGate {
  readonly #config: CapacityConfig;
  readonly #now: Clock;
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
  }

  public run(destination: string, task: QueryTask): Promise<QueryResult> {
    if (this.#closed) {
      return Promise.reject(new CapacityRejectedError("The query service is shutting down."));
    }

    if (this.#canStart(destination)) {
      return this.#start(destination, task);
    }

    if (this.#queue.length >= this.#config.maxQueued) {
      return Promise.reject(new CapacityRejectedError());
    }

    return new Promise<QueryResult>((resolve, reject) => {
      this.#queue.push({ destination, task, resolve, reject });
      this.#drain();
    });
  }

  public snapshot(): CapacitySnapshot {
    return { active: this.#active, queued: this.#queue.length };
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

  #start(destination: string, task: QueryTask): Promise<QueryResult> {
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
        void this.#start(entry.destination, entry.task).then(entry.resolve, entry.reject);
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
