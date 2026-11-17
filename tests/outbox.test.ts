import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { PaymentSourceType, TransactionStatus } from '../src/domain/enums';
import { DomainError, NotFoundError, OptimisticLockError, ValidationError } from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import { BankAccountSource, WalletSource } from '../src/domain/PaymentSource';
import { Transaction } from '../src/domain/Transaction';
import { OutboxRelay } from '../src/events/Outbox';
import type { TransactionEvent } from '../src/events/TransactionEvents';
import { PaymentStrategyFactory } from '../src/payment/PaymentStrategy';
import { WalletPaymentStrategy } from '../src/payment/strategies';
import type { TransactionEventRepository } from '../src/repository/interfaces';
import { PartyResolver } from '../src/service/TransactionJournal';
import { buildCore, type Core } from './core';
import {
  closeApp,
  createTestApp,
  fund,
  linkBank,
  notificationsFor,
  pay,
  primaryOf,
  registerUser,
  writerOf,
} from './helpers';

const fails = (type: new (...args: never[]) => DomainError, code: string) => (error: unknown) => {
  assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
};

const transitionsOf = (events: TransactionEvent[]) => events.map((event) => `${event.transaction.id}:${event.transition.to}`);

// ---------------------------------------------------------------------------------------------
describe('transactional outbox', () => {
  let core: Core;

  beforeEach(() => {
    core = buildCore();
  });

  afterEach(() => core.close());

  const unpublished = (transactionId: string) => core.events.findUnpublished(transactionId).map((event) => event.to);

  test('a state change is stored with its event, unpublished: nothing is announced by saving', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);

    core.transactions.insert(txn);
    assert.deepEqual(unpublished(txn.id), ['INITIATED']);
    txn.startProcessing();
    txn.succeed();
    core.transactions.update(txn);

    assert.deepEqual(unpublished(txn.id), ['INITIATED', 'PROCESSING', 'SUCCESS']);
    assert.deepEqual(core.published, [], 'the repository never talks to observers');
    assert.deepEqual(core.events.findTransactionsWithUnpublished(), [txn.id]);
    const rows = core.primary.all<{ to_status: string; published_at: string | null }>(
      'SELECT to_status, published_at FROM transaction_events WHERE transaction_id = ? ORDER BY id',
      txn.id,
    );
    assert.deepEqual(
      rows.map((row) => [row.to_status, row.published_at]),
      [
        ['INITIATED', null],
        ['PROCESSING', null],
        ['SUCCESS', null],
      ],
    );
  });

  test('relay publishes the pending events oldest first, then marks them published', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob, 250);
    core.transactions.insert(txn);
    txn.startProcessing();
    core.transactions.update(txn);
    const parties = core.parties.of(txn);

    const relayed = core.outbox.relay(txn, parties);

    assert.equal(relayed, 2);
    assert.deepEqual(transitionsOf(core.published), [`${txn.id}:INITIATED`, `${txn.id}:PROCESSING`]);
    assert.deepEqual(unpublished(txn.id), []);
    assert.deepEqual(core.events.findTransactionsWithUnpublished(), []);
    assert.deepEqual(core.outbox.stats(), { relayed: 2 });

    const [first, second] = core.published;
    assert.equal(first.transaction, txn);
    assert.deepEqual({ from: first.transition.from, to: first.transition.to, detail: first.transition.detail }, {
      from: null,
      to: TransactionStatus.INITIATED,
      detail: 'Payment request accepted',
    });
    assert.ok(first.transition.at instanceof Date);
    assert.equal(second.transition.from, TransactionStatus.INITIATED);
    assert.equal(first.sender.id, alice.id);
    assert.equal(first.receiver.id, bob.id);
    assert.equal(first.source.id, parties.source.id);

    const stamps = core.primary.all<{ created_at: string; published_at: string }>(
      'SELECT created_at, published_at FROM transaction_events WHERE transaction_id = ?',
      txn.id,
    );
    for (const row of stamps) assert.ok(row.published_at >= row.created_at, 'published after it was created');
  });

  test('a second relay publishes nothing', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    core.transactions.insert(txn);
    const parties = core.parties.of(txn);
    assert.equal(core.outbox.relay(txn, parties), 1);

    assert.equal(core.outbox.relay(txn, parties), 0);
    assert.equal(core.outbox.relay(txn, parties), 0);
    assert.equal(core.published.length, 1);
    assert.deepEqual(core.outbox.stats(), { relayed: 1 });
  });

  test('each relay hands over only what happened since the previous one', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    const parties = core.parties.forNewPayment(alice.id, bob.upiId, undefined);
    core.transactions.insert(txn);
    core.outbox.relay(txn, parties);
    txn.startProcessing();
    core.transactions.update(txn);
    core.outbox.relay(txn, parties);
    txn.fail('INSUFFICIENT_BALANCE', 'Wallet balance is too low for this payment.');
    core.transactions.update(txn);
    core.outbox.relay(txn, parties);

    assert.deepEqual(
      core.published.map((event) => event.transition.to),
      ['INITIATED', 'PROCESSING', 'FAILED'],
    );
    assert.equal(core.published[2].transition.detail, 'Wallet balance is too low for this payment.');
  });

  test('relay touches only the events of the transaction it was given', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const mine = core.newTransaction(alice, bob);
    const other = core.newTransaction(bob, alice);
    core.transactions.insert(mine);
    core.transactions.insert(other);

    assert.equal(core.outbox.relay(mine, core.parties.of(mine)), 1);
    assert.deepEqual(transitionsOf(core.published), [`${mine.id}:INITIATED`]);
    assert.deepEqual(unpublished(other.id), ['INITIATED']);
  });

  test('relayAll after a crash publishes everything that was committed but never announced', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const announced = core.newTransaction(alice, bob);
    core.transactions.insert(announced);
    core.outbox.relay(announced, core.parties.of(announced));
    core.published.length = 0;

    // The process dies after these commits and before any relay.
    const first = core.newTransaction(alice, bob);
    core.transactions.insert(first);
    const second = core.newTransaction(bob, alice);
    core.transactions.insert(second);
    first.startProcessing();
    first.succeed();
    core.transactions.update(first);
    // ...and one event row is all that is left of a status change (inserted straight into the table).
    core.primary.run(
      `INSERT INTO transaction_events (transaction_id, from_status, to_status, detail, created_at)
       VALUES (?, 'INITIATED', 'PROCESSING', 'Picked up for processing', ?)`,
      second.id,
      new Date().toISOString(),
    );

    // Restart: a new relay over the same storage.
    const restarted = new OutboxRelay(core.events, core.publisher, core.loadForRelay);
    const relayed = restarted.relayAll();

    assert.equal(relayed, 5);
    assert.deepEqual(transitionsOf(core.published), [
      `${first.id}:INITIATED`,
      `${first.id}:PROCESSING`,
      `${first.id}:SUCCESS`,
      `${second.id}:INITIATED`,
      `${second.id}:PROCESSING`,
    ]);
    assert.equal(core.published[2].transaction.status, 'SUCCESS', 'the event carries the transaction as stored');
    assert.equal(core.published[2].receiver.id, bob.id);
    assert.deepEqual(core.events.findTransactionsWithUnpublished(), []);

    assert.equal(restarted.relayAll(), 0, 'a second start-up relay finds nothing');
    assert.equal(core.published.length, 5);
  });

  test('relayAll with an empty outbox does nothing', () => {
    assert.equal(core.outbox.relayAll(), 0);
    assert.deepEqual(core.published, []);
  });

  test('an event whose transaction cannot be loaded stays in the outbox instead of being dropped', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    core.transactions.insert(txn);
    const blind = new OutboxRelay(core.events, core.publisher, () => undefined);

    assert.equal(blind.relayAll(), 0);
    assert.deepEqual(unpublished(txn.id), ['INITIATED']);
    assert.equal(core.outbox.relayAll(), 1, 'a relay that can load it publishes it later');
  });

  test('delivery is at-least-once: a crash after publishing but before marking publishes again', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    core.transactions.insert(txn);
    let crashOnMark = true;
    const flaky: TransactionEventRepository = {
      append: (event) => core.events.append(event),
      findByTransaction: (reader, id) => core.events.findByTransaction(reader, id),
      findUnpublished: (id) => core.events.findUnpublished(id),
      findTransactionsWithUnpublished: () => core.events.findTransactionsWithUnpublished(),
      markPublished: (ids, at) => {
        if (crashOnMark) throw new Error('process died before the mark was written');
        core.events.markPublished(ids, at);
      },
    };
    const relay = new OutboxRelay(flaky, core.publisher, core.loadForRelay);

    assert.throws(() => relay.relay(txn, core.parties.of(txn)), /process died/);
    assert.equal(core.published.length, 1, 'the observers were told');
    assert.deepEqual(unpublished(txn.id), ['INITIATED'], 'but the event is still marked unpublished');

    crashOnMark = false;
    assert.equal(relay.relayAll(), 1);
    assert.equal(core.published.length, 2, 'told a second time: never lost, possibly repeated');
    assert.deepEqual(unpublished(txn.id), []);
  });

  test('a failing observer does not keep an event in the outbox or stop the other observers', (t) => {
    t.mock.method(console, 'error', () => undefined);
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    core.transactions.insert(txn);
    core.publisher.subscribe({
      name: 'broken webhook',
      onTransactionEvent: () => {
        throw new Error('webhook endpoint is down');
      },
    });

    assert.equal(core.outbox.relay(txn, core.parties.of(txn)), 1);
    assert.equal(core.published.length, 1);
    assert.deepEqual(unpublished(txn.id), []);
  });
});

// ---------------------------------------------------------------------------------------------
describe('TransactionJournal', () => {
  let core: Core;

  beforeEach(() => {
    core = buildCore();
  });

  afterEach(() => core.close());

  test('open stores the transaction and announces its creation', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob, 75);

    core.journal.open(txn, core.parties.of(txn));

    assert.equal(core.journal.find(txn.id)?.status, 'INITIATED');
    assert.equal(core.journal.find(txn.id)?.amount.paise, 7_500);
    assert.deepEqual(transitionsOf(core.published), [`${txn.id}:INITIATED`]);
    assert.deepEqual(core.events.findUnpublished(txn.id), []);
  });

  test('from the moment a payment is opened the payer reads from the primary', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    assert.equal(core.readRouter.route(alice.id).role, 'replica');
    const txn = core.newTransaction(alice, bob);

    core.journal.open(txn, core.parties.of(txn));

    assert.equal(core.readRouter.route(alice.id).role, 'primary', 'the replica of this test never catches up');
    assert.equal(core.readRouter.route(bob.id).role, 'replica', 'only the payer is pinned');
  });

  test('save stores a state change and announces exactly that change', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    const parties = core.parties.of(txn);
    core.journal.open(txn, parties);

    txn.startProcessing();
    core.journal.save(txn, parties);
    txn.fail('DAILY_LIMIT_EXCEEDED', 'This payment would exceed your daily transfer limit.');
    core.journal.save(txn, parties);

    const stored = core.journal.require(txn.id);
    assert.equal(stored.status, 'FAILED');
    assert.equal(stored.failureCode, 'DAILY_LIMIT_EXCEEDED');
    assert.equal(stored.version, 2);
    assert.deepEqual(
      core.published.map((event) => event.transition.to),
      ['INITIATED', 'PROCESSING', 'FAILED'],
    );
  });

  test('a stale save is refused and announces nothing', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    const parties = core.parties.of(txn);
    core.journal.open(txn, parties);
    const stale = core.journal.require(txn.id);
    txn.startProcessing();
    core.journal.save(txn, parties);
    core.published.length = 0;

    stale.fail('LOCK_TIMEOUT', 'gave up');
    assert.throws(() => core.journal.save(stale, parties), OptimisticLockError);

    assert.deepEqual(core.published, []);
    assert.equal(core.journal.require(txn.id).status, 'PROCESSING');
  });

  test('announce relays what a payment strategy has already committed', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    const parties = core.parties.of(txn);
    core.journal.open(txn, parties);
    core.published.length = 0;

    // A strategy commits status and event in its own unit of work, through the repository.
    txn.startProcessing();
    txn.succeed();
    core.transactions.update(txn);
    assert.equal(core.published.length, 0);

    core.journal.announce(txn, parties);
    assert.deepEqual(
      core.published.map((event) => event.transition.to),
      ['PROCESSING', 'SUCCESS'],
    );
    core.journal.announce(txn, parties);
    assert.equal(core.published.length, 2, 'announcing again repeats nothing');
  });

  test('find, require and findByKey', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const txn = core.newTransaction(alice, bob);
    core.journal.open(txn, core.parties.of(txn));

    assert.equal(core.journal.find(txn.id)?.id, txn.id);
    assert.equal(core.journal.find('txn_missing'), undefined);
    assert.equal(core.journal.require(txn.id).id, txn.id);
    assert.throws(() => core.journal.require('txn_missing'), fails(NotFoundError, 'TRANSACTION_NOT_FOUND'));
    assert.equal(core.journal.findByKey(alice.id, txn.idempotencyKey)?.id, txn.id);
    assert.equal(core.journal.findByKey(bob.id, txn.idempotencyKey), undefined, 'a key belongs to its sender');
    assert.equal(core.journal.findByKey(alice.id, 'another-key'), undefined);
  });
});

// ---------------------------------------------------------------------------------------------
describe('PartyResolver', () => {
  let core: Core;

  beforeEach(() => {
    core = buildCore();
  });

  afterEach(() => core.close());

  test('for a new payment: the sender, the receiver by UPI ID and, by default, the sender wallet', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];

    const parties = core.parties.forNewPayment(alice.id, `  ${bob.upiId.toUpperCase()} `, undefined);

    assert.equal(parties.sender.id, alice.id);
    assert.equal(parties.receiver.id, bob.id);
    assert.ok(parties.source instanceof WalletSource);
    assert.equal(parties.source.userId, alice.id);
  });

  test('for a new payment with an explicit source: that source, if it belongs to the sender', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const bank = core.linkBank(alice);

    const parties = core.parties.forNewPayment(alice.id, bob.upiId, bank.id);
    assert.ok(parties.source instanceof BankAccountSource);
    assert.equal(parties.source.id, bank.id);

    const topUp = core.parties.forNewPayment(alice.id, alice.upiId, bank.id);
    assert.equal(topUp.sender.id, topUp.receiver.id, 'paying yourself resolves to the same person twice');
  });

  test('throws NotFoundError for an unknown sender, receiver or source', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const bobsBank = core.linkBank(bob);

    assert.throws(() => core.parties.forNewPayment('usr_missing', bob.upiId, undefined), fails(NotFoundError, 'USER_NOT_FOUND'));
    assert.throws(() => core.parties.forNewPayment(alice.id, 'ghost@miniupi', undefined), fails(NotFoundError, 'RECEIVER_NOT_FOUND'));
    assert.throws(() => core.parties.forNewPayment(alice.id, bob.upiId, 'src_missing'), fails(NotFoundError, 'SOURCE_NOT_FOUND'));
    assert.throws(
      () => core.parties.forNewPayment(alice.id, bob.upiId, bobsBank.id),
      fails(NotFoundError, 'SOURCE_NOT_FOUND'),
      "someone else's source is reported as not found, never confirmed to exist",
    );
  });

  test('of(transaction) rebuilds the parties of a stored payment', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const bank = core.linkBank(alice);
    const txn = core.newTransaction(alice, bob, 100, bank);
    core.transactions.insert(txn);

    const parties = core.parties.of(core.transactions.findById(txn.id)!);
    assert.equal(parties.sender.upiId, alice.upiId);
    assert.equal(parties.receiver.upiId, bob.upiId);
    assert.equal(parties.source.id, bank.id);
    assert.equal(parties.source.describe(), 'Test Bank XXXX9012');
  });

  test('of(transaction) throws NotFoundError when the source or a user no longer exists', () => {
    const [alice, bob] = [core.newUser(), core.newUser()];
    const orphan = (overrides: { senderId?: string; receiverId?: string; sourceId?: string }) =>
      Transaction.builder()
        .withId('txn_orphan')
        .withIdempotencyKey('key-orphan-1')
        .from(overrides.senderId ?? alice.id)
        .to(overrides.receiverId ?? bob.id)
        .fundedBy(overrides.sourceId ?? core.sources.findWalletSource(alice.id)!.id, PaymentSourceType.WALLET)
        .forAmount(Money.fromRupees(1))
        .build();

    assert.throws(() => core.parties.of(orphan({ sourceId: 'src_gone' })), fails(NotFoundError, 'SOURCE_NOT_FOUND'));
    assert.throws(() => core.parties.of(orphan({ senderId: 'usr_gone' })), fails(NotFoundError, 'USER_NOT_FOUND'));
    assert.throws(() => core.parties.of(orphan({ receiverId: 'usr_gone' })), fails(NotFoundError, 'USER_NOT_FOUND'));
  });

  test('strategyFor picks the strategy registered for the kind of source', () => {
    const alice = core.newUser();
    const wallet = core.sources.findWalletSource(alice.id)!;
    const bank = core.linkBank(alice);

    assert.ok(core.parties.strategyFor(wallet) instanceof WalletPaymentStrategy);
    // This slice registers no bank strategy: the factory refuses instead of guessing.
    assert.throws(() => core.parties.strategyFor(bank), fails(ValidationError, 'UNSUPPORTED_PAYMENT_METHOD'));

    const none = new PartyResolver(core.users, core.sources, new PaymentStrategyFactory());
    assert.throws(() => none.strategyFor(wallet), fails(ValidationError, 'UNSUPPORTED_PAYMENT_METHOD'));
  });
});

// ---------------------------------------------------------------------------------------------
describe('outbox in the running application', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  afterEach(() => app.chaos.reset());

  after(() => closeApp(app));

  const pendingEvents = () =>
    primaryOf(app).get<{ n: number }>('SELECT COUNT(*) AS n FROM transaction_events WHERE published_at IS NULL')!.n;

  test('after every kind of outcome, no event is left unpublished', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = await fund(app, alice, 500);
    const paid = await pay(app, alice, bob, 100); //                       success
    await pay(app, alice, bob, 9_000); //                                  refused
    await app.refunds.refund(paid.result.transaction.id, bob); //          refunded
    app.chaos.update({ failNextCredit: true });
    await pay(app, alice, bob, 50, { sourceId: bank.id }); //              saga: failed, then refunded
    await assert.rejects(pay(app, alice, 'ghost@miniupi', 1)); //          never recorded

    assert.equal(pendingEvents(), 0);
    const total = primaryOf(app).get<{ n: number }>('SELECT COUNT(*) AS n FROM transaction_events')!.n;
    assert.ok(total >= 14, `expected the events of five transactions, found ${total}`);
  });

  test('every committed state change reaches the observers exactly once: one notification per event and channel', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 500);
    const paid = await pay(app, alice, bob, 100);
    await app.refunds.refund(paid.result.transaction.id, bob);
    await app.settle();

    const titles = (user: typeof alice) =>
      notificationsFor(app, user, paid.result.transaction.id)
        .map((n) => `${n.title}/${n.channel}`)
        .sort();
    assert.deepEqual(titles(alice), ['Payment sent/PUSH', 'Payment sent/SMS', 'Refund received/PUSH', 'Refund received/SMS']);
    assert.deepEqual(titles(bob), ['Money received/PUSH', 'Money received/SMS', 'Payment refunded/PUSH', 'Payment refunded/SMS']);
  });

  test('the audit trail read by clients is the same table the outbox publishes from', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, alice, 300, { sourceId: bank.id });

    const rows = primaryOf(app).all<{ to_status: string; published_at: string | null }>(
      'SELECT to_status, published_at FROM transaction_events WHERE transaction_id = ? ORDER BY id',
      result.transaction.id,
    );
    assert.deepEqual(
      rows.map((row) => row.to_status),
      app.queries.details(result.transaction.id, alice.id, true).data.timeline.map((step) => step.to),
    );
    for (const row of rows) assert.ok(row.published_at, `${row.to_status} was published`);
  });

  test('an event left unpublished by hand is not announced by later, unrelated payments', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 500);
    const stuck = await pay(app, alice, bob, 100);
    await app.settle();
    // As if the process had died between the commit and the relay of this SUCCESS.
    writerOf(app).run(
      `UPDATE transaction_events SET published_at = NULL WHERE transaction_id = ? AND to_status = 'SUCCESS'`,
      stuck.result.transaction.id,
    );
    const before = notificationsFor(app, bob, stuck.result.transaction.id).length;

    await pay(app, alice, bob, 10);
    await app.settle();

    assert.equal(pendingEvents(), 1, 'it waits for the start-up relay; request-time relays only handle their own transaction');
    assert.equal(notificationsFor(app, bob, stuck.result.transaction.id).length, before);
    writerOf(app).run(`UPDATE transaction_events SET published_at = created_at WHERE published_at IS NULL`);
  });
});
