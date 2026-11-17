import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import {
  CircuitOpenError,
  GatewayUnavailableError,
  LockTimeoutError,
  NotFoundError,
  PaymentDeclinedError,
  ServiceUnavailableError,
  ValidationError,
} from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import { InMemoryCache } from '../src/infrastructure/cache/Cache';
import { ChaosController, type ChaosPatch } from '../src/infrastructure/chaos/ChaosController';
import { LoadBalancer, RoundRobinStrategy } from '../src/infrastructure/loadbalancer/LoadBalancer';
import { InMemoryLockManager } from '../src/infrastructure/lock/LockManager';
import { TokenBucketRateLimiter } from '../src/infrastructure/ratelimit/RateLimiter';
import { CircuitBreaker } from '../src/infrastructure/resilience/CircuitBreaker';
import { CircuitBreakerGateway, SimulatedGateway } from '../src/payment/gateway/PaymentGateway';
import { sleep } from './helpers';

/** Freezes Date.now() so TTLs, refills and cool-downs can be advanced exactly. */
function freezeClock(t: TestContext): (ms: number) => void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_750_000_000_000 });
  return (ms) => t.mock.timers.tick(ms);
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------
describe('InMemoryCache', () => {
  test('returns what was stored and undefined for an unknown key', () => {
    const cache = new InMemoryCache(1_000, 10);
    cache.set('a', { n: 1, tags: ['x'] });
    assert.deepEqual(cache.get('a'), { n: 1, tags: ['x'] });
    assert.equal(cache.get('missing'), undefined);
  });

  test('stores a serialised copy: mutating the original or the result does not change the cache', () => {
    const cache = new InMemoryCache(1_000, 10);
    const original = { balance: 100 };
    cache.set('wallet', original);
    original.balance = 999;
    const first = cache.get<{ balance: number }>('wallet')!;
    assert.equal(first.balance, 100);
    first.balance = 5;
    assert.equal(cache.get<{ balance: number }>('wallet')!.balance, 100);
  });

  test('an entry expires after its TTL', (t) => {
    const advance = freezeClock(t);
    const cache = new InMemoryCache(1_000, 10);
    cache.set('a', 'value', 50);
    advance(49);
    assert.equal(cache.get('a'), 'value');
    advance(1);
    assert.equal(cache.get('a'), undefined, 'expired exactly at the TTL');
    assert.equal(cache.stats().size, 0, 'the expired entry is dropped on lookup');
  });

  test('the default TTL applies when none is given', (t) => {
    const advance = freezeClock(t);
    const cache = new InMemoryCache(200, 10);
    cache.set('a', 1);
    advance(199);
    assert.equal(cache.get('a'), 1);
    advance(1);
    assert.equal(cache.get('a'), undefined);
  });

  test('reading an entry does not extend its lifetime, rewriting it does', (t) => {
    const advance = freezeClock(t);
    const cache = new InMemoryCache(100, 10);
    cache.set('read', 1);
    cache.set('rewritten', 1);
    advance(60);
    assert.equal(cache.get('read'), 1);
    cache.set('rewritten', 2);
    advance(60);
    assert.equal(cache.get('read'), undefined);
    assert.equal(cache.get('rewritten'), 2);
  });

  test('evicts the least recently used entry when full', () => {
    const cache = new InMemoryCache(1_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.get('a'), 1); // 'a' is now the most recently used
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined, 'b was the least recently used');
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('c'), 3);
    assert.equal(cache.stats().evictions, 1);
    assert.equal(cache.stats().size, 2);
  });

  test('without any reads, eviction follows insertion order', () => {
    const cache = new InMemoryCache(1_000, 3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) cache.set(key, key);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), undefined);
    assert.deepEqual([cache.get('c'), cache.get('d'), cache.get('e')], ['c', 'd', 'e']);
    assert.equal(cache.stats().evictions, 2);
  });

  test('overwriting a key does not evict and counts as most recent', () => {
    const cache = new InMemoryCache(1_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    assert.equal(cache.stats().evictions, 0);
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 10);
  });

  test('never grows beyond its capacity, even with 10,000 writes', () => {
    const cache = new InMemoryCache(1_000, 100);
    for (let i = 0; i < 10_000; i += 1) cache.set(`key-${i}`, i);
    assert.equal(cache.stats().size, 100);
    assert.equal(cache.stats().evictions, 9_900);
    assert.equal(cache.get('key-9999'), 9_999);
    assert.equal(cache.get('key-9899'), undefined);
  });

  test('delete removes an entry and counts as an invalidation only if it existed', () => {
    const cache = new InMemoryCache(1_000, 10);
    cache.set('a', 1);
    cache.delete('a');
    cache.delete('a');
    cache.delete('never-there');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.stats().invalidations, 1);
  });

  test('clear empties the cache', () => {
    const cache = new InMemoryCache(1_000, 10);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.equal(cache.stats().size, 0);
    assert.equal(cache.get('a'), undefined);
  });

  test('stats count hits, misses, sets and the hit ratio', (t) => {
    const advance = freezeClock(t);
    const cache = new InMemoryCache(100, 10);
    assert.deepEqual(cache.stats(), { hits: 0, misses: 0, hitRatio: 0, sets: 0, invalidations: 0, evictions: 0, size: 0 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // hit
    cache.get('a'); // hit
    cache.get('b'); // hit
    cache.get('nope'); // miss
    advance(100);
    cache.get('a'); // miss (expired)
    assert.deepEqual(cache.stats(), { hits: 3, misses: 2, hitRatio: 0.6, sets: 2, invalidations: 0, evictions: 0, size: 1 });
  });

  test('keys with special characters and falsy-looking values are kept apart', () => {
    const cache = new InMemoryCache(1_000, 10);
    cache.set('', 'empty key');
    cache.set('idem:usr_1:key with spaces 🔑', 'emoji');
    cache.set("upi:o'brien@miniupi", { name: "O'Brien" });
    assert.equal(cache.get(''), 'empty key');
    assert.equal(cache.get('idem:usr_1:key with spaces 🔑'), 'emoji');
    assert.deepEqual(cache.get("upi:o'brien@miniupi"), { name: "O'Brien" });
  });
});

// ---------------------------------------------------------------------------------------------
describe('TokenBucketRateLimiter', () => {
  test('allows a burst up to the capacity, then rejects', (t) => {
    freezeClock(t);
    const limiter = new TokenBucketRateLimiter(3, 1);
    assert.deepEqual(limiter.tryConsume('alice'), { allowed: true, remaining: 2, retryAfterMs: 0 });
    assert.deepEqual(limiter.tryConsume('alice'), { allowed: true, remaining: 1, retryAfterMs: 0 });
    assert.deepEqual(limiter.tryConsume('alice'), { allowed: true, remaining: 0, retryAfterMs: 0 });
    assert.deepEqual(limiter.tryConsume('alice'), { allowed: false, remaining: 0, retryAfterMs: 1_000 });
  });

  test('retryAfterMs is the time until one whole token is back', (t) => {
    const advance = freezeClock(t);
    const limiter = new TokenBucketRateLimiter(2, 4); // one token every 250 ms
    limiter.tryConsume('c');
    limiter.tryConsume('c');
    assert.equal(limiter.tryConsume('c').retryAfterMs, 250);
    advance(100);
    const decision = limiter.tryConsume('c');
    assert.equal(decision.allowed, false);
    assert.equal(decision.retryAfterMs, 150);
  });

  test('refills at the configured rate', (t) => {
    const advance = freezeClock(t);
    const limiter = new TokenBucketRateLimiter(2, 4);
    limiter.tryConsume('c');
    limiter.tryConsume('c');
    assert.equal(limiter.tryConsume('c').allowed, false);
    advance(300); // 1.2 tokens
    assert.equal(limiter.tryConsume('c').allowed, true);
    assert.equal(limiter.tryConsume('c').allowed, false);
  });

  test('a long idle period never banks more than the capacity', (t) => {
    const advance = freezeClock(t);
    const limiter = new TokenBucketRateLimiter(2, 10);
    limiter.tryConsume('c');
    limiter.tryConsume('c');
    advance(60_000);
    assert.equal(limiter.tryConsume('c').allowed, true);
    assert.equal(limiter.tryConsume('c').allowed, true);
    assert.equal(limiter.tryConsume('c').allowed, false);
  });

  test('each client has its own bucket', (t) => {
    freezeClock(t);
    const limiter = new TokenBucketRateLimiter(1, 1);
    assert.equal(limiter.tryConsume('alice').allowed, true);
    assert.equal(limiter.tryConsume('alice').allowed, false);
    assert.equal(limiter.tryConsume('bob').allowed, true);
    assert.equal(limiter.tryConsume('').allowed, true, 'an empty client key is still a client');
  });

  test('stats count decisions and clients; reset refills every bucket', (t) => {
    freezeClock(t);
    const limiter = new TokenBucketRateLimiter(1, 2);
    limiter.tryConsume('alice');
    limiter.tryConsume('alice');
    limiter.tryConsume('bob');
    assert.deepEqual(limiter.stats(), { capacity: 1, refillPerSecond: 2, allowed: 2, rejected: 1, trackedClients: 2 });

    limiter.reset();
    assert.equal(limiter.stats().trackedClients, 0);
    assert.equal(limiter.tryConsume('alice').allowed, true);
  });

  test('the number of tracked clients is bounded, so a flood of distinct keys cannot exhaust memory', (t) => {
    freezeClock(t);
    const limiter = new TokenBucketRateLimiter(5, 1);
    const flood = TokenBucketRateLimiter.MAX_TRACKED_CLIENTS + 500;
    for (let i = 0; i < flood; i += 1) limiter.tryConsume(`client-${i}`);
    assert.ok(limiter.stats().trackedClients <= TokenBucketRateLimiter.MAX_TRACKED_CLIENTS);
    assert.equal(limiter.stats().allowed, flood);
  });

  test('idle buckets that have refilled completely are dropped first when the table is full', (t) => {
    const advance = freezeClock(t);
    const limiter = new TokenBucketRateLimiter(2, 1); // full again after 2 s
    for (let i = 0; i < TokenBucketRateLimiter.MAX_TRACKED_CLIENTS; i += 1) limiter.tryConsume(`idle-${i}`);
    advance(1_000);
    limiter.tryConsume('busy');
    limiter.tryConsume('busy');
    assert.equal(limiter.tryConsume('busy').allowed, false);
    advance(1_500); // the idle ones are full again; 'busy' has 1.5 tokens

    limiter.tryConsume('newcomer'); // table over its limit: triggers the clean-up
    assert.ok(limiter.stats().trackedClients <= 2, `expected only the active clients, got ${limiter.stats().trackedClients}`);
    assert.equal(limiter.tryConsume('busy').allowed, true);
    assert.equal(limiter.tryConsume('busy').allowed, false, 'the busy client kept its (partly empty) bucket');
  });

  // EXPOSES A BUG in src/infrastructure/ratelimit/RateLimiter.ts (fails until it is fixed).
  // Not timing dependent: the clock is frozen and moved by hand. tryConsume() computes
  // `elapsedSeconds = (now - lastRefill) / 1000` and adds `elapsedSeconds * refillPerSecond`
  // tokens without clamping at zero, so when Date.now() goes backwards by D seconds every active
  // bucket loses D * refillPerSecond tokens and its client is refused for roughly D seconds.
  test('a wall clock that steps backwards (an NTP correction) does not empty the buckets', (t) => {
    freezeClock(t);
    const limiter = new TokenBucketRateLimiter(5, 10);
    assert.equal(limiter.tryConsume('alice').allowed, true); // 4 tokens left

    t.mock.timers.setTime(Date.now() - 10_000); // the system clock is set back ten seconds

    const decision = limiter.tryConsume('alice');
    assert.equal(decision.allowed, true, 'four tokens were left; time going backwards must not take them away');
    assert.ok(decision.retryAfterMs < 1_000);
  });

  test('refills in real time too', async () => {
    const limiter = new TokenBucketRateLimiter(1, 10); // one token every 100 ms
    assert.equal(limiter.tryConsume('c').allowed, true);
    assert.equal(limiter.tryConsume('c').allowed, false);
    await sleep(120);
    assert.equal(limiter.tryConsume('c').allowed, true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('InMemoryLockManager', () => {
  test('returns the value produced by the work', async () => {
    const locks = new InMemoryLockManager(1_000);
    assert.equal(await locks.withLock('k', async () => 42), 42);
  });

  test('mutual exclusion: only one holder of a key at a time', async () => {
    const locks = new InMemoryLockManager(1_000);
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        locks.withLock('wallet:1', async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await nextTick();
          await nextTick();
          inside -= 1;
        }),
      ),
    );
    assert.equal(maxInside, 1);
    assert.deepEqual(locks.stats(), { acquired: 10, contended: 9, timeouts: 0, heldNow: 0, waitingNow: 0 });
  });

  test('waiters are served in arrival order (FIFO)', async () => {
    const locks = new InMemoryLockManager(1_000);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        locks.withLock('k', async () => {
          // Earlier arrivals deliberately take longer: a fair lock must still serve them first.
          for (let spin = 0; spin < 8 - i; spin += 1) await nextTick();
          order.push(i);
        }),
      ),
    );
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test('different keys do not block each other', async () => {
    const locks = new InMemoryLockManager(1_000);
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => (releaseA = resolve));
    const holder = locks.withLock('wallet:a', () => gate);

    assert.equal(await locks.withLock('wallet:b', async () => 'b ran'), 'b ran');
    assert.equal(locks.stats().contended, 0);
    assert.equal(locks.stats().heldNow, 1);
    releaseA();
    await holder;
  });

  test('stats show who holds and who waits', async () => {
    const locks = new InMemoryLockManager(1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = locks.withLock('k', () => gate);
    const waiterA = locks.withLock('k', async () => 'a');
    const waiterB = locks.withLock('k', async () => 'b');
    await nextTick();
    assert.deepEqual(locks.stats(), { acquired: 1, contended: 2, timeouts: 0, heldNow: 1, waitingNow: 2 });

    release();
    assert.deepEqual(await Promise.all([holder, waiterA, waiterB]), [undefined, 'a', 'b']);
    assert.deepEqual(locks.stats(), { acquired: 3, contended: 2, timeouts: 0, heldNow: 0, waitingNow: 0 });
  });

  test('a waiter that runs out of time gets LockTimeoutError and never runs', async () => {
    const locks = new InMemoryLockManager(1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = locks.withLock('wallet:1', () => gate);

    let ran = false;
    await assert.rejects(
      locks.withLock(
        'wallet:1',
        async () => {
          ran = true;
        },
        15,
      ),
      (error: unknown) => {
        assert.ok(error instanceof LockTimeoutError);
        assert.equal(error.code, 'LOCK_TIMEOUT');
        assert.equal(error.category, 'UNAVAILABLE');
        assert.deepEqual(error.details, { key: 'wallet:1', waitedMs: 15 });
        return true;
      },
    );
    assert.deepEqual(locks.stats(), { acquired: 1, contended: 1, timeouts: 1, heldNow: 1, waitingNow: 0 });

    release();
    await holder;
    await nextTick();
    assert.equal(ran, false, 'the timed-out waiter must not be granted the lock later');
    assert.equal(locks.stats().heldNow, 0);
    assert.equal(await locks.withLock('wallet:1', async () => 'free again'), 'free again');
  });

  test('the default timeout from the constructor applies', async () => {
    const locks = new InMemoryLockManager(10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = locks.withLock('k', () => gate);
    await assert.rejects(locks.withLock('k', async () => undefined), LockTimeoutError);
    release();
    await holder;
  });

  test('a timed-out waiter in the middle of the queue does not break the order behind it', async () => {
    const locks = new InMemoryLockManager(1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const holder = locks.withLock('k', () => gate);
    const first = locks.withLock('k', async () => void order.push('first'));
    const impatient = locks.withLock('k', async () => void order.push('impatient'), 10);
    const last = locks.withLock('k', async () => void order.push('last'));

    await assert.rejects(impatient, LockTimeoutError);
    release();
    await Promise.all([holder, first, last]);
    assert.deepEqual(order, ['first', 'last']);
    assert.equal(locks.stats().heldNow, 0);
  });

  test('releases the lock when the work rejects', async () => {
    const locks = new InMemoryLockManager(1_000);
    await assert.rejects(
      locks.withLock('k', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(locks.stats().heldNow, 0);
    assert.equal(await locks.withLock('k', async () => 'next'), 'next');
  });

  test('releases the lock when the work throws synchronously', async () => {
    const locks = new InMemoryLockManager(1_000);
    await assert.rejects(
      locks.withLock('k', () => {
        throw new Error('sync boom');
      }),
      /sync boom/,
    );
    assert.equal(locks.stats().heldNow, 0);
  });

  test('hands the lock to the next waiter when the holder fails', async () => {
    const locks = new InMemoryLockManager(1_000);
    const failing = locks.withLock('k', async () => {
      await nextTick();
      throw new Error('holder failed');
    });
    const waiting = locks.withLock('k', async () => 'waiter ran');
    await assert.rejects(failing, /holder failed/);
    assert.equal(await waiting, 'waiter ran');
    assert.equal(locks.stats().heldNow, 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('CircuitBreaker', () => {
  const isOutage = (error: unknown) => error instanceof GatewayUnavailableError;
  const outage = () => Promise.reject(new GatewayUnavailableError('Bank network', 'down'));
  const declined = () => Promise.reject(new PaymentDeclinedError('Bank network', 'insufficient funds'));
  const ok = () => Promise.resolve('ok');

  const breakerWith = (threshold = 3, openMs = 1_000) => new CircuitBreaker('Bank network', threshold, openMs, isOutage);

  const failTimes = async (breaker: CircuitBreaker, times: number) => {
    for (let i = 0; i < times; i += 1) await assert.rejects(breaker.execute(outage), GatewayUnavailableError);
  };

  test('starts CLOSED and passes calls and their results through', async () => {
    const breaker = breakerWith();
    assert.equal(await breaker.execute(ok), 'ok');
    assert.deepEqual(breaker.stats(), {
      name: 'Bank network',
      state: 'CLOSED',
      consecutiveFailures: 0,
      failureThreshold: 3,
      timesOpened: 0,
      callsRejected: 0,
      retryInMs: 0,
    });
  });

  test('stays CLOSED below the threshold and passes the original error on', async () => {
    const breaker = breakerWith(3);
    await failTimes(breaker, 2);
    assert.equal(breaker.stats().state, 'CLOSED');
    assert.equal(breaker.stats().consecutiveFailures, 2);
  });

  test('CLOSED -> OPEN once the threshold of consecutive failures is reached', async (t) => {
    freezeClock(t);
    const breaker = breakerWith(3, 1_000);
    await failTimes(breaker, 3);
    const stats = breaker.stats();
    assert.equal(stats.state, 'OPEN');
    assert.equal(stats.timesOpened, 1);
    assert.equal(stats.consecutiveFailures, 3);
    assert.equal(stats.retryInMs, 1_000);
  });

  test('a success in between resets the failure count', async () => {
    const breaker = breakerWith(3);
    await failTimes(breaker, 2);
    await breaker.execute(ok);
    assert.equal(breaker.stats().consecutiveFailures, 0);
    await failTimes(breaker, 2);
    assert.equal(breaker.stats().state, 'CLOSED');
  });

  test('while OPEN it fails fast with CircuitOpenError and never calls the dependency', async (t) => {
    const advance = freezeClock(t);
    const breaker = breakerWith(2, 1_000);
    await failTimes(breaker, 2);
    advance(400);

    let calls = 0;
    const call = () => {
      calls += 1;
      return ok();
    };
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(breaker.execute(call), (error: unknown) => {
        assert.ok(error instanceof CircuitOpenError);
        assert.equal(error.code, 'CIRCUIT_OPEN');
        assert.equal(error.category, 'UNAVAILABLE');
        assert.deepEqual(error.details, { gateway: 'Bank network', retryAfterMs: 600 });
        return true;
      });
    }
    assert.equal(calls, 0);
    assert.equal(breaker.stats().callsRejected, 3);
    assert.equal(breaker.stats().retryInMs, 600);
  });

  test('OPEN -> HALF_OPEN when the cool-down ends, not a millisecond earlier', async (t) => {
    const advance = freezeClock(t);
    const breaker = breakerWith(1, 1_000);
    await failTimes(breaker, 1);
    advance(999);
    assert.equal(breaker.stats().state, 'OPEN');
    advance(1);
    assert.equal(breaker.stats().state, 'HALF_OPEN');
    assert.equal(breaker.stats().retryInMs, 0);
  });

  test('HALF_OPEN: a successful trial call closes the circuit', async (t) => {
    const advance = freezeClock(t);
    const breaker = breakerWith(2, 1_000);
    await failTimes(breaker, 2);
    advance(1_000);

    assert.equal(await breaker.execute(ok), 'ok');
    const stats = breaker.stats();
    assert.equal(stats.state, 'CLOSED');
    assert.equal(stats.consecutiveFailures, 0);
    assert.equal(stats.timesOpened, 1);
    assert.equal(await breaker.execute(ok), 'ok', 'normal traffic flows again');
  });

  test('HALF_OPEN: a failed trial call re-opens the circuit for a full cool-down', async (t) => {
    const advance = freezeClock(t);
    const breaker = breakerWith(2, 1_000);
    await failTimes(breaker, 2);
    advance(1_000);

    await assert.rejects(breaker.execute(outage), GatewayUnavailableError);
    assert.equal(breaker.stats().state, 'OPEN');
    assert.equal(breaker.stats().timesOpened, 2);
    assert.equal(breaker.stats().retryInMs, 1_000);
    await assert.rejects(breaker.execute(ok), CircuitOpenError);

    advance(1_000);
    assert.equal(await breaker.execute(ok), 'ok');
    assert.equal(breaker.stats().state, 'CLOSED');
  });

  test('HALF_OPEN lets exactly one trial call through at a time', async (t) => {
    const advance = freezeClock(t);
    const breaker = breakerWith(1, 1_000);
    await failTimes(breaker, 1);
    advance(1_000);

    let finishTrial!: (value: string) => void;
    let calls = 0;
    const trial = breaker.execute(() => {
      calls += 1;
      return new Promise<string>((resolve) => (finishTrial = resolve));
    });
    await assert.rejects(
      breaker.execute(() => {
        calls += 1;
        return ok();
      }),
      CircuitOpenError,
    );
    assert.equal(calls, 1);

    finishTrial('trial ok');
    assert.equal(await trial, 'trial ok');
    assert.equal(breaker.stats().state, 'CLOSED');
  });

  test('a business "no" from the dependency never trips the breaker', async () => {
    const breaker = breakerWith(2);
    for (let i = 0; i < 10; i += 1) await assert.rejects(breaker.execute(declined), PaymentDeclinedError);
    assert.equal(breaker.stats().state, 'CLOSED');
    assert.equal(breaker.stats().consecutiveFailures, 0);
    assert.equal(breaker.stats().timesOpened, 0);
  });

  test('a business error proves the dependency is up, so it resets the failure count', async () => {
    const breaker = breakerWith(3);
    await failTimes(breaker, 2);
    await assert.rejects(breaker.execute(declined), PaymentDeclinedError);
    assert.equal(breaker.stats().consecutiveFailures, 0);
    await failTimes(breaker, 2);
    assert.equal(breaker.stats().state, 'CLOSED');
  });

  test('a business error on the HALF_OPEN trial call closes the circuit', async (t) => {
    const advance = freezeClock(t);
    const breaker = breakerWith(1, 1_000);
    await failTimes(breaker, 1);
    advance(1_000);
    await assert.rejects(breaker.execute(declined), PaymentDeclinedError);
    assert.equal(breaker.stats().state, 'CLOSED');
  });

  test('a slow call admitted while CLOSED cannot close a circuit that opened in the meantime', async (t) => {
    freezeClock(t);
    const breaker = breakerWith(2, 1_000);
    let finishSlow!: (value: string) => void;
    const slow = breaker.execute(() => new Promise<string>((resolve) => (finishSlow = resolve)));

    await failTimes(breaker, 2);
    assert.equal(breaker.stats().state, 'OPEN');

    finishSlow('late answer');
    assert.equal(await slow, 'late answer', 'the caller still gets its result');
    assert.equal(breaker.stats().state, 'OPEN', 'but a stale success does not close the circuit');
    assert.equal(breaker.stats().consecutiveFailures, 2);
    await assert.rejects(breaker.execute(ok), CircuitOpenError);
  });

  test('a slow call that fails after the circuit was reset does not count against the new state', async () => {
    const breaker = breakerWith(1, 60_000);
    let failSlow!: (error: Error) => void;
    const slow = breaker.execute(() => new Promise<string>((_resolve, reject) => (failSlow = reject)));

    await failTimes(breaker, 1); // opens
    breaker.reset(); // closed again by the operator

    failSlow(new GatewayUnavailableError('Bank network', 'timed out long ago'));
    await assert.rejects(slow, GatewayUnavailableError);
    assert.equal(breaker.stats().state, 'CLOSED');
    assert.equal(breaker.stats().consecutiveFailures, 0);
  });

  test('a call still running from before the outage cannot decide the HALF_OPEN trial', async (t) => {
    const advance = freezeClock(t);
    const breaker = breakerWith(1, 1_000);
    let finishOld!: (value: string) => void;
    const old = breaker.execute(() => new Promise<string>((resolve) => (finishOld = resolve)));
    await failTimes(breaker, 1);
    advance(1_000);

    let finishTrial!: (value: string) => void;
    const trial = breaker.execute(() => new Promise<string>((resolve) => (finishTrial = resolve)));
    finishOld('old call');
    await old;
    assert.equal(breaker.stats().state, 'HALF_OPEN', 'only the trial call may close the circuit');
    await assert.rejects(breaker.execute(ok), CircuitOpenError);

    finishTrial('trial');
    await trial;
    assert.equal(breaker.stats().state, 'CLOSED');
  });

  test('reset() closes an open circuit immediately', async () => {
    const breaker = breakerWith(1, 60_000);
    await failTimes(breaker, 1);
    assert.equal(breaker.stats().state, 'OPEN');
    breaker.reset();
    assert.equal(breaker.stats().state, 'CLOSED');
    assert.equal(breaker.stats().consecutiveFailures, 0);
    assert.equal(await breaker.execute(ok), 'ok');
  });
});

// ---------------------------------------------------------------------------------------------
describe('LoadBalancer', () => {
  const served = (balancer: LoadBalancer, requests: number) =>
    Array.from({ length: requests }, () => balancer.route().id);

  test('round robin visits every node in turn', () => {
    const balancer = new LoadBalancer(3, new RoundRobinStrategy());
    assert.deepEqual(served(balancer, 7), [
      'app-node-1',
      'app-node-2',
      'app-node-3',
      'app-node-1',
      'app-node-2',
      'app-node-3',
      'app-node-1',
    ]);
  });

  test('spreads load evenly', () => {
    const balancer = new LoadBalancer(4, new RoundRobinStrategy());
    served(balancer, 400);
    assert.deepEqual(
      balancer.stats().nodes.map((node) => node.served),
      [100, 100, 100, 100],
    );
    assert.equal(balancer.stats().strategy, 'round-robin');
  });

  test('skips an unhealthy node', () => {
    const balancer = new LoadBalancer(3, new RoundRobinStrategy());
    const node = balancer.setHealth('app-node-2', false);
    assert.equal(node.healthy, false);
    const ids = served(balancer, 30);
    assert.equal(ids.includes('app-node-2'), false);
    assert.deepEqual(new Set(ids), new Set(['app-node-1', 'app-node-3']));
    assert.equal(balancer.stats().nodes.find((n) => n.id === 'app-node-2')!.served, 0);
  });

  test('routes to a node again once it is healthy', () => {
    const balancer = new LoadBalancer(2, new RoundRobinStrategy());
    balancer.setHealth('app-node-1', false);
    assert.deepEqual(new Set(served(balancer, 4)), new Set(['app-node-2']));
    balancer.setHealth('app-node-1', true);
    assert.deepEqual(new Set(served(balancer, 4)), new Set(['app-node-1', 'app-node-2']));
  });

  test('with no healthy node it throws 503 NO_HEALTHY_NODES', () => {
    const balancer = new LoadBalancer(2, new RoundRobinStrategy());
    balancer.setHealth('app-node-1', false);
    balancer.setHealth('app-node-2', false);
    assert.throws(
      () => balancer.route(),
      (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableError);
        assert.equal(error.code, 'NO_HEALTHY_NODES');
        assert.equal(error.category, 'UNAVAILABLE');
        return true;
      },
    );
  });

  test('healAll brings every node back', () => {
    const balancer = new LoadBalancer(2, new RoundRobinStrategy());
    balancer.setHealth('app-node-1', false);
    balancer.setHealth('app-node-2', false);
    balancer.healAll();
    assert.deepEqual(
      balancer.stats().nodes.map((node) => node.healthy),
      [true, true],
    );
    assert.doesNotThrow(() => balancer.route());
  });

  test('setHealth on an unknown node is a NotFoundError', () => {
    const balancer = new LoadBalancer(2, new RoundRobinStrategy());
    assert.throws(
      () => balancer.setHealth('app-node-9', false),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.code, 'NODE_NOT_FOUND');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('ChaosController', () => {
  const controller = () => new ChaosController({ gatewayLatencyMs: 25, replicaLagMs: 400 });

  test('starts from the configured defaults with every fault off', () => {
    assert.deepEqual(controller().state, {
      bank: { latencyMs: 25, failureRate: 0, down: false },
      card: { latencyMs: 25, failureRate: 0, down: false },
      replicaLagMs: 400,
      databaseLatencyMs: 0,
      notificationFailureRate: 0,
      failNextCredit: false,
    });
    assert.equal(
      new ChaosController({ gatewayLatencyMs: 0, replicaLagMs: 0, databaseLatencyMs: 7 }).state.databaseLatencyMs,
      7,
    );
  });

  test('update merges a partial patch and leaves everything else alone', () => {
    const chaos = controller();
    const next = chaos.update({ bank: { down: true }, replicaLagMs: 0, databaseLatencyMs: 3 });
    assert.equal(next.databaseLatencyMs, 3);
    assert.deepEqual(next.bank, { latencyMs: 25, failureRate: 0, down: true });
    assert.deepEqual(next.card, { latencyMs: 25, failureRate: 0, down: false });
    assert.equal(next.replicaLagMs, 0);
    assert.deepEqual(chaos.gateway('bank'), next.bank);
    assert.equal(chaos.state, next);
  });

  const invalid: Array<[string, ChaosPatch]> = [
    ['a failure rate above 1', { bank: { failureRate: 1.01 } }],
    ['a negative failure rate', { notificationFailureRate: -0.1 }],
    ['a negative delay', { replicaLagMs: -1 }],
    ['a delay above one minute', { card: { latencyMs: 60_001 } }],
    ['a non-numeric delay', { replicaLagMs: '100' as unknown as number }],
    ['a NaN delay', { bank: { latencyMs: Number.NaN } }],
    ['a negative database latency', { databaseLatencyMs: -1 }],
    ['a database latency above one minute', { databaseLatencyMs: 60_001 }],
    ['a non-boolean flag', { failNextCredit: 'yes' as unknown as boolean }],
    ['a non-boolean outage flag', { bank: { down: 1 as unknown as boolean } }],
  ];
  for (const [label, patch] of invalid) {
    test(`rejects ${label} and keeps the previous state`, () => {
      const chaos = controller();
      const before = chaos.state;
      assert.throws(
        () => chaos.update(patch),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError);
          assert.equal(error.code, 'INVALID_CHAOS_SETTING');
          return true;
        },
      );
      assert.equal(chaos.state, before);
    });
  }

  test('accepts the boundary values', () => {
    const next = controller().update({ bank: { failureRate: 1, latencyMs: 60_000 }, notificationFailureRate: 0, replicaLagMs: 0 });
    assert.equal(next.bank.failureRate, 1);
    assert.equal(next.bank.latencyMs, 60_000);
  });

  test('ignores unknown fields and malformed gateway patches from an untrusted body', () => {
    const chaos = controller();
    const next = chaos.update({ bank: 'down', hacked: true, card: null } as unknown as ChaosPatch);
    assert.deepEqual(next, controller().state);
    assert.equal('hacked' in next, false);
  });

  test('consumeCreditFailure fires exactly once per arming', () => {
    const chaos = controller();
    assert.equal(chaos.consumeCreditFailure(), false);
    chaos.update({ failNextCredit: true });
    assert.equal(chaos.consumeCreditFailure(), true);
    assert.equal(chaos.consumeCreditFailure(), false);
    assert.equal(chaos.state.failNextCredit, false);
  });

  test('reset restores the defaults and listeners hear about every change', () => {
    const chaos = controller();
    const heard: number[] = [];
    chaos.onChange((state) => heard.push(state.replicaLagMs));
    chaos.update({ replicaLagMs: 5 });
    chaos.update({ bank: { down: true } });
    chaos.reset();
    assert.deepEqual(heard, [5, 5, 400]);
    assert.deepEqual(chaos.state, controller().state);
  });
});

// ---------------------------------------------------------------------------------------------
describe('SimulatedGateway', () => {
  const healthy = { latencyMs: 0, failureRate: 0, down: false };
  const gatewayWith = (faults = healthy, openingRupees = 1_000) =>
    new SimulatedGateway('Bank network', () => faults, Money.fromRupees(openingRupees));

  test('a charge takes the money from the linked account and returns a receipt', async () => {
    const gateway = gatewayWith();
    const receipt = await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(300) });
    assert.deepEqual(receipt, { reference: 'txn_1', gatewayTransactionId: 'BANKNETWORK-000001' });
    assert.equal(gateway.balanceOf('src_1').paise, 70_000);
    assert.equal(gateway.balanceOf('src_other').paise, 100_000, 'other accounts start at the opening balance');
  });

  test('charging the same reference again is a no-op that returns the same receipt', async () => {
    const gateway = gatewayWith();
    const request = { reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(300) };
    const first = await gateway.charge(request);
    const second = await gateway.charge(request);
    assert.deepEqual(second, first);
    assert.equal(gateway.balanceOf('src_1').paise, 70_000);
  });

  test('declines a charge larger than the account balance, without taking anything', async () => {
    const gateway = gatewayWith();
    await assert.rejects(
      gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(1_000.01) }),
      (error: unknown) => {
        assert.ok(error instanceof PaymentDeclinedError);
        assert.equal(error.code, 'PAYMENT_DECLINED');
        assert.equal(error.category, 'DECLINED');
        return true;
      },
    );
    assert.equal(gateway.balanceOf('src_1').paise, 100_000);
    await gateway.charge({ reference: 'txn_2', sourceId: 'src_1', amount: Money.fromRupees(1_000) });
    assert.equal(gateway.balanceOf('src_1').paise, 0, 'the exact balance can be charged');
  });

  test('a refund returns the money once, however often it is repeated', async () => {
    const gateway = gatewayWith();
    await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(300) });
    await gateway.refund('txn_1');
    await gateway.refund('txn_1');
    assert.equal(gateway.balanceOf('src_1').paise, 100_000);
  });

  test('two concurrent refunds of one charge pay out once', async () => {
    const gateway = gatewayWith({ ...healthy, latencyMs: 10 });
    await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(300) });
    assert.equal(gateway.balanceOf('src_1').paise, 70_000);
    await Promise.all([gateway.refund('txn_1'), gateway.refund('txn_1'), gateway.refund('txn_1')]);
    assert.equal(gateway.balanceOf('src_1').paise, 100_000, 'refunded once, not three times');
  });

  test('a refund that fails can be retried', async () => {
    const faults = { ...healthy };
    const gateway = gatewayWith(faults);
    await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(300) });
    faults.down = true;
    await assert.rejects(gateway.refund('txn_1'), GatewayUnavailableError);
    faults.down = false;
    await gateway.refund('txn_1');
    assert.equal(gateway.balanceOf('src_1').paise, 100_000);
  });

  test('restore rebuilds the memory of past charges after a restart', async () => {
    const gateway = gatewayWith();
    gateway.restore([
      { reference: 'txn_open', sourceId: 'src_1', amount: Money.fromRupees(300), gatewayTransactionId: 'BANKNETWORK-000009', refunded: false },
      { reference: 'txn_done', sourceId: 'src_1', amount: Money.fromRupees(500), gatewayTransactionId: 'BANKNETWORK-000010', refunded: true },
    ]);
    assert.equal(gateway.balanceOf('src_1').paise, 70_000, 'only the charge that was not refunded is still taken');

    const again = await gateway.charge({ reference: 'txn_open', sourceId: 'src_1', amount: Money.fromRupees(300) });
    assert.equal(again.gatewayTransactionId, 'BANKNETWORK-000009', 'a restored charge is recognised, not charged again');
    assert.equal(gateway.balanceOf('src_1').paise, 70_000);

    await gateway.refund('txn_done'); // already refunded: no-op
    await gateway.refund('txn_open');
    assert.equal(gateway.balanceOf('src_1').paise, 100_000);

    gateway.restore([
      { reference: 'txn_open', sourceId: 'src_1', amount: Money.fromRupees(300), gatewayTransactionId: 'X', refunded: false },
    ]);
    assert.equal(gateway.balanceOf('src_1').paise, 100_000, 'restoring a charge the gateway already knows changes nothing');
  });

  test('refunding an unknown reference is a NotFoundError', async () => {
    await assert.rejects(gatewayWith().refund('txn_unknown'), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, 'CHARGE_NOT_FOUND');
      return true;
    });
  });

  test('when the network is down every call fails with GatewayUnavailableError and no money moves', async () => {
    const faults = { ...healthy };
    const gateway = gatewayWith(faults);
    await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(100) });

    faults.down = true;
    await assert.rejects(
      gateway.charge({ reference: 'txn_2', sourceId: 'src_1', amount: Money.fromRupees(100) }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayUnavailableError);
        assert.equal(error.code, 'GATEWAY_UNAVAILABLE');
        assert.equal(error.category, 'UNAVAILABLE');
        return true;
      },
    );
    await assert.rejects(gateway.refund('txn_1'), GatewayUnavailableError);
    assert.equal(gateway.balanceOf('src_1').paise, 90_000);
  });

  test('a failure rate of 1 fails every call; reset forgets balances and charges', async () => {
    const faults = { ...healthy, failureRate: 1 };
    const gateway = gatewayWith(faults);
    await assert.rejects(
      gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(100) }),
      GatewayUnavailableError,
    );
    faults.failureRate = 0;
    await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(100) });
    gateway.reset();
    assert.equal(gateway.balanceOf('src_1').paise, 100_000);
    await assert.rejects(gateway.refund('txn_1'), NotFoundError);
  });

  test('simulated latency is observed before the gateway answers', async () => {
    const gateway = gatewayWith({ ...healthy, latencyMs: 30 });
    const started = Date.now();
    await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(1) });
    assert.ok(Date.now() - started >= 28, 'the charge waited for the simulated network');
  });
});

describe('CircuitBreakerGateway', () => {
  const isOutage = (error: unknown) => error instanceof GatewayUnavailableError;

  test('decorates a gateway: same name, same results, breaker stats exposed', async () => {
    const inner = new SimulatedGateway('Card network', () => ({ latencyMs: 0, failureRate: 0, down: false }), Money.fromRupees(500));
    const gateway = new CircuitBreakerGateway(inner, new CircuitBreaker('Card network', 2, 60_000, isOutage));
    assert.equal(gateway.name, 'Card network');
    const receipt = await gateway.charge({ reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(200) });
    assert.equal(receipt.gatewayTransactionId, 'CARDNETWORK-000001');
    await gateway.refund('txn_1');
    assert.equal(inner.balanceOf('src_1').paise, 50_000);
    assert.equal(gateway.breakerStats().state, 'CLOSED');
  });

  test('outages open the circuit; declines do not; resetBreaker closes it', async () => {
    const faults = { latencyMs: 0, failureRate: 0, down: false };
    const inner = new SimulatedGateway('Bank network', () => faults, Money.fromRupees(100));
    const gateway = new CircuitBreakerGateway(inner, new CircuitBreaker('Bank network', 2, 60_000, isOutage));
    const charge = (reference: string, rupees: number) =>
      gateway.charge({ reference, sourceId: 'src_1', amount: Money.fromRupees(rupees) });

    for (let i = 0; i < 5; i += 1) await assert.rejects(charge(`declined_${i}`, 101), PaymentDeclinedError);
    assert.equal(gateway.breakerStats().state, 'CLOSED');

    faults.down = true;
    await assert.rejects(charge('txn_1', 10), GatewayUnavailableError);
    await assert.rejects(charge('txn_2', 10), GatewayUnavailableError);
    assert.equal(gateway.breakerStats().state, 'OPEN');

    faults.down = false;
    await assert.rejects(charge('txn_3', 10), CircuitOpenError);
    assert.equal(inner.balanceOf('src_1').paise, 10_000, 'the open circuit kept the call away from the gateway');

    gateway.resetBreaker();
    await charge('txn_4', 10);
    assert.equal(inner.balanceOf('src_1').paise, 9_000);
  });
});
