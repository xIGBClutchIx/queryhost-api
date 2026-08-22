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
  { readonly admitted: true } | { readonly admitted: false; readonly retryAfterSeconds: number };

type Clock = () => number;

/** Bounds unique live-query admissions globally and per destination without persistent storage. */
export class StartRateGate {
  readonly #policy: StartRatePolicy;
  readonly #now: Clock;
  readonly #globalStarts: number[] = [];
  readonly #startsByDestination = new Map<string, number[]>();

  public constructor(policy: StartRatePolicy, now: Clock = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  public admit(destination: string): StartRateDecision {
    const now = this.#now();
    this.#prune(this.#globalStarts, now);
    if (this.#globalStarts.length >= this.#policy.maxStarts) {
      return { admitted: false, retryAfterSeconds: this.#retryAfter(this.#globalStarts, now) };
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
      if (destinationStarts.length >= this.#policy.maxStartsPerDestination) {
        return { admitted: false, retryAfterSeconds: this.#retryAfter(destinationStarts, now) };
      }
    } else {
      this.#pruneDestinations(now);
      if (this.#startsByDestination.size >= this.#policy.maxTrackedDestinations) {
        return { admitted: false, retryAfterSeconds: this.#trackedRetryAfter(now) };
      }
      destinationStarts = [];
      this.#startsByDestination.set(destination, destinationStarts);
    }

    this.#globalStarts.push(now);
    destinationStarts.push(now);
    return { admitted: true };
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

  #pruneDestinations(now: number): void {
    for (const [destination, starts] of this.#startsByDestination) {
      this.#prune(starts, now);
      if (starts.length === 0) {
        this.#startsByDestination.delete(destination);
      }
    }
  }

  #retryAfter(starts: readonly number[], now: number): number {
    const oldest = starts[0];
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
