export interface StartRatePolicy {
  readonly windowMs: number;
  readonly maxStarts: number;
  readonly maxStartsPerDestination: number;
  readonly maxTrackedDestinations: number;
}

export interface StartRateSnapshot {
  readonly startsInWindow: number;
  readonly maxStarts: number;
  readonly trackedDestinations: number;
  readonly maxTrackedDestinations: number;
}

export type StartRateDecision =
  | { readonly admitted: true; readonly startedAt: number }
  | { readonly admitted: false; readonly retryAfterSeconds: number };

type Clock = () => number;

/** Bounds unique live-query admissions globally and per destination without persistent storage. */
export class StartRateGate {
  readonly #policy: StartRatePolicy;
  readonly #now: Clock;
  readonly #globalStarts: number[] = [];
  readonly #refunds: number[] = [];
  readonly #startsByDestination = new Map<string, number[]>();

  public constructor(policy: StartRatePolicy, now: Clock = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  /**
   * Admits work that costs `cost` starts against both windows at once. Detection, which probes
   * several protocols for one target, pays one start per probe it may send.
   */
  public admit(destination: string, cost = 1): StartRateDecision {
    const now = this.#now();
    this.#prune(this.#globalStarts, now);
    const globalExcess = this.#globalStarts.length + cost - this.#policy.maxStarts;
    if (globalExcess > 0) {
      return {
        admitted: false,
        retryAfterSeconds: this.#retryAfter(this.#globalStarts, now, globalExcess),
      };
    }

    let destinationStarts = this.#startsByDestination.get(destination);
    if (destinationStarts !== undefined) {
      this.#prune(destinationStarts, now);
      if (destinationStarts.length === 0) {
        this.#startsByDestination.delete(destination);
        destinationStarts = undefined;
      }
    }

    if (destinationStarts !== undefined) {
      const excess = destinationStarts.length + cost - this.#policy.maxStartsPerDestination;
      if (excess > 0) {
        return {
          admitted: false,
          retryAfterSeconds: this.#retryAfter(destinationStarts, now, excess),
        };
      }
    } else {
      this.#pruneDestinations(now);
      if (this.#startsByDestination.size >= this.#policy.maxTrackedDestinations) {
        return { admitted: false, retryAfterSeconds: this.#trackedRetryAfter(now) };
      }
      destinationStarts = [];
      this.#startsByDestination.set(destination, destinationStarts);
    }

    for (let start = 0; start < cost; start += 1) {
      this.#globalStarts.push(now);
      destinationStarts.push(now);
    }
    return { admitted: true, startedAt: now };
  }

  /**
   * Returns an admission that never reached the network, so rejected targets cannot drain the
   * shared window or fill the tracked-destination bound. Refunds have their own rolling ceiling of
   * `maxStarts`, so executor calls stay bounded; beyond it the admission stays spent. Expired or
   * cleared admissions are ignored.
   */
  public refund(destination: string, startedAt: number, cost = 1): void {
    for (let start = 0; start < cost; start += 1) {
      if (!this.#refundOne(destination, startedAt)) {
        return;
      }
    }
  }

  #refundOne(destination: string, startedAt: number): boolean {
    const now = this.#now();
    this.#prune(this.#refunds, now);
    if (this.#refunds.length >= this.#policy.maxStarts) {
      return false;
    }
    if (!this.#remove(this.#globalStarts, startedAt)) {
      return false;
    }
    this.#refunds.push(now);
    const destinationStarts = this.#startsByDestination.get(destination);
    if (destinationStarts !== undefined) {
      this.#remove(destinationStarts, startedAt);
      if (destinationStarts.length === 0) {
        this.#startsByDestination.delete(destination);
      }
    }
    return true;
  }

  public snapshot(): StartRateSnapshot {
    const now = this.#now();
    this.#prune(this.#globalStarts, now);
    this.#pruneDestinations(now);
    return {
      startsInWindow: this.#globalStarts.length,
      maxStarts: this.#policy.maxStarts,
      trackedDestinations: this.#startsByDestination.size,
      maxTrackedDestinations: this.#policy.maxTrackedDestinations,
    };
  }

  public clear(): void {
    this.#globalStarts.length = 0;
    this.#refunds.length = 0;
    this.#startsByDestination.clear();
  }

  #prune(starts: number[], now: number): void {
    let expired = 0;
    while (expired < starts.length) {
      const startedAt = starts[expired];
      if (startedAt === undefined || startedAt + this.#policy.windowMs > now) {
        break;
      }
      expired += 1;
    }
    if (expired > 0) {
      starts.splice(0, expired);
    }
  }

  #remove(starts: number[], startedAt: number): boolean {
    // Equal timestamps are interchangeable, so removing any match keeps the window ordered.
    const index = starts.lastIndexOf(startedAt);
    if (index === -1) {
      return false;
    }
    starts.splice(index, 1);
    return true;
  }

  #pruneDestinations(now: number): void {
    for (const [destination, starts] of this.#startsByDestination) {
      this.#prune(starts, now);
      if (starts.length === 0) {
        this.#startsByDestination.delete(destination);
      }
    }
  }

  /** Seconds until `needed` of the oldest starts have left the window. */
  #retryAfter(starts: readonly number[], now: number, needed = 1): number {
    const oldest = starts[Math.min(needed, starts.length) - 1];
    if (oldest === undefined) {
      return 1;
    }
    return Math.max(1, Math.ceil((oldest + this.#policy.windowMs - now) / 1_000));
  }

  #trackedRetryAfter(now: number): number {
    let earliestStart: number | undefined;
    for (const starts of this.#startsByDestination.values()) {
      const oldest = starts[0];
      if (oldest !== undefined) {
        earliestStart = Math.min(earliestStart ?? oldest, oldest);
      }
    }
    return earliestStart === undefined
      ? 1
      : Math.max(1, Math.ceil((earliestStart + this.#policy.windowMs - now) / 1_000));
  }
}
