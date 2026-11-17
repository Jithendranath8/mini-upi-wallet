import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import type { ScheduledPayment } from '../src/domain/ScheduledPayment';
import type { User } from '../src/domain/User';
import {
  balanceOf,
  closeApp,
  createTestApp,
  eventually,
  fund,
  linkBank,
  primaryOf,
  registerUser,
  sleep,
  timelineOf,
  verifyLedger,
  writerOf,
} from './helpers';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const fails = (type: new (...args: never[]) => DomainError, code: string) => (error: unknown) => {
  assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
};

describe('scheduled payments', () => {
  let app: Application;

  // The scheduler works on everything that is due, whoever it belongs to. A fresh application
  // per test keeps one test's pending payments out of another test's scheduler run.
  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(() => closeApp(app));

  const inFuture = (ms = MINUTE) => new Date(Date.now() + ms);
  /** A scheduler clock reading at which everything scheduled by these tests is due. */
  const later = () => new Date(Date.now() + 2 * MINUTE);

  const schedule = (user: User, receiver: User, rupees: number, extra: { executeAt?: Date; sourceId?: string; note?: string } = {}) =>
    app.scheduled.schedule(user, {
      receiverUpiId: receiver.upiId,
      amount: Money.fromRupees(rupees),
      executeAt: extra.executeAt ?? inFuture(),
      sourceId: extra.sourceId,
      note: extra.note,
    });

  const stored = (payment: ScheduledPayment, owner: User) => {
    const found = app.scheduled.listFor(owner.id).find((p) => p.id === payment.id);
    assert.ok(found, `scheduled payment ${payment.id} not found`);
    return found;
  };

  const transactionsFrom = (user: User) =>
    primaryOf(app).get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ? AND type = ?', user.id, 'P2P')!.n;

  describe('scheduling', () => {
    test('stores a pending payment with the normalised receiver and a trimmed note', () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const executeAt = inFuture(5 * MINUTE);

      const payment = app.scheduled.schedule(alice, {
        receiverUpiId: `  ${bob.upiId.toUpperCase()} `,
        amount: Money.fromRupees(250.5),
        executeAt,
        note: '  Rent for June  ',
      });

      assert.match(payment.id, /^sch_[0-9a-f]{16}$/);
      assert.equal(payment.status, 'PENDING');
      assert.equal(payment.userId, alice.id);
      assert.equal(payment.receiverUpiId, bob.upiId);
      assert.equal(payment.amount.paise, 25_050);
      assert.equal(payment.note, 'Rent for June');
      assert.equal(payment.executeAt.getTime(), executeAt.getTime());
      assert.equal(payment.sourceId, null);
      assert.equal(payment.transactionId, null);
      assert.equal(payment.failureReason, null);

      const listed = app.scheduled.listFor(alice.id);
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0].toProps(), payment.toProps());
      assert.deepEqual(app.scheduled.listFor(bob.id), [], 'only the owner sees it');
    });

    test('scheduling moves no money and does not need the funds yet', () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      schedule(alice, bob, 5_000);
      assert.equal(balanceOf(app, alice), 0);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(transactionsFrom(alice), 0);
    });

    const invalidTimes: Array<[string, () => Date]> = [
      ['a time in the past', () => new Date(Date.now() - 1_000)],
      ['right now', () => new Date()],
      ['an invalid date', () => new Date('not a date')],
      ['more than 30 days ahead', () => new Date(Date.now() + 30 * DAY + MINUTE)],
      ['the year 2999', () => new Date('2999-01-01T00:00:00.000Z')],
    ];
    for (const [label, when] of invalidTimes) {
      test(`rejects ${label} with INVALID_SCHEDULE_TIME`, () => {
        const alice = registerUser(app);
        const bob = registerUser(app);
        assert.throws(() => schedule(alice, bob, 10, { executeAt: when() }), fails(ValidationError, 'INVALID_SCHEDULE_TIME'));
        assert.deepEqual(app.scheduled.listFor(alice.id), []);
      });
    }

    test('accepts the boundaries: one second from now and just under 30 days ahead', () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      assert.equal(schedule(alice, bob, 10, { executeAt: inFuture(1_000) }).status, 'PENDING');
      assert.equal(schedule(alice, bob, 10, { executeAt: inFuture(30 * DAY - MINUTE) }).status, 'PENDING');
    });

    test('rejects a zero amount, an unknown receiver and a source that belongs to someone else', () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bobsBank = linkBank(app, bob);

      assert.throws(() => schedule(alice, bob, 0), fails(ValidationError, 'INVALID_AMOUNT'));
      assert.throws(
        () => app.scheduled.schedule(alice, { receiverUpiId: 'ghost@miniupi', amount: Money.fromRupees(1), executeAt: inFuture() }),
        fails(NotFoundError, 'RECEIVER_NOT_FOUND'),
      );
      assert.throws(() => schedule(alice, bob, 10, { sourceId: bobsBank.id }), fails(NotFoundError, 'SOURCE_NOT_FOUND'));
      assert.throws(() => schedule(alice, bob, 10, { sourceId: 'src_missing' }), fails(NotFoundError, 'SOURCE_NOT_FOUND'));
      assert.deepEqual(app.scheduled.listFor(alice.id), []);
    });

    test('a note longer than 80 characters is cut to 80 rather than refused', () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      assert.equal(schedule(alice, bob, 10, { note: 'n'.repeat(200) }).note.length, 80);
    });
  });

  describe('execution', () => {
    test('nothing happens before the payment is due', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const payment = schedule(alice, bob, 100, { executeAt: inFuture(10 * MINUTE) });

      assert.equal(await app.scheduled.runDue(new Date()), 0);
      assert.equal(await app.scheduled.runDue(new Date(payment.executeAt.getTime() - 1)), 0);

      assert.equal(stored(payment, alice).status, 'PENDING');
      assert.equal(balanceOf(app, bob), 0);
    });

    test('runDue executes a due payment exactly once', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const payment = schedule(alice, bob, 120.5, { note: 'Electricity' });

      assert.equal(await app.scheduled.runDue(payment.executeAt), 1, 'due exactly at its execution time');

      const executed = stored(payment, alice);
      assert.equal(executed.status, 'EXECUTED');
      assert.equal(executed.failureReason, null);
      assert.ok(executed.transactionId);
      assert.equal(balanceOf(app, alice), 50_000 - 12_050);
      assert.equal(balanceOf(app, bob), 12_050);

      const { transaction } = app.queries.details(executed.transactionId, alice.id, true).data;
      assert.equal(transaction.status, 'SUCCESS');
      assert.equal(transaction.amountPaise, 12_050);
      assert.equal(transaction.note, 'Electricity');
      assert.equal(transaction.receiver.id, bob.id);
      assert.deepEqual(timelineOf(app, executed.transactionId, alice), ['INITIATED', 'PROCESSING', 'SUCCESS']);
    });

    test('running the scheduler again does not pay twice', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const payment = schedule(alice, bob, 100);

      assert.equal(await app.scheduled.runDue(later()), 1);
      assert.equal(await app.scheduled.runDue(later()), 0);
      assert.equal(await app.scheduled.runDue(later()), 0);

      assert.equal(balanceOf(app, alice), 40_000);
      assert.equal(balanceOf(app, bob), 10_000);
      assert.equal(transactionsFrom(alice), 1);
      assert.equal(stored(payment, alice).status, 'EXECUTED');
    });

    test('its idempotency key makes even a re-run after a crash harmless', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const payment = schedule(alice, bob, 100, { note: 'Rent' });

      // A scheduler that paid and then crashed before recording it: the payment exists already.
      const paid = await app.transfers.transfer({
        idempotencyKey: payment.idempotencyKey(),
        senderId: alice.id,
        receiverUpiId: payment.receiverUpiId,
        amount: payment.amount,
        note: payment.note,
      });
      assert.equal(paid.result.transaction.status, 'SUCCESS');

      assert.equal(await app.scheduled.runDue(later()), 1);

      const executed = stored(payment, alice);
      assert.equal(executed.status, 'EXECUTED');
      assert.equal(executed.transactionId, paid.result.transaction.id, 'the re-run found the existing payment');
      assert.equal(balanceOf(app, alice), 40_000, 'debited once');
      assert.equal(balanceOf(app, bob), 10_000);
      assert.equal(transactionsFrom(alice), 1);
    });

    test('two schedulers running at the same moment pay each due payment once', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = await fund(app, alice, 500);
      app.chaos.update({ bank: { latencyMs: 20 } }); // keeps the first payment in flight
      const viaBank = schedule(alice, bob, 100, { sourceId: bank.id, executeAt: inFuture(MINUTE) });
      const viaWallet = schedule(alice, bob, 50, { executeAt: inFuture(MINUTE + 1_000) });

      const clock = later();
      const executed = await Promise.all([app.scheduled.runDue(clock), app.scheduled.runDue(clock)]);

      // runDue reports what it actually claimed and ran: the first scheduler took the bank
      // payment, the second took the wallet payment, and neither ran the other's.
      assert.deepEqual(executed, [1, 1], 'each due payment was claimed by exactly one scheduler');
      assert.equal(stored(viaBank, alice).status, 'EXECUTED');
      assert.equal(stored(viaWallet, alice).status, 'EXECUTED');
      assert.equal(balanceOf(app, bob), 15_000, 'Rs 100 + Rs 50, each exactly once');
      assert.equal(balanceOf(app, alice), 45_000);
      assert.equal(transactionsFrom(alice), 2);
    });

    test('several due payments are executed oldest first, each on its own', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 100);
      const second = schedule(alice, bob, 60, { executeAt: inFuture(2 * MINUTE) });
      const first = schedule(alice, bob, 60, { executeAt: inFuture(MINUTE) });

      assert.equal(await app.scheduled.runDue(new Date(Date.now() + 3 * MINUTE)), 2);

      assert.equal(stored(first, alice).status, 'EXECUTED', 'the earlier one got the money');
      const failed = stored(second, alice);
      assert.equal(failed.status, 'FAILED');
      assert.match(failed.failureReason ?? '', /Wallet balance is too low/);
      assert.equal(balanceOf(app, bob), 6_000);
    });

    test('a payment that fails a business rule is recorded as FAILED with its reason and transaction', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const payment = schedule(alice, bob, 100); // empty wallet

      assert.equal(await app.scheduled.runDue(later()), 1);

      const failed = stored(payment, alice);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureReason, 'Wallet balance is too low for this payment.');
      assert.ok(failed.transactionId);
      assert.equal(app.queries.details(failed.transactionId, alice.id, true).data.transaction.status, 'FAILED');

      // It is not retried, even once the money is there.
      await fund(app, alice, 500);
      assert.equal(await app.scheduled.runDue(later()), 0);
      assert.equal(balanceOf(app, bob), 0);
    });

    test('scheduled payments go through the same fraud rules as any other payment', async () => {
      const alice = registerUser(app);
      const scammer = registerUser(app, { blacklisted: true });
      await fund(app, alice, 500);
      const payment = schedule(alice, scammer, 100);

      await app.scheduled.runDue(later());

      const failed = stored(payment, alice);
      assert.equal(failed.status, 'FAILED');
      assert.match(failed.failureReason ?? '', /reported for fraud/);
      assert.equal(balanceOf(app, scammer), 0);
    });

    test('a payment that cannot even start (the sender was blocked meanwhile) is recorded as FAILED without a transaction', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const payment = schedule(alice, bob, 100);
      writerOf(app).run(`UPDATE users SET status = 'BLOCKED' WHERE id = ?`, alice.id);

      assert.equal(await app.scheduled.runDue(later()), 1);

      const failed = stored(payment, alice);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureReason, 'Your account is blocked and cannot send money.');
      assert.equal(failed.transactionId, null);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(await app.scheduled.runDue(later()), 0);
    });

    test('the background scheduler picks a payment up on its own once it is due', async () => {
      const background = await createTestApp({ schedulerIntervalMs: 10 });
      try {
        const alice = registerUser(background);
        const bob = registerUser(background);
        await fund(background, alice, 500);
        const payment = background.scheduled.schedule(alice, {
          receiverUpiId: bob.upiId,
          amount: Money.fromRupees(100),
          executeAt: new Date(Date.now() + 40),
        });

        background.startBackgroundJobs();
        background.startBackgroundJobs(); // starting twice must not start two timers
        assert.equal(balanceOf(background, bob), 0, 'not before it is due');

        await eventually(() => background.scheduled.listFor(alice.id)[0].status === 'EXECUTED', 2_000, 5);
        assert.equal(background.scheduled.listFor(alice.id)[0].id, payment.id);
        assert.equal(balanceOf(background, bob), 10_000);

        await sleep(40); // a few more ticks
        assert.equal(balanceOf(background, bob), 10_000, 'later ticks do not pay again');
      } finally {
        await closeApp(background); // stops the scheduler
      }
    });

    test('a payment can be scheduled from a bank account', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      const payment = schedule(alice, bob, 300, { sourceId: bank.id });

      await app.scheduled.runDue(later());

      const executed = stored(payment, alice);
      assert.equal(executed.status, 'EXECUTED');
      assert.equal(balanceOf(app, bob), 30_000);
      assert.equal(balanceOf(app, alice), 0);
      assert.equal(app.queries.details(executed.transactionId!, alice.id, true).data.transaction.source.type, 'BANK_ACCOUNT');
    });

    test('one run handles at most 20 payments; the rest wait for the next run', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 100);
      for (let i = 0; i < 23; i += 1) schedule(alice, bob, 1, { executeAt: inFuture(MINUTE + i * 1_000) });

      const clock = later();
      assert.equal(await app.scheduled.runDue(clock), 20);
      assert.equal(balanceOf(app, bob), 2_000);
      assert.equal(await app.scheduled.runDue(clock), 3);
      assert.equal(balanceOf(app, bob), 2_300);
      assert.equal(await app.scheduled.runDue(clock), 0);
    });
  });

  describe('cancelling', () => {
    test('a cancelled payment is never executed', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const payment = schedule(alice, bob, 100);

      const cancelled = app.scheduled.cancel(alice, payment.id);
      assert.equal(cancelled.status, 'CANCELLED');
      assert.equal(stored(payment, alice).status, 'CANCELLED');

      assert.equal(await app.scheduled.runDue(later()), 0);
      assert.equal(balanceOf(app, alice), 50_000);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(stored(payment, alice).transactionId, null);
    });

    test('cancelling twice, or cancelling a payment that already ran, is a 409 conflict', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const cancelled = schedule(alice, bob, 100);
      const executed = schedule(alice, bob, 100);
      app.scheduled.cancel(alice, cancelled.id);
      await app.scheduled.runDue(later());

      for (const payment of [cancelled, executed]) {
        assert.throws(
          () => app.scheduled.cancel(alice, payment.id),
          (error: unknown) => {
            assert.ok(error instanceof ConflictError);
            assert.equal(error.code, 'SCHEDULE_NOT_PENDING');
            assert.equal(error.category, 'CONFLICT');
            return true;
          },
        );
      }
      assert.equal(stored(executed, alice).status, 'EXECUTED');
      assert.equal(stored(cancelled, alice).status, 'CANCELLED');
    });

    test("nobody can cancel someone else's payment, and it stays scheduled", async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      const payment = schedule(alice, bob, 100);

      assert.throws(() => app.scheduled.cancel(bob, payment.id), fails(NotFoundError, 'SCHEDULE_NOT_FOUND'));
      assert.throws(() => app.scheduled.cancel(alice, 'sch_does_not_exist'), fails(NotFoundError, 'SCHEDULE_NOT_FOUND'));

      assert.equal(stored(payment, alice).status, 'PENDING');
      assert.equal(await app.scheduled.runDue(later()), 1);
      assert.equal(balanceOf(app, bob), 10_000);
    });
  });

  describe('cancel versus run', () => {
    test('cancelling while the scheduled bank payment is in flight is refused, and the payment completes', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      const payment = schedule(alice, bob, 400, { sourceId: bank.id });
      app.chaos.update({ bank: { latencyMs: 40 } });

      const running = app.scheduled.runDue(later()); // claims the payment, then waits for the bank
      assert.equal(stored(payment, alice).status, 'RUNNING');

      assert.throws(
        () => app.scheduled.cancel(alice, payment.id),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.equal(error.code, 'SCHEDULE_NOT_PENDING');
          assert.equal(error.category, 'CONFLICT');
          return true;
        },
      );

      assert.equal(await running, 1);
      const executed = stored(payment, alice);
      assert.equal(executed.status, 'EXECUTED', 'the refused cancel did not derail the payment');
      assert.ok(executed.transactionId);
      assert.equal(balanceOf(app, bob), 40_000);
    });

    test('cancelling before the scheduler claims the payment prevents it, even mid-run', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = await fund(app, alice, 500);
      const slowFirst = schedule(alice, bob, 100, { sourceId: bank.id, executeAt: inFuture(MINUTE) });
      const cancelledInTime = schedule(alice, bob, 250, { executeAt: inFuture(MINUTE + 1_000) });
      app.chaos.update({ bank: { latencyMs: 40 } });

      // The scheduler has read both as due and is busy with the first one.
      const running = app.scheduled.runDue(later());
      assert.equal(stored(slowFirst, alice).status, 'RUNNING');
      assert.equal(stored(cancelledInTime, alice).status, 'PENDING');

      assert.equal(app.scheduled.cancel(alice, cancelledInTime.id).status, 'CANCELLED');
      assert.equal(await running, 1, 'the scheduler reports only the payment it actually ran');

      assert.equal(stored(slowFirst, alice).status, 'EXECUTED');
      const cancelled = stored(cancelledInTime, alice);
      assert.equal(cancelled.status, 'CANCELLED', 'the scheduler lost the race and skipped it');
      assert.equal(cancelled.transactionId, null);
      assert.equal(balanceOf(app, bob), 10_000, 'only the first payment was made');
      assert.equal(balanceOf(app, alice), 50_000, 'the cancelled wallet payment never debited');
      assert.equal(transactionsFrom(alice), 1);
    });
  });

  test('the ledger is consistent after a mix of executed, failed and cancelled schedules', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = await fund(app, alice, 300);
    schedule(alice, bob, 100);
    schedule(alice, bob, 150, { sourceId: bank.id });
    schedule(alice, bob, 900); // will fail: not enough in the wallet
    app.scheduled.cancel(alice, schedule(alice, bob, 50).id);

    assert.equal(await app.scheduled.runDue(later()), 3);
    assert.deepEqual(
      app.scheduled.listFor(alice.id).map((p) => p.status).sort(),
      ['CANCELLED', 'EXECUTED', 'EXECUTED', 'FAILED'],
    );
    assert.equal(balanceOf(app, bob), 25_000);
    assert.equal(verifyLedger(app).healthy, true);
  });
});
