import type { QuerySourceEvent } from "queryhost";

export type ProgressListener = (event: QuerySourceEvent) => void;

// A query reports a handful of sources, each at most twice. The ceiling only
// guards memory if an executor misbehaves; later events are dropped.
const MAX_EVENTS = 64;

/**
 * Fans one live query's source progress out to every caller sharing it. A
 * caller that joins late first receives the events it missed, in order.
 */
export class QueryProgress {
  readonly #events: QuerySourceEvent[] = [];
  readonly #listeners = new Set<ProgressListener>();

  public publish(event: QuerySourceEvent): void {
    if (this.#events.length >= MAX_EVENTS) {
      return;
    }
    this.#events.push(event);
    for (const listener of this.#listeners) {
      deliver(listener, event);
    }
  }

  /** Replays earlier events, then delivers new ones until the returned function is called. */
  public subscribe(listener: ProgressListener): () => void {
    for (const event of this.#events) {
      deliver(listener, event);
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function deliver(listener: ProgressListener, event: QuerySourceEvent): void {
  try {
    listener(event);
  } catch {
    // One caller's progress handling must not affect the shared query or other callers.
  }
}
