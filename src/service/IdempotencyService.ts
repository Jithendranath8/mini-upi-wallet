import { setTimeout as sleep } from 'node:timers/promises';
import { IdempotencyKeyReuseError, RequestInProgressError, ValidationError } from '../domain/errors';
import type { Cache } from '../infrastructure/cache/Cache';
import { tracer } from '../infrastructure/observability/Tracer';
import type { IdempotencyRepository } from '../repository/interfaces';

export interface IdempotentOutcome<T> {
  result: T;
  /** True when this is the stored answer of an earlier request, not a new execution. */
  replayed: boolean;
}

interface CachedOutcome {
  requestHash: string;
  result: unknown;
}

export interface IdempotencyOptions {
  pollIntervalMs: number;
  maxPolls: number;
  cacheTtlMs: number;
}

/**
 * Makes an operation safe to retry.
 *
 * The client sends the same Idempotency-Key for every retry of one logical request.
 *
 *   first time         -> claim the key (atomic INSERT), run the operation, store its result
 *   retry, finished    -> return the stored result; the operation does NOT run again
 *   retry, in flight   -> wait for the first request to finish, then return its result
 *   same key, new body -> reject: a key identifies exactly one request
 *
 * The database PRIMARY KEY on (user, key) is the arbiter, so this holds across app nodes.
 * The cache is only a fast path in front of it.
 */
export class IdempotencyService {
  #executed = 0;
  #replayed = 0;
  #waited = 0;
  #keyReuseRejected = 0;

  constructor(
    private readonly keys: IdempotencyRepository,
    private readonly cache: Cache,
    private readonly options: IdempotencyOptions,
  ) {}

  async execute<T>(
    userId: string,
    key: string,
    requestHash: string,
    operation: () => Promise<T>,
  ): Promise<IdempotentOutcome<T>> {
    IdempotencyService.assertValidKey(key);
    const cacheKey = `idem:${userId}:${key}`;

    // Fast path: finished requests are answered from the cache.
    const cached = this.cache.get<CachedOutcome>(cacheKey);
    if (cached) {
      this.assertSameRequest(key, cached.requestHash, requestHash);
      this.#replayed += 1;
      tracer.step('Idempotency', `Key ${shorten(key)} already completed: replaying the stored response (cache)`, 'warn');
      return { result: cached.result as T, replayed: true };
    }

    // The atomic claim. Exactly one concurrent request can win this INSERT.
    if (!this.keys.tryBegin(userId, key, requestHash, new Date())) {
      return this.waitForOriginal<T>(userId, key, requestHash, operation);
    }
    tracer.step('Idempotency', `Key ${shorten(key)} is new: claimed, executing the request`, 'ok');

    let result: T;
    try {
      result = await operation();
    } catch (error) {
      // Nothing was executed that a retry could duplicate (bad input, unknown receiver, ...):
      // free the key so the client can correct the request and try again.
      this.keys.release(userId, key);
      throw error;
    }

    this.keys.complete(userId, key, JSON.stringify(result), new Date());
    this.cache.set<CachedOutcome>(cacheKey, { requestHash, result }, this.options.cacheTtlMs);
    this.#executed += 1;
    return { result, replayed: false };
  }

  stats(): { executed: number; replayed: number; waitedForInFlight: number; keyReuseRejected: number } {
    return {
      executed: this.#executed,
      replayed: this.#replayed,
      waitedForInFlight: this.#waited,
      keyReuseRejected: this.#keyReuseRejected,
    };
  }

  private async waitForOriginal<T>(
    userId: string,
    key: string,
    requestHash: string,
    operation: () => Promise<T>,
  ): Promise<IdempotentOutcome<T>> {
    let announced = false;
    for (let poll = 0; poll < this.options.maxPolls; poll += 1) {
      const record = this.keys.find(userId, key);
      if (!record) {
        // The original failed before doing anything and released the key. Start over.
        return this.execute(userId, key, requestHash, operation);
      }
      this.assertSameRequest(key, record.requestHash, requestHash);
      if (record.status === 'COMPLETED') {
        this.#replayed += 1;
        tracer.step('Idempotency', `Key ${shorten(key)}: original finished, replaying its stored response`, 'warn');
        return { result: JSON.parse(record.responseBody ?? 'null') as T, replayed: true };
      }
      if (!announced) {
        announced = true;
        this.#waited += 1;
        tracer.step('Idempotency', `Key ${shorten(key)} is in flight on another request: waiting for it`, 'warn');
      }
      await sleep(this.options.pollIntervalMs);
    }
    throw new RequestInProgressError(key);
  }

  private assertSameRequest(key: string, storedHash: string, incomingHash: string): void {
    if (storedHash === incomingHash) return;
    this.#keyReuseRejected += 1;
    tracer.step('Idempotency', `Key ${shorten(key)} was reused with a different body: rejected`, 'error');
    throw new IdempotencyKeyReuseError(key);
  }

  private static assertValidKey(key: string): void {
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 128) {
      throw new ValidationError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header (8-128 characters, e.g. a UUID) with every payment request.',
      );
    }
  }
}

function shorten(key: string): string {
  return key.length > 13 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key;
}
