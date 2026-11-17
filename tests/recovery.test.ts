import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { ScheduledPaymentStatus, TransactionStatus } from '../src/domain/enums';
import { GatewayUnavailableError, NotFoundError } from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import type { PaymentSource } from '../src/domain/PaymentSource';
import { ScheduledPayment } from '../src/domain/ScheduledPayment';
import type { Transaction } from '../src/domain/Transaction';
import type { User } from '../src/domain/User';
import { openDatabases, PrimaryDatabase, ReplicaDatabase } from '../src/infrastructure/db/Database';
import { MIGRATIONS } from '../src/infrastructure/db/schema';
import { tracer } from '../src/infrastructure/observability/Tracer';
import type { ChargeReceipt, ChargeStatus, PaymentGateway } from '../src/payment/gateway/PaymentGateway';
import { ReconciliationService, type ReconciliationReport } from '../src/service/ReconciliationService';
import { COMPENSATIONS_TOPIC } from '../src/service/RefundService';
import type { PartyResolver } from '../src/service/TransactionJournal';
import { buildCore, type Core } from './core';
import {
  balanceOf,
  closeApp,
  createTestApp,
  fund,
  keepAlive,
  ledgerOf,
  linkBank,
  notificationsFor,
  pay,
  primaryOf,
  registerUser,
  timelineOf,
  uniqueKey,
  verifyLedger,
  writerOf,
} from './helpers';

const NOTHING: ReconciliationReport = {
  interruptedPayments: 0,
  capturedAndQueuedForRefund: 0,
  undecided: 0,
  relayedEvents: 0,
  releasedKeys: 0,
  requeuedSchedules: 0,
};

/** A gateway that only answers "what happened to this charge?", the way the test scripts it. */
class ScriptedGateway implements PaymentGateway {
  readonly name = 'Bank network';
  readonly asked: string[] = [];

  constructor(private answer: (reference: string) => ChargeStatus | Error) {}

  nowAnswers(answer: (reference: string) => ChargeStatus | Error): void {
    this.answer = answer;
  }

  async statusOf(reference: string): Promise<ChargeStatus> {
    this.asked.push(reference);
    const answer = this.answer(reference);
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async charge(): Promise<ChargeReceipt> {
    throw new Error('reconciliation must never charge anyone');
  }

  async refund(): Promise<void> {
    throw new Error('reconciliation itself never refunds: it queues the refund');
  }
}

// ---------------------------------------------------------------------------------------------
describe('ReconciliationService.run()', () => {
  let core: Core;
  let gateway: ScriptedGateway;
  let reconciliation: ReconciliationService;

  beforeEach(() => {
    core = buildCore();
    gateway = new ScriptedGateway(() => ({ state: 'NOT_FOUND' }));
    reconciliation = new ReconciliationService(
      core.transactions,
      core.parties,
      core.journal,
      core.outbox,
      core.idempotencyKeys,
      core.scheduled,
      (source: PaymentSource) => (source.isExternal() ? gateway : undefined),
    );
  });

  afterEach(() => core.close());

  const giveBalance = (user: User, paise: number) =>
    core.primary.run('UPDATE wallets SET balance_paise = ? WHERE user_id = ?', paise, user.id);
  const balance = (user: User) => core.wallets.findByUserIdForUpdate(user.id)!.balance.paise;
  const timeline = (transactionId: string) => core.events.findByTransaction(core.primary, transactionId).map((event) => event.to);
  const ledgerEntries = () => core.primary.get<{ n: number }>('SELECT COUNT(*) AS n FROM ledger_entries')!.n;

  /** The refund jobs the CompensationObserver put on the queue. */
  async function queuedRefunds(): Promise<string[]> {
    const jobs: string[] = [];
    core.queue.subscribe<{ transactionId: string }>(COMPENSATIONS_TOPIC, async (message) => void jobs.push(message.payload.transactionId));
    await keepAlive(core.queue.drain());
    return jobs;
  }

  test('with nothing left half-done it changes nothing and reports all zeros', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const done = core.newTransaction(alice, bob);
    core.journal.open(done, core.parties.of(done));
    done.startProcessing();
    done.fail('INSUFFICIENT_BALANCE', 'Wallet balance is too low for this payment.');
    core.journal.save(done, core.parties.of(done));
    core.published.length = 0;

    assert.deepEqual(await reconciliation.run(), NOTHING);
    assert.equal(core.published.length, 0);
    assert.equal(core.transactions.findById(done.id)!.failureCode, 'INSUFFICIENT_BALANCE', 'a finished payment is left alone');
    assert.deepEqual(gateway.asked, []);
  });

  test('a wallet payment left PROCESSING is closed as FAILED / INTERRUPTED, and no money has moved', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    giveBalance(alice, 50_000);
    const stuck = core.leaveUnfinished(alice, bob, { rupees: 200 });
    assert.equal(stuck.status, 'PROCESSING');

    const report = await reconciliation.run();

    assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1 });
    const closed = core.transactions.findById(stuck.id)!;
    assert.equal(closed.status, 'FAILED');
    assert.equal(closed.failureCode, 'INTERRUPTED');
    assert.match(closed.failureReason ?? '', /restarted before this payment finished\. No money was moved\./);
    assert.equal(closed.fundsCaptured, false);
    assert.deepEqual(timeline(stuck.id), ['INITIATED', 'PROCESSING', 'FAILED']);

    assert.equal(balance(alice), 50_000);
    assert.equal(balance(bob), 0);
    assert.equal(ledgerEntries(), 0);
    assert.deepEqual(gateway.asked, [], 'a wallet payment has no gateway to ask');

    // The failure was announced (so the payer is notified), and no refund is needed.
    assert.deepEqual(
      core.published.map((event) => [event.transaction.id, event.transition.from, event.transition.to]),
      [[stuck.id, 'PROCESSING', 'FAILED']],
    );
    assert.deepEqual(core.events.findUnpublished(stuck.id), []);
    assert.deepEqual(await queuedRefunds(), []);
  });

  test('a payment that never got past INITIATED is closed the same way', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const stuck = core.leaveUnfinished(alice, bob, { status: TransactionStatus.INITIATED });

    assert.deepEqual(await reconciliation.run(), { ...NOTHING, interruptedPayments: 1 });
    assert.equal(core.transactions.findById(stuck.id)!.failureCode, 'INTERRUPTED');
    assert.deepEqual(timeline(stuck.id), ['INITIATED', 'FAILED']);
  });

  test('a bank payment left PROCESSING whose charge the gateway reports CAPTURED: FAILED with funds captured, refund queued', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const bank = core.linkBank(alice);
    const stuck = core.leaveUnfinished(alice, bob, { source: bank, rupees: 500 });
    assert.equal(stuck.fundsCaptured, false, 'we died before learning the outcome of the charge');
    gateway.nowAnswers(() => ({ state: 'CAPTURED', gatewayTransactionId: 'BANKNETWORK-000042' }));

    const report = await reconciliation.run();

    assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1, capturedAndQueuedForRefund: 1 });
    assert.deepEqual(gateway.asked, [stuck.id], 'asked by our transaction id, the reference of the charge');
    const closed = core.transactions.findById(stuck.id)!;
    assert.equal(closed.status, 'FAILED');
    assert.equal(closed.failureCode, 'INTERRUPTED');
    assert.match(closed.failureReason ?? '', /Your money will be returned automatically\./);
    assert.equal(closed.fundsCaptured, true);
    assert.equal(closed.gatewayReference, 'BANKNETWORK-000042');
    assert.equal(closed.canBeRefunded(), true);
    assert.equal(balance(bob), 0, 'the receiver was never credited');

    assert.deepEqual(await queuedRefunds(), [stuck.id], 'the CompensationObserver queued the refund');
  });

  test('a bank payment whose charge was already recorded as captured is not asked about again', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const stuck = core.leaveUnfinished(alice, bob, { source: core.linkBank(alice), captured: 'BANKNETWORK-000007' });
    gateway.nowAnswers(() => new Error('must not be asked'));

    const report = await reconciliation.run();

    assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1, capturedAndQueuedForRefund: 1 });
    assert.deepEqual(gateway.asked, []);
    assert.equal(core.transactions.findById(stuck.id)!.gatewayReference, 'BANKNETWORK-000007');
    assert.deepEqual(await queuedRefunds(), [stuck.id]);
  });

  for (const state of ['NOT_FOUND', 'REFUNDED'] as const) {
    test(`a bank payment the gateway reports as ${state}: FAILED, nothing captured, no refund queued`, async () => {
      const [alice, bob] = [core.newUser(), core.newUser()];
      const stuck = core.leaveUnfinished(alice, bob, { source: core.linkBank(alice) });
      gateway.nowAnswers(() => (state === 'NOT_FOUND' ? { state } : { state, gatewayTransactionId: 'BANKNETWORK-000001' }));

      assert.deepEqual(await reconciliation.run(), { ...NOTHING, interruptedPayments: 1 });

      const closed = core.transactions.findById(stuck.id)!;
      assert.equal(closed.status, 'FAILED');
      assert.equal(closed.failureCode, 'INTERRUPTED');
      assert.equal(closed.fundsCaptured, false);
      assert.equal(closed.canBeRefunded(), false);
      assert.match(closed.failureReason ?? '', /No money was moved/);
      assert.deepEqual(await queuedRefunds(), []);
    });
  }

  test('when the gateway cannot be reached the payment is counted as undecided and left exactly as it was', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const walletStuck = core.leaveUnfinished(alice, bob);
    const bankStuck = core.leaveUnfinished(alice, bob, { source: core.linkBank(alice), rupees: 500 });
    const before = core.transactions.findById(bankStuck.id)!.toProps();
    gateway.nowAnswers(() => new GatewayUnavailableError('Bank network', 'status query failed, network is down'));

    const report = await reconciliation.run();

    assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1, undecided: 1 });
    assert.deepEqual(core.transactions.findById(bankStuck.id)!.toProps(), before, 'never decided by assumption');
    assert.deepEqual(timeline(bankStuck.id), ['INITIATED', 'PROCESSING']);
    assert.equal(core.transactions.findById(walletStuck.id)!.status, 'FAILED', 'the other payment was still closed');
    assert.deepEqual(
      core.published.map((event) => event.transaction.id),
      [walletStuck.id],
    );

    // A later run, with the gateway back, decides it.
    gateway.nowAnswers(() => ({ state: 'CAPTURED', gatewayTransactionId: 'BANKNETWORK-000099' }));
    assert.deepEqual(await reconciliation.run(), { ...NOTHING, interruptedPayments: 1, capturedAndQueuedForRefund: 1 });
    assert.equal(core.transactions.findById(bankStuck.id)!.status, 'FAILED');
    assert.deepEqual(await queuedRefunds(), [bankStuck.id]);
  });

  test('a payment whose parties cannot be resolved is left alone and counted as undecided; the rest is still cleaned up', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const [alice, bob] = [core.newUser(), core.newUser()];
    const unreadable = core.leaveUnfinished(alice, bob);
    const fine = core.leaveUnfinished(bob, alice);
    core.idempotencyKeys.tryBegin(alice.id, 'key-died-1', 'hash', new Date());
    const resolver = {
      of: (txn: Transaction) => {
        if (txn.id === unreadable.id) throw new NotFoundError('SOURCE_NOT_FOUND', 'The original payment source no longer exists.');
        return core.parties.of(txn);
      },
    } as unknown as PartyResolver;
    const lenient = new ReconciliationService(
      core.transactions,
      resolver,
      core.journal,
      core.outbox,
      core.idempotencyKeys,
      core.scheduled,
      () => undefined,
    );

    const report = await lenient.run();

    assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1, undecided: 1, releasedKeys: 1 });
    assert.equal(core.transactions.findById(unreadable.id)!.status, 'PROCESSING', 'not guessed at');
    assert.equal(core.transactions.findById(fine.id)!.status, 'FAILED');
    assert.equal(logged.mock.callCount(), 1, 'the row that could not be interpreted is reported');
  });

  test('several unfinished payments are all closed, oldest first', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const stuck = [core.leaveUnfinished(alice, bob), core.leaveUnfinished(bob, alice), core.leaveUnfinished(alice, bob)];

    assert.deepEqual(await reconciliation.run(), { ...NOTHING, interruptedPayments: 3 });
    assert.deepEqual(
      core.published.map((event) => event.transaction.id),
      stuck.map((txn) => txn.id),
    );
    assert.deepEqual(core.transactions.findUnfinished(), []);
  });

  test('events that were committed but never announced are relayed', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    core.transactions.insert(txn);
    txn.startProcessing();
    txn.succeed();
    core.transactions.update(txn); // committed; the process died before the relay

    const report = await reconciliation.run();

    assert.deepEqual(report, { ...NOTHING, relayedEvents: 3 });
    assert.deepEqual(
      core.published.map((event) => event.transition.to),
      ['INITIATED', 'PROCESSING', 'SUCCESS'],
    );
    assert.equal(core.transactions.findById(txn.id)!.status, 'SUCCESS', 'a finished payment is never failed');
  });

  test('idempotency keys left IN_PROGRESS are released; completed ones are kept', async () => {
    const alice = core.newUser();
    const now = new Date();
    core.idempotencyKeys.tryBegin(alice.id, 'key-died-1', 'hash-1', now);
    core.idempotencyKeys.tryBegin(alice.id, 'key-died-2', 'hash-2', now);
    core.idempotencyKeys.tryBegin(alice.id, 'key-finished', 'hash-3', now);
    core.idempotencyKeys.complete(alice.id, 'key-finished', '{"ok":true}', now);

    assert.deepEqual(await reconciliation.run(), { ...NOTHING, releasedKeys: 2 });

    assert.equal(core.idempotencyKeys.find(alice.id, 'key-died-1'), undefined);
    assert.equal(core.idempotencyKeys.find(alice.id, 'key-died-2'), undefined);
    assert.equal(core.idempotencyKeys.find(alice.id, 'key-finished')?.status, 'COMPLETED');
    assert.equal(core.idempotencyKeys.tryBegin(alice.id, 'key-died-1', 'hash-1', now), true, 'the key can be claimed again');
  });

  test('scheduled payments left RUNNING go back to PENDING; every other status is untouched', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const scheduleIn = (id: string, status: ScheduledPaymentStatus) =>
      core.scheduled.insert(
        new ScheduledPayment({
          id,
          userId: alice.id,
          receiverUpiId: bob.upiId,
          sourceId: null,
          amount: Money.fromRupees(10),
          note: '',
          executeAt: new Date(Date.now() - 1_000),
          status,
          transactionId: null,
          failureReason: null,
          createdAt: new Date(),
        }),
      );
    scheduleIn('sch_running_1', ScheduledPaymentStatus.RUNNING);
    scheduleIn('sch_running_2', ScheduledPaymentStatus.RUNNING);
    scheduleIn('sch_pending', ScheduledPaymentStatus.PENDING);
    scheduleIn('sch_executed', ScheduledPaymentStatus.EXECUTED);
    scheduleIn('sch_failed', ScheduledPaymentStatus.FAILED);
    scheduleIn('sch_cancelled', ScheduledPaymentStatus.CANCELLED);

    assert.deepEqual(await reconciliation.run(), { ...NOTHING, requeuedSchedules: 2 });

    const statusOf = (id: string) => core.scheduled.findById(id)!.status;
    assert.equal(statusOf('sch_running_1'), 'PENDING');
    assert.equal(statusOf('sch_running_2'), 'PENDING');
    assert.equal(statusOf('sch_pending'), 'PENDING');
    assert.equal(statusOf('sch_executed'), 'EXECUTED');
    assert.equal(statusOf('sch_failed'), 'FAILED');
    assert.equal(statusOf('sch_cancelled'), 'CANCELLED');
    assert.equal(core.scheduled.findDue(new Date(), 20).length, 3, 'the requeued ones are due again');
  });

  test('running it a second time finds nothing left to do', async () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    core.leaveUnfinished(alice, bob);
    core.idempotencyKeys.tryBegin(alice.id, 'key-died-1', 'hash', new Date());
    const first = await reconciliation.run();
    assert.equal(first.interruptedPayments, 1);
    assert.equal(first.releasedKeys, 1);
    const announced = core.published.length;

    assert.deepEqual(await reconciliation.run(), NOTHING);
    assert.equal(core.published.length, announced, 'nothing is announced twice');
  });
});

// ---------------------------------------------------------------------------------------------
/** A throwaway folder under tests/ for the few tests that need database files that survive a "restart". */
async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(import.meta.dirname, '.tmp-recovery-'));
  try {
    await run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Starts the application again on the same files and returns what its start-up reconciliation reported. */
async function restart(dataDir: string): Promise<{ app: Application; report: ReconciliationReport | undefined }> {
  tracer.clear();
  const app = await createTestApp({ dataDir });
  const step = tracer.recentFeed(250).find((item) => item.component === 'Recovery');
  const report = step ? (JSON.parse(step.message.slice(step.message.indexOf('{'))) as ReconciliationReport) : undefined;
  return { app, report };
}

const later = () => new Date(Date.now() + 120_000);

describe('restart: what a crash left behind is cleaned up before anything is served', () => {
  test('a wallet payment in flight when the process died is closed as INTERRUPTED and its key answers from the stored transaction', async (t) => {
    t.mock.method(console, 'error', () => undefined); // the dying request logs its last failure
    await withDataDir(async (dataDir) => {
      const first = await createTestApp({ dataDir, databaseLatencyMs: 40 });
      const alice = registerUser(first);
      const bob = registerUser(first);
      await fund(first, alice, 500);
      await first.settle();
      const key = uniqueKey('died-mid-payment');

      // The payment is recorded and waiting on the database when the process is killed.
      const dying = pay(first, alice, bob, 200, { key }).then(
        () => 'finished',
        () => 'died',
      );
      first.shutdown();
      assert.equal(await dying, 'died');

      const { app, report } = await restart(dataDir);
      try {
        assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1, releasedKeys: 1 });

        const row = primaryOf(app).get<{ id: string; status: string; failure_code: string }>(
          `SELECT id, status, failure_code FROM transactions WHERE sender_id = ? AND type = 'P2P'`,
          alice.id,
        )!;
        assert.equal(row.status, 'FAILED');
        assert.equal(row.failure_code, 'INTERRUPTED');
        assert.deepEqual(timelineOf(app, row.id, alice), ['INITIATED', 'FAILED']);
        assert.deepEqual(ledgerOf(app, row.id), []);
        assert.equal(balanceOf(app, alice), 50_000, 'no money moved');
        assert.equal(balanceOf(app, bob), 0);

        // The client retries with the same key: it gets the stored outcome, not a second payment.
        const retry = await pay(app, alice, bob, 200, { key });
        assert.equal(retry.result.transaction.id, row.id);
        assert.equal(retry.result.transaction.status, 'FAILED');
        assert.equal(retry.result.error?.code, 'INTERRUPTED');
        assert.match(retry.result.error?.message ?? '', /No money was moved/);
        assert.equal(balanceOf(app, bob), 0);
        assert.equal(
          primaryOf(app).get<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ? AND type = 'P2P'`, alice.id)!.n,
          1,
        );

        // The payer was told about the failure, and can pay again with a fresh key.
        await app.settle();
        assert.deepEqual(
          notificationsFor(app, alice, row.id).map((n) => n.title),
          ['Payment failed', 'Payment failed'],
        );
        assert.equal((await pay(app, alice, bob, 200)).result.transaction.status, 'SUCCESS');
        assert.equal(balanceOf(app, bob), 20_000);
        assert.equal(verifyLedger(app).healthy, true);
      } finally {
        await closeApp(app);
      }
    });
  });

  test('a bank payment that was charged before the crash is failed, then refunded by the queued compensation', async () => {
    await withDataDir(async (dataDir) => {
      const first = await createTestApp({ dataDir });
      const alice = registerUser(first);
      const bob = registerUser(first);
      const bank = await fund(first, alice, 1_000);
      // Exactly what the bank strategy has stored after "charge succeeded, funds captured"
      // and before the receiver is credited: the point at which this process dies.
      const now = new Date().toISOString();
      const writer = writerOf(first);
      writer.run(
        `INSERT INTO transactions (id, idempotency_key, type, sender_id, receiver_id, source_id, source_type, amount_paise, note,
                                   status, funds_captured, gateway_ref, version, created_at, updated_at)
         VALUES ('txn_charged_then_died', 'key-charged-then-died', 'P2P', ?, ?, ?, 'BANK_ACCOUNT', 50000, 'Rent',
                 'PROCESSING', 1, 'BANKNETWORK-000002', 2, ?, ?)`,
        alice.id,
        bob.id,
        bank.id,
        now,
        now,
      );
      for (const [from, to] of [
        [null, 'INITIATED'],
        ['INITIATED', 'PROCESSING'],
      ]) {
        writer.run(
          `INSERT INTO transaction_events (transaction_id, from_status, to_status, detail, created_at, published_at)
           VALUES ('txn_charged_then_died', ?, ?, 'before the crash', ?, ?)`,
          from,
          to,
          now,
          now,
        );
      }
      await closeApp(first);

      const { app, report } = await restart(dataDir);
      try {
        assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1, capturedAndQueuedForRefund: 1 });
        await keepAlive(app.settle()); // lets the queued compensation job run

        const details = app.queries.details('txn_charged_then_died', alice.id, true).data;
        assert.equal(details.transaction.status, 'REFUNDED');
        assert.equal(details.transaction.failureCode, 'INTERRUPTED');
        assert.match(details.transaction.failureReason ?? '', /Your money will be returned automatically/);
        assert.deepEqual(
          details.timeline.map((step) => step.to),
          ['INITIATED', 'PROCESSING', 'FAILED', 'REFUNDED'],
        );
        assert.deepEqual(details.ledger, [], 'the receiver was never credited, so nothing was posted');
        assert.equal(balanceOf(app, bob), 0);
        assert.equal(balanceOf(app, alice), 100_000);
        assert.deepEqual(
          [...new Set(notificationsFor(app, alice, 'txn_charged_then_died').map((n) => n.title))].sort(),
          ['Payment failed', 'Refund received'],
        );

        // At the bank: the Rs 1,000 top-up is still taken, the Rs 500 came back. Rs 1,99,000 left.
        const linked = app.users.sourcesOf(alice.id).find((source) => source.id === bank.id)!;
        await fund(app, alice, 100_000, linked);
        await fund(app, alice, 99_000, linked);
        assert.equal((await pay(app, alice, alice, 0.01, { sourceId: bank.id })).result.error?.code, 'PAYMENT_DECLINED');
        assert.equal(verifyLedger(app).healthy, true);
      } finally {
        await closeApp(app);
      }
    });
  });

  test('scheduled payments claimed by a scheduler that died are run again, and each is paid exactly once', async () => {
    await withDataDir(async (dataDir) => {
      const first = await createTestApp({ dataDir });
      const alice = registerUser(first);
      const bob = registerUser(first);
      await fund(first, alice, 500);
      const schedule = (rupees: number) =>
        first.scheduled.schedule(alice, { receiverUpiId: bob.upiId, amount: Money.fromRupees(rupees), executeAt: new Date(Date.now() + 60_000) });

      // Died right after claiming: nothing was paid yet.
      const claimedOnly = schedule(100);
      // Died after paying but before recording that it had: the payment exists under the schedule's key.
      const paidNotRecorded = schedule(50);
      const alreadyPaid = await first.transfers.transfer({
        idempotencyKey: paidNotRecorded.idempotencyKey(),
        senderId: alice.id,
        receiverUpiId: bob.upiId,
        amount: paidNotRecorded.amount,
        note: paidNotRecorded.note,
      });
      assert.equal(alreadyPaid.result.transaction.status, 'SUCCESS');
      writerOf(first).run(`UPDATE scheduled_payments SET status = 'RUNNING' WHERE user_id = ?`, alice.id);
      await closeApp(first);

      const { app, report } = await restart(dataDir);
      try {
        assert.deepEqual(report, { ...NOTHING, requeuedSchedules: 2 });
        const statusOf = (id: string) => app.scheduled.listFor(alice.id).find((p) => p.id === id)!;
        assert.equal(statusOf(claimedOnly.id).status, 'PENDING');
        assert.equal(statusOf(paidNotRecorded.id).status, 'PENDING');
        assert.equal(balanceOf(app, bob), 5_000);

        assert.equal(await app.scheduled.runDue(later()), 2);

        assert.equal(statusOf(claimedOnly.id).status, 'EXECUTED');
        assert.equal(statusOf(paidNotRecorded.id).status, 'EXECUTED');
        assert.equal(statusOf(paidNotRecorded.id).transactionId, alreadyPaid.result.transaction.id, 'found its earlier payment');
        assert.equal(balanceOf(app, bob), 15_000, 'Rs 100 now, and the Rs 50 only the one time');
        assert.equal(balanceOf(app, alice), 35_000);

        assert.equal(await app.scheduled.runDue(later()), 0);
        assert.equal(balanceOf(app, bob), 15_000);
      } finally {
        await closeApp(app);
      }
    });
  });

  test('a scheduled bank payment that was in flight when the process died is never paid twice', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    await withDataDir(async (dataDir) => {
      const first = await createTestApp({ dataDir, gatewayLatencyMs: 40 });
      const alice = registerUser(first);
      const bob = registerUser(first);
      const bank = linkBank(first, alice);
      const scheduled = first.scheduled.schedule(alice, {
        receiverUpiId: bob.upiId,
        amount: Money.fromRupees(300),
        sourceId: bank.id,
        executeAt: new Date(Date.now() + 60_000),
      });
      const dying = first.scheduled.runDue(later()).then(
        () => 'finished',
        () => 'died',
      );
      first.shutdown(); // claimed, payment PROCESSING, waiting for the bank
      assert.equal(await dying, 'died');

      const { app, report } = await restart(dataDir);
      try {
        assert.deepEqual(report, { ...NOTHING, interruptedPayments: 1, releasedKeys: 1, requeuedSchedules: 1 });
        assert.equal(app.scheduled.listFor(alice.id)[0].status, 'PENDING');

        assert.equal(await app.scheduled.runDue(later()), 1);
        assert.equal(await app.scheduled.runDue(later()), 0);

        // The re-run found the interrupted payment under the schedule's key and did not start another.
        const after = app.scheduled.listFor(alice.id)[0];
        assert.equal(after.id, scheduled.id);
        assert.notEqual(after.status, 'PENDING');
        assert.notEqual(after.status, 'RUNNING');
        const payments = primaryOf(app).all<{ id: string; status: string }>(
          'SELECT id, status FROM transactions WHERE sender_id = ? ORDER BY created_at',
          alice.id,
        );
        assert.equal(payments.length, 1, 'one transaction for this schedule, however often it is run');
        assert.equal(after.transactionId, payments[0].id);
        assert.equal(balanceOf(app, bob), payments[0].status === 'SUCCESS' ? 30_000 : 0);
        assert.equal(verifyLedger(app).healthy, true);
      } finally {
        await closeApp(app);
      }
    });
  });

  test('a crash between the commit and the publish cannot lose a notification, and a later start does not repeat it', async () => {
    await withDataDir(async (dataDir) => {
      const first = await createTestApp({ dataDir });
      const alice = registerUser(first);
      const bob = registerUser(first);
      await fund(first, alice, 500);
      const { result } = await pay(first, alice, bob, 40);
      await first.settle();
      // Rewind to the instant after the commit: the SUCCESS event is stored, nobody was told.
      const writer = writerOf(first);
      writer.run(`UPDATE transaction_events SET published_at = NULL WHERE transaction_id = ? AND to_status = 'SUCCESS'`, result.transaction.id);
      writer.run('DELETE FROM notifications WHERE transaction_id = ?', result.transaction.id);
      await closeApp(first);

      const second = await restart(dataDir);
      try {
        assert.deepEqual(second.report, { ...NOTHING, relayedEvents: 1 });
        await second.app.settle();
        const received = notificationsFor(second.app, bob, result.transaction.id);
        assert.deepEqual(received.map((n) => `${n.title}/${n.channel}/${n.status}`).sort(), ['Money received/PUSH/SENT', 'Money received/SMS/SENT']);
        assert.equal(notificationsFor(second.app, alice, result.transaction.id).length, 2);
        assert.equal(balanceOf(second.app, bob), 4_000, 'announcing again moved no money');
      } finally {
        await closeApp(second.app);
      }

      const third = await restart(dataDir);
      try {
        assert.equal(third.report, undefined, 'nothing left to reconcile');
        await third.app.settle();
        assert.equal(notificationsFor(third.app, bob, result.transaction.id).length, 2, 'not sent a second time');
        assert.equal(
          primaryOf(third.app).get<{ n: number }>('SELECT COUNT(*) AS n FROM transaction_events WHERE published_at IS NULL')!.n,
          0,
        );
      } finally {
        await closeApp(third.app);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('schema migrations', () => {
  const columnsOf = (db: PrimaryDatabase | ReplicaDatabase, table: string) =>
    db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((column) => column.name);

  /** A database file exactly as version 1 of the application left it, with some history in it. */
  function createVersionOneDatabase(path: string, userVersion: number): void {
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0].sql);
    old.exec(`PRAGMA user_version = ${userVersion}`);
    old.exec(`
      INSERT INTO users (id, name, upi_id, phone, pin_hash, pin_salt, status, daily_limit_paise, notification_channels, created_at)
        VALUES ('usr_old', 'Old User', 'old@miniupi', '9000000001', 'hash', 'salt', 'ACTIVE', 5000000, '["SMS"]', '2026-01-01T00:00:00.000Z');
      INSERT INTO wallets (id, user_id, balance_paise, version, status, updated_at)
        VALUES ('wal_old', 'usr_old', 12345, 3, 'ACTIVE', '2026-01-01T00:00:00.000Z');
      INSERT INTO payment_sources (id, user_id, type, details, created_at)
        VALUES ('src_old', 'usr_old', 'WALLET', '{"walletId":"wal_old"}', '2026-01-01T00:00:00.000Z');
      INSERT INTO transactions (id, idempotency_key, type, sender_id, receiver_id, source_id, source_type, amount_paise, status, created_at, updated_at)
        VALUES ('txn_old', 'key-old-0001', 'P2P', 'usr_old', 'usr_old', 'src_old', 'WALLET', 100, 'FAILED', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
      INSERT INTO transaction_events (transaction_id, from_status, to_status, detail, created_at)
        VALUES ('txn_old', NULL, 'INITIATED', 'Payment request accepted', '2026-01-01T00:00:00.000Z'),
               ('txn_old', 'INITIATED', 'FAILED', 'Self transfer', '2026-01-01T00:00:01.000Z');
    `);
    old.close();
  }

  test('migrations are numbered 1, 2, ... without gaps, and version 1 has no outbox column yet', () => {
    assert.deepEqual(
      MIGRATIONS.map((migration) => migration.version),
      MIGRATIONS.map((_, index) => index + 1),
    );
    for (const migration of MIGRATIONS) assert.ok(migration.description.length > 0);
    assert.equal(/published_at/.test(MIGRATIONS[0].sql), false);
    assert.match(MIGRATIONS[1].sql, /ADD COLUMN published_at/);
  });

  test('a fresh database is created at the latest version, primary and replica alike', () => {
    const primary = new PrimaryDatabase(':memory:');
    const replica = new ReplicaDatabase(':memory:');
    try {
      const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
      assert.equal(latest, 2);
      assert.equal(primary.schemaVersion(), latest);
      assert.equal(replica.schemaVersion(), latest);
      assert.ok(columnsOf(primary, 'transaction_events').includes('published_at'));
      assert.ok(columnsOf(replica, 'transaction_events').includes('published_at'));
    } finally {
      primary.close();
      replica.close();
    }
  });

  test('every connection waits up to five seconds for a write lock instead of failing at once', () => {
    const primary = new PrimaryDatabase(':memory:');
    const replica = new ReplicaDatabase(':memory:');
    try {
      assert.deepEqual({ ...primary.get<object>('PRAGMA busy_timeout') }, { timeout: 5_000 });
      assert.deepEqual({ ...replica.get<object>('PRAGMA busy_timeout') }, { timeout: 5_000 });
    } finally {
      primary.close();
      replica.close();
    }
  });

  test('rebuild() (demo reset) recreates the schema at the latest version', () => {
    const primary = new PrimaryDatabase(':memory:');
    try {
      primary.run(
        `INSERT INTO users (id, name, upi_id, phone, pin_hash, pin_salt, status, daily_limit_paise, notification_channels, created_at)
         VALUES ('u1', 'U', 'u@miniupi', '9', 'h', 's', 'ACTIVE', 0, '[]', 'now')`,
      );
      primary.rebuild();
      assert.equal(primary.schemaVersion(), 2);
      assert.equal(primary.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n, 0);
      assert.ok(columnsOf(primary, 'transaction_events').includes('published_at'));
    } finally {
      primary.close();
    }
  });

  for (const [label, userVersion] of [
    ['a database created at version 1', 1],
    ['a database from before versions were recorded (user_version 0)', 0],
  ] as const) {
    test(`${label}, without published_at, is upgraded to version 2 in place with its old events marked published`, async () => {
      await withDataDir(async (dataDir) => {
        const path = join(dataDir, 'primary.db');
        createVersionOneDatabase(path, userVersion);

        const upgraded = new PrimaryDatabase(path);
        try {
          assert.equal(upgraded.schemaVersion(), 2);
          assert.ok(columnsOf(upgraded, 'transaction_events').includes('published_at'));
          const events = upgraded.all<{ to_status: string; created_at: string; published_at: string | null }>(
            'SELECT to_status, created_at, published_at FROM transaction_events ORDER BY id',
          );
          assert.deepEqual(
            events.map((event) => [event.to_status, event.published_at]),
            [
              ['INITIATED', '2026-01-01T00:00:00.000Z'],
              ['FAILED', '2026-01-01T00:00:01.000Z'],
            ],
            'events from before the outbox existed were announced the old way: they must not be announced again',
          );
          assert.ok(upgraded.get(`SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_unpublished'`));

          // Nothing else was touched.
          assert.equal(upgraded.get<{ balance_paise: number; version: number }>('SELECT balance_paise, version FROM wallets')!.balance_paise, 12_345);
          assert.equal(upgraded.get<{ status: string }>(`SELECT status FROM transactions WHERE id = 'txn_old'`)!.status, 'FAILED');

          // New events start unpublished.
          upgraded.run(
            `INSERT INTO transaction_events (transaction_id, from_status, to_status, detail, created_at)
             VALUES ('txn_old', 'FAILED', 'REFUNDED', 'after the upgrade', '2026-02-01T00:00:00.000Z')`,
          );
        } finally {
          upgraded.close();
        }

        // Opening it again applies nothing: the event written after the upgrade is still unpublished.
        const reopened = new PrimaryDatabase(path);
        try {
          assert.equal(reopened.schemaVersion(), 2);
          assert.deepEqual(
            reopened
              .all<{ to_status: string }>('SELECT to_status FROM transaction_events WHERE published_at IS NULL')
              .map((row) => row.to_status),
            ['REFUNDED'],
          );
        } finally {
          reopened.close();
        }
      });
    });
  }

  test('the whole application starts on a version 1 database: nothing old is re-announced, and it keeps working', async () => {
    await withDataDir(async (dataDir) => {
      createVersionOneDatabase(join(dataDir, 'primary.db'), 1);

      const { app, report } = await restart(dataDir);
      try {
        assert.equal(report, undefined, 'the old events count as published, so there is nothing to relay');
        await app.settle();
        assert.equal(app.users.findByUpiId('old@miniupi')?.id, 'usr_old');
        assert.equal(app.users.walletOf('usr_old').balance.paise, 12_345);
        assert.deepEqual(app.notifications.listFor(primaryOf(app), 'usr_old', 50), []);
        const old = app.users.require('usr_old');
        assert.deepEqual(timelineOf(app, 'txn_old', old), ['INITIATED', 'FAILED']);

        // The replica was rebuilt from the upgraded primary.
        await app.settle();
        const fromReplica = app.queries.history('usr_old', 10);
        assert.equal(fromReplica.servedBy, 'replica');
        assert.deepEqual(
          fromReplica.data.map((txn) => txn.id),
          ['txn_old'],
        );
      } finally {
        await closeApp(app);
      }
    });
  });

  test('openDatabases gives an upgraded primary and a replica with the same schema and data', async () => {
    await withDataDir(async (dataDir) => {
      createVersionOneDatabase(join(dataDir, 'primary.db'), 1);
      const { primary, replica } = openDatabases(dataDir);
      try {
        assert.equal(primary.schemaVersion(), 2);
        assert.equal(replica.schemaVersion(), 2);
        const events = 'SELECT transaction_id, to_status, published_at FROM transaction_events ORDER BY id';
        assert.deepEqual(replica.all(events), primary.all(events));
        assert.equal(replica.all(events).length, 2);
      } finally {
        primary.close();
        replica.close();
      }
    });
  });

  test('a migration that fails is rolled back, reported with its number, and the version stays where it was', async () => {
    await withDataDir(async (dataDir) => {
      const path = join(dataDir, 'primary.db');
      createVersionOneDatabase(path, 1);
      const sabotage = new DatabaseSync(path);
      sabotage.exec('ALTER TABLE transaction_events ADD COLUMN published_at TEXT'); // migration 2 will now collide
      sabotage.close();

      assert.throws(() => new PrimaryDatabase(path), /Migration 2 \(.+\) failed/);

      const inspect = new DatabaseSync(path);
      try {
        assert.deepEqual({ ...(inspect.prepare('PRAGMA user_version').get() as object) }, { user_version: 1 });
        assert.deepEqual(
          { ...(inspect.prepare('SELECT COUNT(*) AS n FROM transaction_events WHERE published_at IS NOT NULL').get() as object) },
          { n: 0 },
          'the half-applied statements of the failed migration were undone',
        );
      } finally {
        inspect.close();
      }
    });
  });
});
