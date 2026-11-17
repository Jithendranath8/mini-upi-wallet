import { AsyncLocalStorage } from 'node:async_hooks';

export type TraceLevel = 'info' | 'ok' | 'warn' | 'error';

export interface TraceStep {
  /** Milliseconds since the trace started. */
  atMs: number;
  component: string;
  message: string;
  level: TraceLevel;
}

export interface FeedItem extends TraceStep {
  timestamp: string;
  traceId: string | null;
}

/** Everything one request (or one background job) did, in order. */
export class RequestTrace {
  readonly steps: TraceStep[] = [];
  readonly startedAt = Date.now();

  constructor(
    readonly id: string,
    readonly label: string,
  ) {}

  add(component: string, message: string, level: TraceLevel): TraceStep {
    const step: TraceStep = { atMs: Date.now() - this.startedAt, component, message, level };
    this.steps.push(step);
    return step;
  }

  toJSON(): { id: string; label: string; startedAt: string; steps: TraceStep[] } {
    return { id: this.id, label: this.label, startedAt: new Date(this.startedAt).toISOString(), steps: this.steps };
  }
}

/**
 * PATTERN: Singleton. A cross-cutting, process-wide recorder of "what happened inside".
 *
 * Components call `tracer.step('Cache', 'HIT wallet:u1')` without knowing which request they
 * are serving: AsyncLocalStorage carries the current RequestTrace through every await.
 * Work that outlives the request (queue jobs, replica apply) passes the trace along explicitly,
 * the same way a real system propagates a trace id in message headers.
 */
export class Tracer {
  static #instance: Tracer | undefined;
  static readonly MAX_TRACES = 300;
  static readonly MAX_FEED = 250;

  readonly #storage = new AsyncLocalStorage<RequestTrace>();
  readonly #traces = new Map<string, RequestTrace>();
  #feed: FeedItem[] = [];

  private constructor() {}

  static getInstance(): Tracer {
    return (Tracer.#instance ??= new Tracer());
  }

  /** Runs `fn` with `trace` as the current trace for everything it awaits. */
  run<T>(trace: RequestTrace, fn: () => T): T {
    this.#traces.set(trace.id, trace);
    if (this.#traces.size > Tracer.MAX_TRACES) {
      const oldest = this.#traces.keys().next().value;
      if (oldest !== undefined) this.#traces.delete(oldest);
    }
    return this.#storage.run(trace, fn);
  }

  /**
   * Runs `fn` as a continuation of `trace` (or of no trace at all). Used by background workers
   * so a job is attributed to the request that created it, not to whichever request happened
   * to wake the worker.
   */
  continueWith<T>(trace: RequestTrace | undefined, fn: () => T): T {
    return trace ? this.#storage.run(trace, fn) : this.#storage.exit(fn);
  }

  current(): RequestTrace | undefined {
    return this.#storage.getStore();
  }

  /** Records a step on the given trace (default: the current one) and on the live feed. */
  step(component: string, message: string, level: TraceLevel = 'info', trace = this.current()): void {
    const step = trace
      ? trace.add(component, message, level)
      : ({ atMs: 0, component, message, level } satisfies TraceStep);
    this.#feed.push({ ...step, timestamp: new Date().toISOString(), traceId: trace?.id ?? null });
    if (this.#feed.length > Tracer.MAX_FEED) this.#feed = this.#feed.slice(-Tracer.MAX_FEED);
  }

  find(traceId: string): RequestTrace | undefined {
    return this.#traces.get(traceId);
  }

  recentFeed(limit = 60): FeedItem[] {
    return this.#feed.slice(-limit).reverse();
  }

  clear(): void {
    this.#traces.clear();
    this.#feed = [];
  }
}

export const tracer = Tracer.getInstance();
