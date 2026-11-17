import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import {
  DomainError,
  IdempotencyKeyReuseError,
  NotFoundError,
  RequestInProgressError,
  ValidationError,
} from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import {
  balanceOf,
  closeApp,
  createTestApp,
  fund,
  ledgerOf,
  linkBank,
  notificationsFor,
  pay,
  primaryOf,
  registerUser,
  sleep,
  timelineOf,
  uniqueKey,
  verifyLedger,
  writerOf,
} from './helpers';

const transactionsOf = (app: Application, senderId: string): number =>
  primaryOf(app).get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ?', senderId)!.n;

describe('idempotent transfers', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  test('a sequential retry returns the same transaction, marked as replayed, and debits once', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const key = uniqueKey('retry');

    const first = await pay(app, alice, bob, 300, { key, note: 'rent' });
    const second = await pay(app, alice, bob, 300, { key, note: 'rent' });
    const third = await pay(app, alice, bob, 300, { key, note: 'rent' });

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(third.replayed, true);
    assert.deepEqual(second.result, first.result);
    assert.deepEqual(third.result, first.result);

    assert.equal(balanceOf(app, alice), 70_000, 'debited exactly once');
    assert.equal(balanceOf(app, bob), 30_000, 'credited exactly once');
    assert.equal(transactionsOf(app, alice.id), 2, 'the top-up and one payment');
    assert.equal(ledgerOf(app, first.result.transaction.id).length, 2);
    assert.deepEqual(timelineOf(app, first.result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'SUCCESS']);
  });

  test('a retry does not notify anyone a second time', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const key = uniqueKey('notify');
    const { result } = await pay(app, alice, bob, 10, { key });
    await pay(app, alice, bob, 10, { key });
    await app.settle();
    assert.equal(notificationsFor(app, bob, result.transaction.id).length, 2, 'one per channel (SMS, PUSH)');
  });

  test('a retry storm of 8 identical concurrent requests produces one debit and one transaction id', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const key = uniqueKey('storm');

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => pay(app, alice, bob, 300, { key })));

    const ids = new Set(outcomes.map((outcome) => outcome.result.transaction.id));
    assert.equal(ids.size, 1, 'every caller got the same transaction');
    assert.equal(outcomes.filter((outcome) => !outcome.replayed).length, 1, 'exactly one request executed');
    assert.equal(outcomes.filter((outcome) => outcome.replayed).length, 7);
    for (const outcome of outcomes) {
      assert.equal(outcome.result.error, undefined);
      assert.equal(outcome.result.transaction.status, 'SUCCESS');
      assert.deepEqual(outcome.result, outcomes[0].result);
    }
    assert.equal(balanceOf(app, alice), 70_000);
    assert.equal(balanceOf(app, bob), 30_000);
    assert.equal(transactionsOf(app, alice.id), 2);
    assert.equal(verifyLedger(app).healthy, true);
  });

  test('the same key with a different body is rejected and moves no money', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const carol = registerUser(app);
    await fund(app, alice, 1_000);
    const key = uniqueKey('reuse');
    await pay(app, alice, bob, 100, { key, note: 'original' });

    const reuse = (error: unknown) => {
      assert.ok(error instanceof IdempotencyKeyReuseError);
      assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(error.category, 'RULE_VIOLATION');
      assert.deepEqual(error.details, { key });
      return true;
    };
    await assert.rejects(pay(app, alice, bob, 101, { key, note: 'original' }), reuse, 'different amount');
    await assert.rejects(pay(app, alice, carol, 100, { key, note: 'original' }), reuse, 'different receiver');
    await assert.rejects(pay(app, alice, bob, 100, { key, note: 'changed' }), reuse, 'different note');
    const bank = linkBank(app, alice);
    await assert.rejects(pay(app, alice, bob, 100, { key, note: 'original', sourceId: bank.id }), reuse, 'different source');

    assert.equal(balanceOf(app, alice), 90_000);
    assert.equal(balanceOf(app, bob), 10_000);
    assert.equal(balanceOf(app, carol), 0);
  });

  test('cosmetic differences (UPI ID case, surrounding spaces) are the same request', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const key = uniqueKey('cosmetic');
    const first = await pay(app, alice, bob.upiId, 100, { key, note: 'tea' });
    const second = await pay(app, alice, `  ${bob.upiId.toUpperCase()} `, 100, { key, note: '  tea  ' });
    assert.equal(second.replayed, true);
    assert.equal(second.result.transaction.id, first.result.transaction.id);
    assert.equal(balanceOf(app, bob), 10_000);
  });

  test('a request that fails before anything is recorded releases its key for reuse', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const key = uniqueKey('released');

    await assert.rejects(pay(app, alice, 'typo@miniupi', 50, { key }), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, 'RECEIVER_NOT_FOUND');
      return true;
    });

    // Same key, corrected receiver: a different body, but the key was never consumed.
    const corrected = await pay(app, alice, bob, 50, { key });
    assert.equal(corrected.replayed, false);
    assert.equal(corrected.result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, bob), 5_000);

    // From now on the key is bound to the corrected request.
    const again = await pay(app, alice, bob, 50, { key });
    assert.equal(again.replayed, true);
    assert.equal(balanceOf(app, bob), 5_000);
  });

  test('a failed payment is replayed as the same failure, not attempted again', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const key = uniqueKey('failed');

    const first = await pay(app, alice, bob, 500, { key });
    assert.equal(first.result.error?.code, 'INSUFFICIENT_BALANCE');
    assert.equal(first.result.transaction.status, 'FAILED');

    // Even though the payment could succeed now, the key answers with the recorded outcome.
    await fund(app, alice, 1_000);
    const second = await pay(app, alice, bob, 500, { key });
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(balanceOf(app, bob), 0);
    assert.equal(transactionsOf(app, alice.id), 3, 'two top-ups and one failed payment');
  });

  test('the same key used by two different users identifies two different requests', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const carol = registerUser(app);
    await fund(app, alice, 100);
    await fund(app, bob, 100);
    const key = uniqueKey('shared');

    const fromAlice = await pay(app, alice, carol, 10, { key });
    const fromBob = await pay(app, bob, carol, 10, { key });
    assert.equal(fromAlice.replayed, false);
    assert.equal(fromBob.replayed, false);
    assert.notEqual(fromAlice.result.transaction.id, fromBob.result.transaction.id);
    assert.equal(balanceOf(app, carol), 2_000);
  });

  test('different keys are different payments, even with identical bodies', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const first = await pay(app, alice, bob, 10, { note: 'same' });
    const second = await pay(app, alice, bob, 10, { note: 'same' });
    assert.notEqual(first.result.transaction.id, second.result.transaction.id);
    assert.equal(balanceOf(app, bob), 2_000);
  });

  const invalidKeys: Array<[string, string]> = [
    ['missing (empty)', ''],
    ['shorter than 8 characters', 'short'],
    ['exactly 7 characters', '1234567'],
    ['8 characters of whitespace', '        '],
    ['longer than 128 characters', 'k'.repeat(129)],
  ];
  for (const [label, key] of invalidKeys) {
    test(`a key that is ${label} is a validation error`, async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 100);
      await assert.rejects(pay(app, alice, bob, 10, { key }), (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'IDEMPOTENCY_KEY_REQUIRED');
        assert.equal(error.category, 'INVALID_INPUT');
        return true;
      });
      assert.equal(balanceOf(app, bob), 0);
    });
  }

  test('a key that is not a string at all is a validation error', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    for (const key of [undefined, null, 12345678, { key: 'object-key' }]) {
      const attempt = app.transfers.transfer({
        idempotencyKey: key as unknown as string,
        senderId: alice.id,
        receiverUpiId: bob.upiId,
        amount: Money.fromRupees(10),
      });
      await assert.rejects(attempt, (error: unknown) => {
        assert.ok(error instanceof DomainError, `expected a DomainError for key ${String(key)}, got ${String(error)}`);
        assert.equal(error.code, 'IDEMPOTENCY_KEY_REQUIRED');
        return true;
      });
    }
    assert.equal(balanceOf(app, bob), 0);
  });

  test('keys at the length boundaries (8 and 128 characters) are accepted', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const shortest = await pay(app, alice, bob, 1, { key: `k${Date.now()}`.slice(0, 8).padEnd(8, 'x') });
    const longest = await pay(app, alice, bob, 1, { key: uniqueKey('long').padEnd(128, 'x') });
    assert.equal(shortest.result.transaction.status, 'SUCCESS');
    assert.equal(longest.result.transaction.status, 'SUCCESS');
  });

  test('the operator snapshot counts executions, replays and rejected key reuse', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const before = app.system.snapshot().idempotency;
    const key = uniqueKey('stats');
    await pay(app, alice, bob, 10, { key });
    await pay(app, alice, bob, 10, { key });
    await assert.rejects(pay(app, alice, bob, 11, { key }), IdempotencyKeyReuseError);
    const stats = app.system.snapshot().idempotency;
    assert.equal(stats.executed - before.executed, 1);
    assert.equal(stats.replayed - before.replayed, 1);
    assert.equal(stats.keyReuseRejected - before.keyReuseRejected, 1);
  });
});

describe('idempotency while the original request is still in flight', () => {
  test('a storm of identical bank top-ups waits for the first one and credits the wallet once', async () => {
    const app = await createTestApp({ gatewayLatencyMs: 30 });
    try {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      const key = uniqueKey('topup-storm');
      const before = app.system.snapshot().idempotency.waitedForInFlight;

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => pay(app, alice, alice, 500, { key, sourceId: bank.id })),
      );

      assert.equal(new Set(outcomes.map((o) => o.result.transaction.id)).size, 1);
      assert.equal(outcomes.filter((o) => !o.replayed).length, 1);
      for (const outcome of outcomes) assert.equal(outcome.result.transaction.status, 'SUCCESS');
      assert.equal(balanceOf(app, alice), 50_000, 'credited once, not eight times');
      assert.equal(transactionsOf(app, alice.id), 1);
      assert.equal(app.system.snapshot().idempotency.waitedForInFlight - before, 7, 'the other seven waited in line');
      assert.equal(verifyLedger(app).healthy, true);
    } finally {
      await closeApp(app);
    }
  });

  test('a retry with a different body is rejected even while the original is in flight', async () => {
    const app = await createTestApp({ gatewayLatencyMs: 40 });
    try {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      const key = uniqueKey('inflight-reuse');

      const original = pay(app, alice, alice, 500, { key, sourceId: bank.id });
      await assert.rejects(pay(app, alice, alice, 999, { key, sourceId: bank.id }), IdempotencyKeyReuseError);
      assert.equal((await original).result.transaction.status, 'SUCCESS');
      assert.equal(balanceOf(app, alice), 50_000);
    } finally {
      await closeApp(app);
    }
  });

  test('a retry gives up with RequestInProgressError when the original takes too long, and never runs twice', async () => {
    // One poll of 1 ms: the retry's timer is always due long before the original's 120 ms bank call.
    const app = await createTestApp({ gatewayLatencyMs: 120, idempotencyMaxPolls: 1, idempotencyPollIntervalMs: 1 });
    try {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      const key = uniqueKey('slow');

      const original = pay(app, alice, alice, 500, { key, sourceId: bank.id });
      await assert.rejects(pay(app, alice, alice, 500, { key, sourceId: bank.id }), (error: unknown) => {
        assert.ok(error instanceof RequestInProgressError);
        assert.equal(error.code, 'REQUEST_IN_PROGRESS');
        assert.equal(error.category, 'CONFLICT');
        return true;
      });

      const first = await original;
      assert.equal(first.replayed, false);
      assert.equal(first.result.transaction.status, 'SUCCESS');

      // Once the original is done, the same retry gets its stored answer.
      const later = await pay(app, alice, alice, 500, { key, sourceId: bank.id });
      assert.equal(later.replayed, true);
      assert.equal(later.result.transaction.id, first.result.transaction.id);
      assert.equal(balanceOf(app, alice), 50_000);
    } finally {
      await closeApp(app);
    }
  });

  test('concurrent requests whose original fails before recording all fail the same way and leave the key free', async () => {
    const app = await createTestApp();
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 100);
      const key = uniqueKey('all-fail');

      const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => pay(app, alice, 'ghost@miniupi', 10, { key })));
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'rejected');
        assert.ok(outcome.status === 'rejected' && outcome.reason instanceof NotFoundError);
      }
      const reused = await pay(app, alice, bob, 10, { key });
      assert.equal(reused.replayed, false);
      assert.equal(reused.result.transaction.status, 'SUCCESS');
    } finally {
      await closeApp(app);
    }
  });
});

describe('idempotency without the cache fast path', () => {
  test('once the cached outcome has expired, the retry is answered from the database record', async () => {
    const app = await createTestApp({ idempotencyCacheTtlMs: 1 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 1_000);
      const key = uniqueKey('db-path');

      const first = await pay(app, alice, bob, 300, { key });
      await sleep(5); // let the 1 ms cache entry expire
      const second = await pay(app, alice, bob, 300, { key });

      assert.equal(second.replayed, true);
      assert.deepEqual(second.result, first.result);
      assert.equal(balanceOf(app, alice), 70_000);

      await sleep(5);
      await assert.rejects(pay(app, alice, bob, 301, { key }), IdempotencyKeyReuseError, 'key reuse is caught from the database too');
    } finally {
      await closeApp(app);
    }
  });
});

describe('idempotency, second line of defence: the transaction row itself', () => {
  /** Simulates losing the idempotency record (and its cache entry) after the payment was made. */
  async function loseKeyRecord(app: Application, userId: string, key: string): Promise<void> {
    await sleep(5); // the cache entry lives for 1 ms in this application
    const { changes } = writerOf(app).run('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ?', userId, key);
    assert.equal(changes, 1);
  }

  test('a retry whose key record was lost is answered from the stored transaction, not paid again', async () => {
    const app = await createTestApp({ idempotencyCacheTtlMs: 1 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 1_000);
      const key = uniqueKey('lost-record');
      const first = await pay(app, alice, bob, 300, { key, note: 'rent' });
      await loseKeyRecord(app, alice.id, key);

      const retry = await pay(app, alice, bob, 300, { key, note: 'rent' });

      assert.equal(retry.result.error, undefined);
      assert.equal(retry.result.transaction.id, first.result.transaction.id);
      assert.equal(retry.result.transaction.status, 'SUCCESS');
      assert.equal(balanceOf(app, alice), 70_000, 'debited once');
      assert.equal(balanceOf(app, bob), 30_000);
      assert.equal(transactionsOf(app, alice.id), 2, 'the top-up and one payment');
      assert.equal(ledgerOf(app, first.result.transaction.id).length, 2);

      // The key is recorded again, so the next retry is an ordinary replay.
      await sleep(5);
      const third = await pay(app, alice, bob, 300, { key, note: 'rent' });
      assert.equal(third.replayed, true);
      assert.equal(third.result.transaction.id, first.result.transaction.id);
    } finally {
      await closeApp(app);
    }
  });

  test('if the record is lost while the payment is still in flight, the retry is told to wait and nothing runs twice', async () => {
    const app = await createTestApp({ gatewayLatencyMs: 60 });
    try {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      const key = uniqueKey('lost-in-flight');

      const original = pay(app, alice, alice, 500, { key, sourceId: bank.id }); // waits for the bank
      const { changes } = writerOf(app).run('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ?', alice.id, key);
      assert.equal(changes, 1);

      await assert.rejects(pay(app, alice, alice, 500, { key, sourceId: bank.id }), (error: unknown) => {
        assert.ok(error instanceof RequestInProgressError, `expected RequestInProgressError, got ${String(error)}`);
        assert.equal(error.category, 'CONFLICT');
        return true;
      });

      const first = await original;
      assert.equal(first.result.transaction.status, 'SUCCESS');
      assert.equal(balanceOf(app, alice), 50_000, 'credited once');
      assert.equal(transactionsOf(app, alice.id), 1);

      const later = await pay(app, alice, alice, 500, { key, sourceId: bank.id });
      assert.equal(later.result.transaction.id, first.result.transaction.id);
      assert.equal(balanceOf(app, alice), 50_000);
    } finally {
      await closeApp(app);
    }
  });

  test('a lost record of a failed payment is answered with that failure', async () => {
    const app = await createTestApp({ idempotencyCacheTtlMs: 1 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const key = uniqueKey('lost-failure');
      const first = await pay(app, alice, bob, 50, { key }); // empty wallet
      assert.equal(first.result.error?.code, 'INSUFFICIENT_BALANCE');
      await loseKeyRecord(app, alice.id, key);
      await fund(app, alice, 500); // the same request could succeed now

      const retry = await pay(app, alice, bob, 50, { key });

      assert.equal(retry.result.transaction.id, first.result.transaction.id);
      assert.equal(retry.result.transaction.status, 'FAILED');
      assert.equal(retry.result.error?.code, 'INSUFFICIENT_BALANCE');
      assert.equal(retry.result.error?.message, first.result.error?.message);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(transactionsOf(app, alice.id), 2, 'the failed payment and the later top-up');
    } finally {
      await closeApp(app);
    }
  });
});
