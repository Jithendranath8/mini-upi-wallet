import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { IllegalStateTransitionError } from '../src/domain/errors';
import type { User } from '../src/domain/User';
import {
  balanceOf,
  closeApp,
  createTestApp,
  fund,
  ledgerOf,
  linkBank,
  pay,
  primaryOf,
  registerUser,
  storedBalanceOf,
  timelineOf,
  verifyLedger,
} from './helpers';

const assertLedgerHealthy = (app: Application) => {
  const audit = verifyLedger(app);
  assert.deepEqual(
    { healthy: audit.healthy, chainIntact: audit.chainIntact, unbalanced: audit.unbalancedTransactions, mismatches: audit.walletMismatches },
    { healthy: true, chainIntact: true, unbalanced: [], mismatches: [] },
  );
};

const noNegativeBalances = (app: Application) => {
  const negative = primaryOf(app).all<{ id: string }>('SELECT id FROM wallets WHERE balance_paise < 0');
  assert.deepEqual(negative, []);
};

describe('double-spend prevention', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  const scenarios = [
    { balance: 1_000, amount: 300, requests: 10 },
    { balance: 500, amount: 500, requests: 20 },
    { balance: 99.99, amount: 33.33, requests: 7 },
    { balance: 10, amount: 10.01, requests: 5 },
    { balance: 50, amount: 0.5, requests: 150 },
  ];

  for (const { balance, amount, requests } of scenarios) {
    const balancePaise = Math.round(balance * 100);
    const amountPaise = Math.round(amount * 100);
    const affordable = Math.min(requests, Math.floor(balancePaise / amountPaise));

    test(`${requests} concurrent payments of Rs ${amount} from a Rs ${balance} wallet: exactly ${affordable} succeed`, async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, balance);

      const outcomes = await Promise.all(Array.from({ length: requests }, () => pay(app, alice, bob, amount)));

      const succeeded = outcomes.filter((o) => o.result.transaction.status === 'SUCCESS');
      const failed = outcomes.filter((o) => o.result.transaction.status === 'FAILED');
      assert.equal(succeeded.length, affordable);
      assert.equal(failed.length, requests - affordable);
      assert.equal(new Set(outcomes.map((o) => o.result.transaction.id)).size, requests, 'every request is its own transaction');

      for (const outcome of succeeded) assert.equal(outcome.result.error, undefined);
      for (const outcome of failed) {
        assert.equal(outcome.result.error?.code, 'INSUFFICIENT_BALANCE');
        assert.equal(outcome.result.error?.category, 'RULE_VIOLATION');
        assert.equal(outcome.result.transaction.failureCode, 'INSUFFICIENT_BALANCE');
        assert.deepEqual(ledgerOf(app, outcome.result.transaction.id), [], 'a rejected payment writes nothing to the ledger');
      }

      const spent = affordable * amountPaise;
      assert.equal(balanceOf(app, alice), balancePaise - spent);
      assert.equal(storedBalanceOf(app, alice), balancePaise - spent);
      assert.ok(storedBalanceOf(app, alice) >= 0, 'the balance never went negative');
      assert.equal(balanceOf(app, bob), spent);
      noNegativeBalances(app);
      assertLedgerHealthy(app);
    });
  }

  test('concurrent payments to different receivers cannot overdraw either', async () => {
    const alice = registerUser(app);
    const receivers = Array.from({ length: 6 }, () => registerUser(app));
    await fund(app, alice, 1_000);

    const outcomes = await Promise.all(receivers.map((receiver) => pay(app, alice, receiver, 400)));

    assert.equal(outcomes.filter((o) => o.result.transaction.status === 'SUCCESS').length, 2);
    assert.equal(outcomes.filter((o) => o.result.error?.code === 'INSUFFICIENT_BALANCE').length, 4);
    assert.equal(balanceOf(app, alice), 20_000);
    assert.equal(
      receivers.reduce((sum, receiver) => sum + balanceOf(app, receiver), 0),
      80_000,
    );
    assertLedgerHealthy(app);
  });

  test('payments are served first come, first served: the earliest requests are the ones that succeed', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 300);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => pay(app, alice, bob, 100)));
    assert.deepEqual(
      outcomes.map((o) => o.result.transaction.status),
      ['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILED', 'FAILED', 'FAILED'],
    );
  });

  test('the payer lock is contended and released: nothing is left held or waiting', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const before = app.system.snapshot().locks;
    await Promise.all(Array.from({ length: 5 }, () => pay(app, alice, bob, 10)));
    const locks = app.system.snapshot().locks;
    assert.equal(locks.acquired - before.acquired, 5);
    assert.equal(locks.contended - before.contended, 4);
    assert.equal(locks.heldNow, 0);
    assert.equal(locks.waitingNow, 0);
    assert.equal(locks.timeouts, before.timeouts);
  });
});

describe('concurrent activity on several wallets', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  test('two users paying each other at the same time neither deadlock nor lose money', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    await fund(app, bob, 1_000);

    const outcomes = await Promise.all([
      ...Array.from({ length: 15 }, () => pay(app, alice, bob, 30)),
      ...Array.from({ length: 15 }, () => pay(app, bob, alice, 20)),
    ]);

    for (const outcome of outcomes) assert.equal(outcome.result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, alice), 100_000 - 15 * 3_000 + 15 * 2_000);
    assert.equal(balanceOf(app, bob), 100_000 + 15 * 3_000 - 15 * 2_000);
    assertLedgerHealthy(app);
  });

  test('many senders paying one receiver at once: every credit lands', async () => {
    const receiver = registerUser(app);
    const senders = Array.from({ length: 12 }, () => registerUser(app));
    for (const sender of senders) await fund(app, sender, 100);

    const outcomes = await Promise.all(senders.map((sender) => pay(app, sender, receiver, 75.25)));

    for (const outcome of outcomes) assert.equal(outcome.result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, receiver), 12 * 7_525);
    for (const sender of senders) assert.equal(balanceOf(app, sender), 2_475);
    assertLedgerHealthy(app);
  });

  test('a storm of mixed payments conserves the total and keeps the ledger consistent', async () => {
    const users = Array.from({ length: 5 }, () => registerUser(app));
    for (const user of users) await fund(app, user, 200);
    const total = 5 * 20_000;

    // Deterministic pseudo-random plan so a failure can be reproduced.
    let seed = 20_261_117;
    const next = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    const plan = Array.from({ length: 120 }, () => {
      const from = next(5);
      const to = (from + 1 + next(4)) % 5;
      return { from: users[from], to: users[to], rupees: (1 + next(15_000)) / 100 };
    });

    const outcomes = await Promise.all(plan.map(({ from, to, rupees }) => pay(app, from, to, rupees)));

    const statuses = new Set(outcomes.map((o) => o.result.transaction.status));
    assert.ok(statuses.has('SUCCESS'));
    for (const outcome of outcomes) {
      const { status, id } = outcome.result.transaction;
      assert.ok(status === 'SUCCESS' || status === 'FAILED', `unexpected status ${status}`);
      assert.equal(ledgerOf(app, id).length, status === 'SUCCESS' ? 2 : 0);
      if (status === 'FAILED') assert.equal(outcome.result.error?.code, 'INSUFFICIENT_BALANCE');
    }
    assert.equal(
      users.reduce((sum, user) => sum + storedBalanceOf(app, user), 0),
      total,
      'money was neither created nor destroyed',
    );
    for (const user of users) assert.equal(balanceOf(app, user), storedBalanceOf(app, user), 'cache and database agree');
    noNegativeBalances(app);
    assertLedgerHealthy(app);
  });

  test('five concurrent refunds of one payment: exactly one goes through', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 500);
    const { result } = await pay(app, alice, bob, 200);

    // The receiver double-clicks "refund" five times.
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => app.refunds.refund(result.transaction.id, bob)));

    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof IllegalStateTransitionError);
    }
    assert.equal(balanceOf(app, alice), 50_000, 'refunded once, not five times');
    assert.equal(balanceOf(app, bob), 0);
    assert.equal(ledgerOf(app, result.transaction.id).length, 4);
    assertLedgerHealthy(app);
  });

  test('refunds in opposite directions between the same two users do not deadlock', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 500);
    await fund(app, bob, 500);
    const toBob = await pay(app, alice, bob, 100);
    const toAlice = await pay(app, bob, alice, 40);

    // Each refund needs both wallets' locks; they are always taken in the same order.
    const [first, second] = await Promise.all([
      app.refunds.refund(toBob.result.transaction.id, bob),
      app.refunds.refund(toAlice.result.transaction.id, alice),
      ...Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? pay(app, alice, bob, 1) : pay(app, bob, alice, 1))),
    ]);
    assert.equal(first.status, 'REFUNDED');
    assert.equal(second.status, 'REFUNDED');
    assert.equal(balanceOf(app, alice), 50_000);
    assert.equal(balanceOf(app, bob), 50_000);
    assert.equal(app.system.snapshot().locks.heldNow, 0);
    assertLedgerHealthy(app);
  });

  test('a refund racing the receiver spending the same money: one wins, nothing goes negative', async () => {
    const run = async (refundFirst: boolean) => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const carol = registerUser(app);
      await fund(app, alice, 500);
      const { result } = await pay(app, alice, bob, 500);

      const refund = () => app.refunds.refund(result.transaction.id, bob);
      const spend = () => pay(app, bob, carol, 500);
      const [first, second] = await Promise.allSettled(refundFirst ? [refund(), spend()] : [spend(), refund()]);
      const refundOutcome = refundFirst ? first : second;
      const spendOutcome = refundFirst ? second : first;

      assert.equal(spendOutcome.status, 'fulfilled');
      const spent =
        spendOutcome.status === 'fulfilled' &&
        (spendOutcome.value as Awaited<ReturnType<typeof spend>>).result.transaction.status === 'SUCCESS';
      const refunded = refundOutcome.status === 'fulfilled';
      assert.notEqual(spent, refunded, 'exactly one of the two may use the money');

      assert.equal(balanceOf(app, bob), 0);
      assert.equal(balanceOf(app, alice), refunded ? 50_000 : 0);
      assert.equal(balanceOf(app, carol), spent ? 50_000 : 0);
      noNegativeBalances(app);
      assertLedgerHealthy(app);
    };
    await run(true);
    await run(false);
  });
});

describe('payments queue behind the payer lock while the database round trip is in flight', () => {
  test('with a slow database, concurrent payments are still serialised and cannot overdraw', async () => {
    const app = await createTestApp({ databaseLatencyMs: 3 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 100);
      const before = app.system.snapshot().locks;

      const started = Date.now();
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => pay(app, alice, bob, 30)));
      const elapsed = Date.now() - started;

      assert.equal(outcomes.filter((o) => o.result.transaction.status === 'SUCCESS').length, 3);
      assert.equal(outcomes.filter((o) => o.result.error?.code === 'INSUFFICIENT_BALANCE').length, 5);
      assert.equal(balanceOf(app, alice), 1_000);
      assert.equal(balanceOf(app, bob), 9_000);
      assert.equal(app.system.snapshot().locks.contended - before.contended, 7, 'seven payments waited for the lock');
      assert.ok(elapsed >= 12, `eight 3 ms round trips were taken one after another, not at once (${elapsed} ms)`);
      assertLedgerHealthy(app);
    } finally {
      await closeApp(app);
    }
  });
});

describe('lock timeout', () => {
  test('a payment that cannot get the payer lock in time is recorded as FAILED with LOCK_TIMEOUT', async () => {
    const app = await createTestApp({ lockTimeoutMs: 20, gatewayLatencyMs: 100 });
    try {
      const alice: User = registerUser(app);
      const bank = linkBank(app, alice);

      const [slow, impatient] = await Promise.all([
        pay(app, alice, alice, 100, { sourceId: bank.id }),
        pay(app, alice, alice, 100, { sourceId: bank.id }),
      ]);

      assert.equal(slow.result.transaction.status, 'SUCCESS');
      assert.equal(impatient.result.transaction.status, 'FAILED');
      assert.equal(impatient.result.error?.code, 'LOCK_TIMEOUT');
      assert.equal(impatient.result.error?.category, 'UNAVAILABLE');
      assert.equal(impatient.result.transaction.failureCode, 'LOCK_TIMEOUT');
      assert.deepEqual(
        timelineOf(app, impatient.result.transaction.id, alice),
        ['INITIATED', 'FAILED'],
        'it never reached PROCESSING',
      );
      assert.deepEqual(ledgerOf(app, impatient.result.transaction.id), []);
      assert.equal(balanceOf(app, alice), 10_000, 'only the payment that held the lock moved money');
      assert.equal(app.system.snapshot().locks.timeouts, 1);
      assert.equal(app.system.snapshot().locks.heldNow, 0);
      assertLedgerHealthy(app);
    } finally {
      await closeApp(app);
    }
  });
});
