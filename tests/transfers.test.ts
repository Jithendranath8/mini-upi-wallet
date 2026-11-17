import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { NotificationChannelType } from '../src/domain/enums';
import { DomainError, NotFoundError, ValidationError } from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import {
  balanceOf,
  closeApp,
  createTestApp,
  freezeClock,
  fund,
  keepAlive,
  ledgerOf,
  linkBank,
  linkCard,
  notificationsFor,
  pay,
  primaryOf,
  registerUser,
  sleep,
  storedBalanceOf,
  timelineOf,
  uniqueKey,
  verifyLedger,
} from './helpers';

const rejectsWith = (type: new (...args: never[]) => DomainError, code: string) => (error: unknown) => {
  assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
};

describe('wallet-to-wallet transfer', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  test('moves the amount from the sender to the receiver, in paise', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);

    const { result, replayed } = await pay(app, alice, bob, 250.5, { note: 'Lunch' });

    assert.equal(replayed, false);
    assert.equal(result.error, undefined);
    const txn = result.transaction;
    assert.match(txn.id, /^txn_[0-9a-f]{16}$/);
    assert.equal(txn.status, 'SUCCESS');
    assert.equal(txn.type, 'P2P');
    assert.equal(txn.amountPaise, 25_050);
    assert.equal(txn.amount, 250.5);
    assert.deepEqual(txn.sender, { id: alice.id, name: alice.name, upiId: alice.upiId });
    assert.deepEqual(txn.receiver, { id: bob.id, name: bob.name, upiId: bob.upiId });
    assert.equal(txn.source.type, 'WALLET');
    assert.equal(txn.note, 'Lunch');
    assert.equal(txn.failureCode, null);
    assert.equal(txn.failureReason, null);

    assert.equal(balanceOf(app, alice), 100_000 - 25_050);
    assert.equal(balanceOf(app, bob), 25_050);
    assert.equal(storedBalanceOf(app, alice), 74_950, 'the cached balance agrees with the database');
    assert.equal(storedBalanceOf(app, bob), 25_050);
  });

  test('writes exactly two ledger entries: a debit and a credit of the same amount, hash chained', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const { result } = await pay(app, alice, bob, 250.5);

    const entries = ledgerOf(app, result.transaction.id);
    assert.equal(entries.length, 2);
    const [debit, credit] = entries;

    assert.equal(debit.entryType, 'DEBIT');
    assert.equal(debit.accountId, `WALLET:${app.users.walletOf(alice.id).id}`);
    assert.equal(debit.amount, 250.5);
    assert.equal(debit.balanceAfter, 749.5);
    assert.equal(debit.description, `Paid to ${bob.upiId}`);

    assert.equal(credit.entryType, 'CREDIT');
    assert.equal(credit.accountId, `WALLET:${app.users.walletOf(bob.id).id}`);
    assert.equal(credit.amount, 250.5);
    assert.equal(credit.balanceAfter, 250.5);
    assert.equal(credit.description, `Received from ${alice.upiId}`);

    assert.equal(credit.prevHash, debit.hash, 'each entry commits to the one before it');
    assert.equal(credit.sequence, debit.sequence! + 1);
    assert.equal(verifyLedger(app).healthy, true);
  });

  test('goes through INITIATED -> PROCESSING -> SUCCESS', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 500);
    const { result } = await pay(app, alice, bob, 100);

    const { timeline } = app.queries.details(result.transaction.id, alice.id, true).data;
    assert.deepEqual(
      timeline.map(({ from, to }) => [from, to]),
      [
        [null, 'INITIATED'],
        ['INITIATED', 'PROCESSING'],
        ['PROCESSING', 'SUCCESS'],
      ],
    );
    for (const step of timeline) assert.ok(step.detail.length > 0);
    assert.deepEqual(timelineOf(app, result.transaction.id, bob), ['INITIATED', 'PROCESSING', 'SUCCESS'], 'the receiver sees the same timeline');
  });

  test('notifies both parties on every one of their channels once the queue has drained', async () => {
    const alice = registerUser(app); // default channels: SMS + PUSH
    const bob = registerUser(app, {
      email: 'bob@example.com',
      notificationChannels: [NotificationChannelType.SMS, NotificationChannelType.PUSH, NotificationChannelType.EMAIL],
    });
    await fund(app, alice, 500);
    const { result } = await pay(app, alice, bob, 120);

    await app.settle();

    const sent = notificationsFor(app, alice, result.transaction.id);
    assert.deepEqual(sent.map((n) => n.channel).sort(), ['PUSH', 'SMS']);
    for (const notification of sent) {
      assert.equal(notification.title, 'Payment sent');
      assert.equal(notification.status, 'SENT');
      assert.equal(notification.attempts, 1);
      assert.match(notification.body, /₹120\.00/);
      assert.ok(notification.body.includes(bob.upiId));
    }

    const received = notificationsFor(app, bob, result.transaction.id);
    assert.deepEqual(received.map((n) => n.channel).sort(), ['EMAIL', 'PUSH', 'SMS']);
    for (const notification of received) {
      assert.equal(notification.title, 'Money received');
      assert.equal(notification.status, 'SENT');
      assert.ok(notification.body.includes(alice.upiId));
    }
  });

  test('a user without an email address is simply not emailed', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app, { notificationChannels: [NotificationChannelType.EMAIL, NotificationChannelType.SMS] });
    await fund(app, alice, 500);
    const { result } = await pay(app, alice, bob, 50);
    await app.settle();

    assert.deepEqual(
      notificationsFor(app, bob, result.transaction.id).map((n) => n.channel),
      ['SMS'],
    );
  });

  test('a payment is not slowed down by its notifications: they are still queued when transfer() returns', async () => {
    const slow = await createTestApp({ notificationLatencyMs: 40 });
    try {
      const alice = registerUser(slow);
      const bob = registerUser(slow);
      await fund(slow, alice, 500);
      await slow.settle();

      const { result } = await pay(slow, alice, bob, 50);
      assert.equal(result.transaction.status, 'SUCCESS');
      assert.deepEqual(notificationsFor(slow, bob, result.transaction.id), [], 'nothing delivered yet');

      await slow.settle();
      assert.equal(notificationsFor(slow, bob, result.transaction.id).length, 2);
    } finally {
      await closeApp(slow);
    }
  });

  test('keeps paise exact: one paisa, and ten payments of 10 paise', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1.01);

    const single = await pay(app, alice, bob, 0.01);
    assert.equal(single.result.transaction.amountPaise, 1);
    for (let i = 0; i < 10; i += 1) {
      const { result } = await pay(app, alice, bob, 0.1);
      assert.equal(result.transaction.status, 'SUCCESS');
    }
    assert.equal(balanceOf(app, alice), 0);
    assert.equal(balanceOf(app, bob), 101);
  });

  test('the whole balance can be sent, leaving exactly zero', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 777.77);
    const { result } = await pay(app, alice, bob, 777.77);
    assert.equal(result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, alice), 0);
    assert.equal(balanceOf(app, bob), 77_777);
  });

  test('money is conserved across a chain of payments', async () => {
    const [a, b, c] = [registerUser(app), registerUser(app), registerUser(app)];
    await fund(app, a, 1_000);
    await pay(app, a, b, 400);
    await pay(app, b, c, 150);
    await pay(app, c, a, 25.25);
    await pay(app, b, a, 250);

    assert.equal(balanceOf(app, a), 100_000 - 40_000 + 2_525 + 25_000);
    assert.equal(balanceOf(app, b), 40_000 - 15_000 - 25_000);
    assert.equal(balanceOf(app, c), 15_000 - 2_525);
    assert.equal(balanceOf(app, a) + balanceOf(app, b) + balanceOf(app, c), 100_000);
    assert.equal(verifyLedger(app).healthy, true);
  });

  test('finds the receiver whatever the case or padding of the UPI ID', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const { result } = await pay(app, alice, `  ${bob.upiId.toUpperCase()}  `, 10);
    assert.equal(result.transaction.status, 'SUCCESS');
    assert.equal(result.transaction.receiver.id, bob.id);
  });

  test('stores a note with unicode, emoji and SQL metacharacters verbatim', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const note = `Chai ☕ & समोसा'); DROP TABLE users;-- "50%"`;
    const { result } = await pay(app, alice, bob, 10, { note });
    assert.equal(result.transaction.status, 'SUCCESS');
    assert.equal(app.queries.details(result.transaction.id, alice.id, true).data.transaction.note, note);
    assert.equal(app.users.list().some((user) => user.id === alice.id), true, 'the users table is still there');
  });

  test('both parties see the payment in their history, newest first', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const first = await pay(app, alice, bob, 10);
    const second = await pay(app, alice, bob, 20);

    const bobs = app.queries.history(bob.id, 10, true).data;
    assert.deepEqual(new Set(bobs.map((txn) => txn.id)), new Set([first.result.transaction.id, second.result.transaction.id]));
    const alices = app.queries.history(alice.id, 10, true).data;
    assert.equal(alices.length, 3, 'top-up plus two payments');
    assert.equal(app.queries.history(alice.id, 2, true).data.length, 2, 'the limit is honoured');
    for (let i = 1; i < alices.length; i += 1) {
      assert.ok(alices[i - 1].createdAt >= alices[i].createdAt, 'sorted newest first');
    }
  });

  test('the history view agrees with what transfer() returned', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const { result } = await pay(app, alice, bob, 42.42, { note: 'books' });
    const stored = app.queries.details(result.transaction.id, alice.id, true).data.transaction;
    assert.deepEqual(stored, result.transaction);
  });
});

describe('transfer requests that are rejected before anything is recorded', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  const transactionCount = () => primaryOf(app).get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')!.n;

  test('an unknown receiver is a NotFoundError and leaves no transaction behind', async () => {
    const alice = registerUser(app);
    await fund(app, alice, 100);
    const before = transactionCount();
    await assert.rejects(pay(app, alice, 'nobody@miniupi', 10), rejectsWith(NotFoundError, 'RECEIVER_NOT_FOUND'));
    assert.equal(transactionCount(), before);
    assert.equal(balanceOf(app, alice), 10_000);
  });

  test('an unknown sender is a NotFoundError', async () => {
    const bob = registerUser(app);
    await assert.rejects(
      app.transfers.transfer({
        idempotencyKey: uniqueKey(),
        senderId: 'usr_does_not_exist',
        receiverUpiId: bob.upiId,
        amount: Money.fromRupees(10),
      }),
      rejectsWith(NotFoundError, 'USER_NOT_FOUND'),
    );
  });

  test("someone else's payment source is reported as not found, never as forbidden", async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bobsBank = await fund(app, bob, 100);
    const before = transactionCount();
    await assert.rejects(pay(app, alice, bob, 10, { sourceId: bobsBank.id }), rejectsWith(NotFoundError, 'SOURCE_NOT_FOUND'));
    await assert.rejects(pay(app, alice, bob, 10, { sourceId: 'src_does_not_exist' }), rejectsWith(NotFoundError, 'SOURCE_NOT_FOUND'));
    assert.equal(transactionCount(), before);
  });

  test('a zero amount is a ValidationError', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await assert.rejects(pay(app, alice, bob, 0), rejectsWith(ValidationError, 'INVALID_AMOUNT'));
  });

  test('a note longer than 80 characters is a ValidationError', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    await assert.rejects(pay(app, alice, bob, 10, { note: 'x'.repeat(81) }), rejectsWith(ValidationError, 'NOTE_TOO_LONG'));
    const { result } = await pay(app, alice, bob, 10, { note: 'x'.repeat(80) });
    assert.equal(result.transaction.status, 'SUCCESS');
  });
});

describe('what each party may see of a payment', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  test('the payer sees which of their accounts funded the payment; the receiver only learns its kind', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, bob, 500, { sourceId: bank.id });

    const forPayer = app.queries.details(result.transaction.id, alice.id, true).data.transaction;
    assert.deepEqual(forPayer.source, { id: bank.id, type: 'BANK_ACCOUNT', label: 'Test Bank XXXX9012' });

    const forReceiver = app.queries.details(result.transaction.id, bob.id, true).data.transaction;
    assert.deepEqual(forReceiver.source, { id: '', type: 'BANK_ACCOUNT', label: 'Bank account' });
    for (const leak of ['XXXX9012', 'Test Bank']) {
      assert.equal(JSON.stringify(forReceiver).includes(leak), false, 'neither the bank name nor the last four digits leak');
    }
    assert.equal(JSON.stringify(forReceiver).includes(bank.id), false);

    // Everything else is the same for both.
    assert.deepEqual({ ...forReceiver, source: forPayer.source }, forPayer);
  });

  test('the same redaction applies to the history list', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const card = linkCard(app, alice);
    await pay(app, alice, bob, 100, { sourceId: card.id });
    await fund(app, bob, 50);
    await pay(app, bob, alice, 20);

    const bobs = app.queries.history(bob.id, 10, true).data;
    const incoming = bobs.find((txn) => txn.sender.id === alice.id)!;
    assert.deepEqual(incoming.source, { id: '', type: 'CARD', label: 'Card' });
    const outgoing = bobs.find((txn) => txn.sender.id === bob.id && txn.receiver.id === alice.id)!;
    assert.equal(outgoing.source.label, 'Wallet balance', 'his own payment shows his own source in full');
    assert.notEqual(outgoing.source.id, '');

    const alices = app.queries.history(alice.id, 10, true).data;
    assert.deepEqual(alices.find((txn) => txn.sender.id === bob.id)!.source, { id: '', type: 'WALLET', label: 'Wallet' });
    assert.equal(alices.find((txn) => txn.receiver.id === bob.id)!.source.label, 'Visa card •••• 1111');
  });

  test("each party sees their own ledger line in full and the other party's without account id or balance", async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    await fund(app, bob, 77);
    const { result } = await pay(app, alice, bob, 250);
    const aliceWallet = `WALLET:${app.users.walletOf(alice.id).id}`;
    const bobWallet = `WALLET:${app.users.walletOf(bob.id).id}`;

    const [aliceDebit, aliceSeesCredit] = app.queries.details(result.transaction.id, alice.id, true).data.ledger;
    assert.equal(aliceDebit.accountId, aliceWallet);
    assert.equal(aliceDebit.balanceAfter, 750);
    assert.equal(aliceDebit.description, `Paid to ${bob.upiId}`);
    assert.equal(aliceSeesCredit.accountId, 'WALLET:(other party)');
    assert.equal(aliceSeesCredit.balanceAfter, null, "the payer must not learn the receiver's balance (Rs 327)");
    assert.equal(aliceSeesCredit.description, 'Credited to the other party');
    assert.equal(aliceSeesCredit.amount, 250);
    assert.equal(aliceSeesCredit.entryType, 'CREDIT');

    const [bobSeesDebit, bobCredit] = app.queries.details(result.transaction.id, bob.id, true).data.ledger;
    assert.equal(bobSeesDebit.accountId, 'WALLET:(other party)');
    assert.equal(bobSeesDebit.balanceAfter, null, "the receiver must not learn the payer's balance (Rs 750)");
    assert.equal(bobSeesDebit.description, 'Debited from the other party');
    assert.equal(bobCredit.accountId, bobWallet);
    assert.equal(bobCredit.balanceAfter, 327);

    for (const [viewer, otherWallet] of [
      [alice, bobWallet],
      [bob, aliceWallet],
    ] as const) {
      const text = JSON.stringify(app.queries.details(result.transaction.id, viewer.id, true).data);
      assert.equal(text.includes(otherWallet), false, "the other party's wallet id is not in the response");
    }
  });

  test('a bank-funded payment hides the external account from the receiver', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, bob, 400, { sourceId: bank.id });

    const forReceiver = app.queries.details(result.transaction.id, bob.id, true).data.ledger;
    assert.equal(forReceiver[0].accountId, 'EXTERNAL:(other party)');
    assert.equal(forReceiver[0].description, 'Debited from the other party');
    assert.equal(forReceiver[1].balanceAfter, 400);

    const forPayer = app.queries.details(result.transaction.id, alice.id, true).data.ledger;
    assert.equal(forPayer[0].accountId, `EXTERNAL:${bank.id}`);
    assert.match(forPayer[0].description, /Test Bank XXXX9012/);
    assert.equal(forPayer[1].accountId, 'WALLET:(other party)');
    assert.equal(forPayer[1].balanceAfter, null);
  });

  test('in a top-up the user is both parties and sees everything', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, alice, 300, { sourceId: bank.id });
    const { ledger, transaction } = app.queries.details(result.transaction.id, alice.id, true).data;
    assert.equal(transaction.source.id, bank.id);
    assert.equal(ledger[0].accountId, `EXTERNAL:${bank.id}`);
    assert.equal(ledger[1].accountId, `WALLET:${app.users.walletOf(alice.id).id}`);
    assert.equal(ledger[1].balanceAfter, 300);
  });

  test('someone who is not a party sees nothing at all: NotFoundError', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const mallory = registerUser(app);
    await fund(app, alice, 100);
    const { result } = await pay(app, alice, bob, 10);

    for (const strong of [true, false]) {
      assert.throws(
        () => app.queries.details(result.transaction.id, mallory.id, strong),
        rejectsWith(NotFoundError, 'TRANSACTION_NOT_FOUND'),
      );
    }
    assert.deepEqual(app.queries.history(mallory.id, 10, true).data, []);
  });
});

describe('notifications are best effort and never hold a payment back', () => {
  test('with the provider failing every time, the payment still succeeds and the failure is recorded', async () => {
    const app = await createTestApp({ queueMaxAttempts: 2, queueBackoffBaseMs: 2 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      await app.settle();
      app.chaos.update({ notificationFailureRate: 1 });

      const { result } = await pay(app, alice, bob, 100);
      assert.equal(result.transaction.status, 'SUCCESS');
      assert.equal(balanceOf(app, bob), 10_000);

      await keepAlive(app.settle()); // waits for the retries (unref'd timers) to run out
      const undelivered = notificationsFor(app, bob, result.transaction.id);
      assert.equal(undelivered.length, 2, 'one record per channel, not one per attempt');
      for (const notification of undelivered) {
        assert.equal(notification.status, 'FAILED');
        assert.equal(notification.attempts, 2);
        assert.equal(notification.title, 'Money received');
      }
      assert.equal(app.system.snapshot().deadLetters, 4, 'two for the sender, two for the receiver');
      assert.equal(app.system.snapshot().queue.notifications.deadLettered, 4);

      // The provider recovers and the operator redrives the dead letters.
      app.chaos.update({ notificationFailureRate: 0 });
      assert.equal(app.system.redriveDeadLetters(), 4);
      await keepAlive(app.settle());

      const delivered = notificationsFor(app, bob, result.transaction.id);
      assert.equal(delivered.length, 2, 'the same notifications were updated, not duplicated');
      for (const notification of delivered) {
        assert.equal(notification.status, 'SENT');
        assert.equal(notification.attempts, 1);
      }
      assert.equal(app.system.snapshot().deadLetters, 0);
      assert.equal(app.system.redriveDeadLetters(), 0);
    } finally {
      await closeApp(app);
    }
  });

  test('a flaky provider is retried until the message gets through', async () => {
    const app = await createTestApp({ queueMaxAttempts: 30, queueBackoffBaseMs: 0 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      app.chaos.update({ notificationFailureRate: 0.5 });
      const { result } = await pay(app, alice, bob, 100);
      await keepAlive(app.settle());

      const notifications = [...notificationsFor(app, alice, result.transaction.id), ...notificationsFor(app, bob, result.transaction.id)];
      assert.equal(notifications.length, 4);
      for (const notification of notifications) assert.equal(notification.status, 'SENT');
      assert.equal(app.system.snapshot().deadLetters, 0);
    } finally {
      await closeApp(app);
    }
  });
});

describe('history is read one page at a time (keyset pagination)', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  /** Walks the whole history of a user, `limit` rows at a time. */
  const walk = (userId: string, limit: number) => {
    const pages: string[][] = [];
    let cursor: string | null | undefined;
    do {
      const page = app.queries.history(userId, limit, true, cursor ?? undefined);
      pages.push(page.data.map((txn) => txn.id));
      cursor = page.nextCursor;
    } while (cursor);
    return pages;
  };

  test('nextCursor leads to the next older page; the last page has none', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    for (let i = 1; i <= 6; i += 1) await pay(app, alice, bob, i);
    const everything = app.queries.history(alice.id, 100, true);
    assert.equal(everything.data.length, 7);
    assert.equal(everything.nextCursor, null);

    const first = app.queries.history(alice.id, 3, true);
    assert.equal(typeof first.nextCursor, 'string');
    const second = app.queries.history(alice.id, 3, true, first.nextCursor!);
    const third = app.queries.history(alice.id, 3, true, second.nextCursor!);

    assert.equal(third.nextCursor, null);
    assert.deepEqual(
      [...first.data, ...second.data, ...third.data].map((txn) => txn.id),
      everything.data.map((txn) => txn.id),
    );
  });

  test('transactions created in the same millisecond are still paged without overlap or loss', async (t) => {
    freezeClock(t); // every payment below gets the identical created_at
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    for (let i = 1; i <= 8; i += 1) await pay(app, alice, bob, i);
    const stamps = new Set(app.queries.history(alice.id, 100, true).data.map((txn) => txn.createdAt));
    assert.equal(stamps.size, 1, 'the test needs identical timestamps');

    for (const limit of [1, 2, 3, 4, 9, 10]) {
      const ids = walk(alice.id, limit).flat();
      assert.equal(ids.length, 9, `limit ${limit}`);
      assert.equal(new Set(ids).size, 9, `limit ${limit}: a transaction was repeated`);
    }
    assert.deepEqual(
      walk(alice.id, 4).map((page) => page.length),
      [4, 4, 1],
    );
  });

  test('the cursor is opaque but stable: the same page can be fetched again with the same cursor', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    for (let i = 1; i <= 4; i += 1) await pay(app, alice, bob, i);
    const first = app.queries.history(alice.id, 2, true);
    const once = app.queries.history(alice.id, 2, true, first.nextCursor!);
    await sleep(2); // a later millisecond: the new payment is unambiguously newer than the cursor
    await pay(app, alice, bob, 50);
    const again = app.queries.history(alice.id, 2, true, first.nextCursor!);
    assert.deepEqual(again.data, once.data);
    assert.equal(again.nextCursor, once.nextCursor);
  });

  test('a cursor that is not one of ours is a ValidationError INVALID_CURSOR', async () => {
    const alice = registerUser(app);
    for (const cursor of ['garbage', Buffer.from('not-a-date|txn_1').toString('base64url'), Buffer.from('|').toString('base64url')]) {
      assert.throws(() => app.queries.history(alice.id, 10, true, cursor), rejectsWith(ValidationError, 'INVALID_CURSOR'), cursor);
    }
  });

  test('pages can be read from the replica once it has caught up', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    await pay(app, alice, bob, 10);
    await pay(app, alice, bob, 20);
    await app.settle();

    const first = app.queries.history(alice.id, 2);
    assert.equal(first.servedBy, 'replica');
    const second = app.queries.history(alice.id, 2, false, first.nextCursor!);
    assert.equal(second.data.length, 1);
    assert.equal(second.nextCursor, null);
  });
});
