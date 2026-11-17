import { randomUUID } from 'node:crypto';
import { RequestTrace, tracer } from '../observability/Tracer';

export interface QueueMessage<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  /** 1 on first delivery, incremented on every retry. */
  attempt: number;
  enqueuedAt: number;
  trace: RequestTrace | undefined;
}

export interface DeadLetter<T = unknown> {
  message: QueueMessage<T>;
  error: string;
  failedAt: string;
}

export interface TopicStats {
  depth: number;
  inFlight: number;
  scheduledRetries: number;
  published: number;
  processed: number;
  retried: number;
  deadLettered: number;
}

export interface SubscribeOptions<T> {
  concurrency?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  /** Called once when a message has exhausted its attempts and moves to the dead-letter queue. */
  onDeadLetter?: (message: QueueMessage<T>, error: Error) => void;
}

export type MessageHandler<T> = (message: QueueMessage<T>) => Promise<void>;

/**
 * Port for an asynchronous message queue (Kafka / RabbitMQ / SQS in production).
 * Delivery is at-least-once: a handler may see the same message more than once, so
 * consumers must be idempotent.
 */
export interface MessageQueue {
  publish<T>(topic: string, payload: T): string;
  subscribe<T>(topic: string, handler: MessageHandler<T>, options?: SubscribeOptions<T>): void;
  stats(): Record<string, TopicStats>;
  deadLetters(topic: string): DeadLetter[];
  /** Moves dead letters back onto the topic for another round of attempts. */
  redrive(topic: string): number;
  /** Resolves when nothing is queued, in flight or waiting for a retry. */
  drain(): Promise<void>;
  clear(): void;
}

interface Topic {
  pending: QueueMessage[];
  inFlight: number;
  scheduledRetries: number;
  dead: DeadLetter[];
  handler?: MessageHandler<unknown>;
  options: Required<Omit<SubscribeOptions<unknown>, 'onDeadLetter'>> & Pick<SubscribeOptions<unknown>, 'onDeadLetter'>;
  published: number;
  processed: number;
  retried: number;
  deadLettered: number;
}

export class InMemoryMessageQueue implements MessageQueue {
  readonly #topics = new Map<string, Topic>();
  #generation = 0;
  #idleWaiters: Array<() => void> = [];

  constructor(
    private readonly defaults: { concurrency: number; maxAttempts: number; backoffBaseMs: number },
  ) {}

  publish<T>(topic: string, payload: T): string {
    const t = this.topic(topic);
    const message: QueueMessage<T> = {
      id: randomUUID(),
      topic,
      payload,
      attempt: 1,
      enqueuedAt: Date.now(),
      trace: tracer.current(),
    };
    t.pending.push(message);
    t.published += 1;
    this.dispatch(t);
    return message.id;
  }

  subscribe<T>(topic: string, handler: MessageHandler<T>, options: SubscribeOptions<T> = {}): void {
    const t = this.topic(topic);
    t.handler = handler as MessageHandler<unknown>;
    t.options = {
      concurrency: options.concurrency ?? this.defaults.concurrency,
      maxAttempts: options.maxAttempts ?? this.defaults.maxAttempts,
      backoffBaseMs: options.backoffBaseMs ?? this.defaults.backoffBaseMs,
      onDeadLetter: options.onDeadLetter as Topic['options']['onDeadLetter'],
    };
    this.dispatch(t);
  }

  stats(): Record<string, TopicStats> {
    const result: Record<string, TopicStats> = {};
    for (const [name, t] of this.#topics) {
      result[name] = {
        depth: t.pending.length,
        inFlight: t.inFlight,
        scheduledRetries: t.scheduledRetries,
        published: t.published,
        processed: t.processed,
        retried: t.retried,
        deadLettered: t.dead.length,
      };
    }
    return result;
  }

  deadLetters(topic: string): DeadLetter[] {
    return [...this.topic(topic).dead];
  }

  redrive(topic: string): number {
    const t = this.topic(topic);
    const dead = t.dead;
    t.dead = [];
    for (const { message } of dead) {
      t.pending.push({ ...message, attempt: 1, enqueuedAt: Date.now() });
    }
    this.dispatch(t);
    return dead.length;
  }

  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  clear(): void {
    // Bumping the generation makes in-flight handlers and pending retry timers no-ops.
    this.#generation += 1;
    for (const t of this.#topics.values()) {
      t.pending = [];
      t.dead = [];
      t.inFlight = 0;
      t.scheduledRetries = 0;
    }
    this.notifyIfIdle();
  }

  private topic(name: string): Topic {
    let t = this.#topics.get(name);
    if (!t) {
      t = {
        pending: [],
        inFlight: 0,
        scheduledRetries: 0,
        dead: [],
        options: { ...this.defaults, onDeadLetter: undefined },
        published: 0,
        processed: 0,
        retried: 0,
        deadLettered: 0,
      };
      this.#topics.set(name, t);
    }
    return t;
  }

  private dispatch(t: Topic): void {
    while (t.handler && t.inFlight < t.options.concurrency && t.pending.length > 0) {
      const message = t.pending.shift()!;
      t.inFlight += 1;
      // Hand off to a worker on the next tick: publishing never waits for consumers.
      const generation = this.#generation;
      setImmediate(() => {
        tracer
          .continueWith(message.trace, () => this.deliver(t, message, generation))
          .catch((error) => console.error(`[queue:${message.topic}] delivery bookkeeping failed`, error));
      });
    }
  }

  private async deliver(t: Topic, message: QueueMessage, generation: number): Promise<void> {
    if (generation !== this.#generation) return; // cleared before a worker picked it up
    let failure: Error | undefined;
    try {
      await t.handler!(message);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (generation !== this.#generation) return; // the queue was cleared while we were working

    t.inFlight -= 1;
    if (!failure) {
      t.processed += 1;
    } else if (message.attempt < t.options.maxAttempts) {
      this.scheduleRetry(t, message, failure, generation);
    } else {
      t.dead.push({ message, error: failure.message, failedAt: new Date().toISOString() });
      t.deadLettered += 1;
      tracer.step(
        'Queue',
        `${message.topic}: gave up after ${message.attempt} attempts, moved to dead-letter queue (${failure.message})`,
        'error',
        message.trace,
      );
      try {
        t.options.onDeadLetter?.(message, failure);
      } catch (error) {
        console.error(`[queue:${message.topic}] dead-letter callback failed`, error);
      }
    }
    this.dispatch(t);
    this.notifyIfIdle();
  }

  private scheduleRetry(t: Topic, message: QueueMessage, failure: Error, generation: number): void {
    // Exponential backoff: base, 2x base, 4x base, ...
    const delay = t.options.backoffBaseMs * 2 ** (message.attempt - 1);
    t.retried += 1;
    t.scheduledRetries += 1;
    tracer.step(
      'Queue',
      `${message.topic}: attempt ${message.attempt} failed (${failure.message}), retrying in ${delay} ms`,
      'warn',
      message.trace,
    );
    const timer = setTimeout(() => {
      if (generation !== this.#generation) return;
      t.scheduledRetries -= 1;
      t.pending.push({ ...message, attempt: message.attempt + 1 });
      this.dispatch(t);
    }, delay);
    timer.unref();
  }

  private isIdle(): boolean {
    for (const t of this.#topics.values()) {
      if (t.pending.length > 0 || t.inFlight > 0 || t.scheduledRetries > 0) return false;
    }
    return true;
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}
