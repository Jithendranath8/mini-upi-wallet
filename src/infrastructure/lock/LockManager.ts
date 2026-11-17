import { LockTimeoutError } from '../../domain/errors';
import { tracer } from '../observability/Tracer';

export interface LockStats {
  acquired: number;
  contended: number;
  timeouts: number;
  heldNow: number;
  waitingNow: number;
}

/**
 * Port for mutual exclusion on a named resource. In production this is a distributed lock
 * (Redis `SET key NX PX`, or a row lock via SELECT ... FOR UPDATE) so it holds across app nodes.
 */
export interface LockManager {
  /** Runs `work` while holding the lock on `key`; always releases, even if `work` throws. */
  withLock<T>(key: string, work: () => Promise<T>, timeoutMs?: number): Promise<T>;
  stats(): LockStats;
}

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

/** Fair (FIFO) in-process lock: waiters are served in arrival order. */
export class InMemoryLockManager implements LockManager {
  readonly #held = new Set<string>();
  readonly #waiters = new Map<string, Waiter[]>();
  #acquired = 0;
  #contended = 0;
  #timeouts = 0;

  constructor(private readonly defaultTimeoutMs: number) {}

  async withLock<T>(key: string, work: () => Promise<T>, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    await this.acquire(key, timeoutMs);
    try {
      return await work();
    } finally {
      this.release(key);
    }
  }

  stats(): LockStats {
    let waitingNow = 0;
    for (const queue of this.#waiters.values()) waitingNow += queue.length;
    return {
      acquired: this.#acquired,
      contended: this.#contended,
      timeouts: this.#timeouts,
      heldNow: this.#held.size,
      waitingNow,
    };
  }

  private acquire(key: string, timeoutMs: number): Promise<void> {
    if (!this.#held.has(key)) {
      this.#held.add(key);
      this.#acquired += 1;
      tracer.step('Lock', `Acquired ${key} immediately`, 'ok');
      return Promise.resolve();
    }

    this.#contended += 1;
    const startedWaiting = Date.now();
    // grant() runs in the releasing request's context, so pin the waiter's own trace here.
    const trace = tracer.current();
    tracer.step('Lock', `${key} is held by another payment, waiting in line`, 'warn', trace);

    return new Promise<void>((resolve, reject) => {
      const queue = this.#waiters.get(key) ?? [];
      this.#waiters.set(key, queue);
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          this.#acquired += 1;
          tracer.step('Lock', `Acquired ${key} after waiting ${Date.now() - startedWaiting} ms`, 'ok', trace);
          resolve();
        },
        timer: setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          this.#timeouts += 1;
          tracer.step('Lock', `Gave up waiting for ${key} after ${timeoutMs} ms`, 'error', trace);
          reject(new LockTimeoutError(key, timeoutMs));
        }, timeoutMs),
      };
      queue.push(waiter);
    });
  }

  private release(key: string): void {
    const next = this.#waiters.get(key)?.shift();
    if (next) {
      // Ownership passes straight to the next waiter; the key never becomes free in between.
      next.grant();
    } else {
      this.#held.delete(key);
      this.#waiters.delete(key);
    }
  }
}
