import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { BusinessRuleError, ForbiddenError } from '../src/domain/errors';
import type { User } from '../src/domain/User';
import type { IdempotentOutcome } from '../src/service/IdempotencyService';
import type { TransferResult } from '../src/service/TransferService';
import { type TransactionEvent, TransactionEventPublisher, type TransactionObserver } from '../src/events/TransactionEvents';
import { FraudEngine, type FraudRule } from '../src/validation/fraud';
import { type ValidationContext, ValidationHandler, ValidationPipeline } from '../src/validation/ValidationHandler';
import {
  balanceOf,
  closeApp,
  createTestApp,
  fund,
  ledgerOf,
  linkBank,
  linkCard,
  notificationsFor,
  pay,
  registerUser,
  storedBalanceOf,
  timelineOf,
  verifyLedger,
  writerOf,
} from './helpers';

/** A payment that was accepted, then refused by a rule: recorded as FAILED, with nothing moved. */
function assertRejected(
  app: Application,
  outcome: IdempotentOutcome<TransferResult>,
  sender: User,
  expected: { code: string; category: string },
): TransferResult {
  const { result } = outcome;
  assert.ok(result.error, 'expected the payment to be refused');
  assert.equal(result.error.code, expected.code);
  assert.equal(result.error.category, expected.category);
  assert.equal(result.transaction.status, 'FAILED');
  assert.equal(result.transaction.failureCode, expected.code);
  assert.equal(result.transaction.failureReason, result.error.message);
  assert.deepEqual(timelineOf(app, result.transaction.id, sender), ['INITIATED', 'PROCESSING', 'FAILED']);
  assert.deepEqual(ledgerOf(app, result.transaction.id), []);
  return result;
}

// ---------------------------------------------------------------------------------------------
describe('validation chain', () => {
  let app: Application;

  before(async () => {
    // Both fraud heuristics that depend on history are tested separately below.
    app = await createTestApp({ fraudNewPayeeThresholdRupees: 900_000 });
  });

  after(() => closeApp(app));

  test('the chain, fraud rules, strategies and observers are wired in the documented order', () => {
    assert.deepEqual(app.system.design(), {
      validationChain: ['Account status', 'Payment source', 'Available funds', 'Daily limit', 'Fraud rules'],
      fraudRules: ['Blacklisted payee', 'Payment velocity', 'High value to new payee'],
      paymentStrategies: ['WALLET', 'BANK_ACCOUNT', 'CARD'],
      observers: ['LifecycleTrace', 'Notifications', 'Metrics', 'CompensationRetry'],
    });
  });

  test('self transfer from the wallet -> SELF_TRANSFER', async () => {
    const alice = registerUser(app);
    await fund(app, alice, 500);
    const outcome = await pay(app, alice, alice, 100);
    assertRejected(app, outcome, alice, { code: 'SELF_TRANSFER', category: 'RULE_VIOLATION' });
    assert.equal(balanceOf(app, alice), 50_000);
  });

  test('paying yourself from a bank account is a top-up, not a self transfer', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, alice, 100, { sourceId: bank.id });
    assert.equal(result.error, undefined);
    assert.equal(result.transaction.type, 'TOPUP');
    assert.equal(result.transaction.status, 'SUCCESS');
  });

  test('insufficient balance -> INSUFFICIENT_BALANCE, with the shortfall in the details', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const outcome = await pay(app, alice, bob, 100.01);
    const result = assertRejected(app, outcome, alice, { code: 'INSUFFICIENT_BALANCE', category: 'RULE_VIOLATION' });
    assert.deepEqual(result.error?.details, { availablePaise: 10_000, requiredPaise: 10_001 });
    assert.equal(balanceOf(app, alice), 10_000);
    assert.equal(balanceOf(app, bob), 0);
  });

  test('an empty wallet cannot pay even one paisa', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const outcome = await pay(app, alice, bob, 0.01);
    assertRejected(app, outcome, alice, { code: 'INSUFFICIENT_BALANCE', category: 'RULE_VIOLATION' });
  });

  test('a refused payment tells the sender, and only the sender', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const outcome = await pay(app, alice, bob, 10);
    await app.settle();

    const notifications = notificationsFor(app, alice, outcome.result.transaction.id);
    assert.equal(notifications.length, 2, 'SMS and PUSH');
    for (const notification of notifications) {
      assert.equal(notification.title, 'Payment failed');
      assert.match(notification.body, /Wallet balance is too low/);
    }
    assert.deepEqual(notificationsFor(app, bob, outcome.result.transaction.id), []);
  });

  describe('daily limit', () => {
    test('payments up to the limit pass, the next paisa -> DAILY_LIMIT_EXCEEDED', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 500 });
      const bob = registerUser(app);
      await fund(app, alice, 2_000);

      assert.equal((await pay(app, alice, bob, 300)).result.transaction.status, 'SUCCESS');
      assert.equal((await pay(app, alice, bob, 200)).result.transaction.status, 'SUCCESS', 'exactly at the limit is allowed');

      const outcome = await pay(app, alice, bob, 0.01);
      const result = assertRejected(app, outcome, alice, { code: 'DAILY_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
      assert.deepEqual(result.error?.details, { limitPaise: 50_000, spentPaise: 50_000, requestedPaise: 1 });
      assert.equal(balanceOf(app, alice), 150_000);
      assert.equal(balanceOf(app, bob), 50_000);
    });

    test('a single payment above the limit is refused outright', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 500 });
      const bob = registerUser(app);
      await fund(app, alice, 2_000);
      const outcome = await pay(app, alice, bob, 500.01);
      const result = assertRejected(app, outcome, alice, { code: 'DAILY_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
      assert.deepEqual(result.error?.details, { limitPaise: 50_000, spentPaise: 0, requestedPaise: 50_001 });
    });

    test('refused payments do not use up the limit', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 500 });
      const bob = registerUser(app);
      await fund(app, alice, 2_000);
      await pay(app, alice, bob, 600); // refused
      await pay(app, alice, bob, 700); // refused
      assert.equal((await pay(app, alice, bob, 500)).result.transaction.status, 'SUCCESS');
    });

    test('top-ups and incoming money do not count towards the limit', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 500 });
      const bob = registerUser(app);
      await fund(app, alice, 5_000); // ten times the limit: a top-up is not a transfer
      await fund(app, bob, 5_000);
      assert.equal((await pay(app, bob, alice, 4_000)).result.transaction.status, 'SUCCESS');
      assert.equal((await pay(app, alice, bob, 500)).result.transaction.status, 'SUCCESS');
    });

    test('the limit is per sender, across all receivers', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 500 });
      const bob = registerUser(app);
      const carol = registerUser(app);
      await fund(app, alice, 2_000);
      await pay(app, alice, bob, 400);
      const outcome = await pay(app, alice, carol, 200);
      assertRejected(app, outcome, alice, { code: 'DAILY_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
    });

    test('a bank-funded payment to someone else counts towards the limit too', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 500 });
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      assert.equal((await pay(app, alice, bob, 500, { sourceId: bank.id })).result.transaction.status, 'SUCCESS');
      const outcome = await pay(app, alice, bob, 1, { sourceId: bank.id });
      assertRejected(app, outcome, alice, { code: 'DAILY_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
    });

    test('a refunded payment gives its share of the limit back', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 500 });
      const bob = registerUser(app);
      await fund(app, alice, 2_000);
      const { result } = await pay(app, alice, bob, 500);
      await app.refunds.refund(result.transaction.id, bob);
      assert.equal((await pay(app, alice, bob, 500)).result.transaction.status, 'SUCCESS');
    });
  });

  describe('per-transaction limit of the source', () => {
    test('wallet: exactly Rs 1,00,000 passes, one paisa more -> SOURCE_LIMIT_EXCEEDED', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 100_000 });
      const bob = registerUser(app);
      await fund(app, alice, 100_000);
      await fund(app, alice, 1);

      const over = await pay(app, alice, bob, 100_000.01);
      const result = assertRejected(app, over, alice, { code: 'SOURCE_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
      assert.deepEqual(result.error?.details, { limitPaise: 10_000_000, requestedPaise: 10_000_001 });
      assert.match(result.error!.message, /Wallet balance allows at most ₹1,00,000\.00 per payment/);

      const atLimit = await pay(app, alice, bob, 100_000);
      assert.equal(atLimit.result.transaction.status, 'SUCCESS');
      assert.equal(balanceOf(app, bob), 10_000_000);
    });

    test('bank account: more than Rs 1,00,000 in one go -> SOURCE_LIMIT_EXCEEDED', async () => {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      const outcome = await pay(app, alice, alice, 100_000.01, { sourceId: bank.id });
      assertRejected(app, outcome, alice, { code: 'SOURCE_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
      assert.equal(balanceOf(app, alice), 0);
    });

    test('card: exactly Rs 50,000 passes, one paisa more -> SOURCE_LIMIT_EXCEEDED', async () => {
      const alice = registerUser(app);
      const card = linkCard(app, alice);
      const over = await pay(app, alice, alice, 50_000.01, { sourceId: card.id });
      const result = assertRejected(app, over, alice, { code: 'SOURCE_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
      assert.deepEqual(result.error?.details, { limitPaise: 5_000_000, requestedPaise: 5_000_001 });
      assert.match(result.error!.message, /Visa card •••• 1111/);

      const atLimit = await pay(app, alice, alice, 50_000, { sourceId: card.id });
      assert.equal(atLimit.result.transaction.status, 'SUCCESS');
      assert.equal(balanceOf(app, alice), 5_000_000);
    });
  });

  describe('order of the checks: the first failing link decides the error', () => {
    test('account status comes before everything: a self transfer above every limit is still SELF_TRANSFER', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 1 });
      const outcome = await pay(app, alice, alice, 500_000);
      assertRejected(app, outcome, alice, { code: 'SELF_TRANSFER', category: 'RULE_VIOLATION' });
    });

    test('the source limit is checked before the balance', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const outcome = await pay(app, alice, bob, 100_000.01); // empty wallet
      assertRejected(app, outcome, alice, { code: 'SOURCE_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
    });

    test('the balance is checked before the daily limit', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 100 });
      const bob = registerUser(app);
      await fund(app, alice, 50);
      const outcome = await pay(app, alice, bob, 200);
      assertRejected(app, outcome, alice, { code: 'INSUFFICIENT_BALANCE', category: 'RULE_VIOLATION' });
    });

    test('the daily limit is checked before the fraud rules', async () => {
      const alice = registerUser(app, { dailyLimitRupees: 100 });
      const scammer = registerUser(app, { blacklisted: true });
      await fund(app, alice, 500);
      const outcome = await pay(app, alice, scammer, 200);
      assertRejected(app, outcome, alice, { code: 'DAILY_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' });
    });
  });

  describe('blacklisted payee', () => {
    test('paying an account reported for fraud -> FRAUD_SUSPECTED, however small the amount', async () => {
      const alice = registerUser(app);
      const scammer = registerUser(app, { blacklisted: true });
      await fund(app, alice, 500);

      const outcome = await pay(app, alice, scammer, 1);
      const result = assertRejected(app, outcome, alice, { code: 'FRAUD_SUSPECTED', category: 'FORBIDDEN' });
      assert.deepEqual(result.error?.details, { rule: 'Blacklisted payee' });
      assert.ok(result.error!.message.includes(scammer.upiId));
      assert.equal(balanceOf(app, alice), 50_000);
      assert.equal(balanceOf(app, scammer), 0);
    });

    test('a bank-funded payment to a blacklisted payee is stopped before the bank is charged', async () => {
      const alice = registerUser(app);
      const scammer = registerUser(app, { blacklisted: true });
      const bank = linkBank(app, alice);
      const outcome = await pay(app, alice, scammer, 100_000, { sourceId: bank.id });
      assertRejected(app, outcome, alice, { code: 'DAILY_LIMIT_EXCEEDED', category: 'RULE_VIOLATION' }); // default limit is Rs 50,000

      const small = await pay(app, alice, scammer, 100, { sourceId: bank.id });
      assertRejected(app, small, alice, { code: 'FRAUD_SUSPECTED', category: 'FORBIDDEN' });

      // The bank account still holds its full Rs 2,00,000: two maximum top-ups go through.
      await fund(app, alice, 100_000, bank);
      await fund(app, alice, 100_000, bank);
    });

    test('a blacklisted account cannot load its own wallet either: it is the payee of its top-up', async () => {
      const scammer = registerUser(app, { blacklisted: true });
      const bank = linkBank(app, scammer);
      const outcome = await pay(app, scammer, scammer, 100, { sourceId: bank.id });
      const result = assertRejected(app, outcome, scammer, { code: 'FRAUD_SUSPECTED', category: 'FORBIDDEN' });
      assert.deepEqual(result.error?.details, { rule: 'Blacklisted payee' });
      assert.equal(balanceOf(app, scammer), 0);
    });
  });

  describe('blocked accounts and frozen wallets', () => {
    const block = (user: User) => writerOf(app).run(`UPDATE users SET status = 'BLOCKED' WHERE id = ?`, user.id);
    const freezeWallet = (user: User) => writerOf(app).run(`UPDATE wallets SET status = 'FROZEN' WHERE user_id = ?`, user.id);

    test('a blocked sender is refused before anything is recorded: 403 SENDER_BLOCKED', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      block(alice);

      await assert.rejects(pay(app, alice, bob, 100), (error: unknown) => {
        assert.ok(error instanceof ForbiddenError);
        assert.equal(error.code, 'SENDER_BLOCKED');
        assert.equal(error.category, 'FORBIDDEN');
        return true;
      });
      assert.equal(balanceOf(app, bob), 0);
      assert.deepEqual(app.queries.history(bob.id, 10, true).data, []);
    });

    test('paying a blocked receiver -> RECEIVER_BLOCKED, recorded as FAILED', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      block(bob);

      const outcome = await pay(app, alice, bob, 100);
      assertRejected(app, outcome, alice, { code: 'RECEIVER_BLOCKED', category: 'RULE_VIOLATION' });
      assert.equal(balanceOf(app, alice), 50_000);
    });

    test('a frozen sender wallet cannot pay -> WALLET_FROZEN, and nothing moves', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      freezeWallet(alice);

      const outcome = await pay(app, alice, bob, 100);
      assertRejected(app, outcome, alice, { code: 'WALLET_FROZEN', category: 'RULE_VIOLATION' });
      assert.equal(storedBalanceOf(app, alice), 50_000);
      assert.equal(storedBalanceOf(app, bob), 0);
    });

    test('a frozen receiver wallet cannot be credited -> WALLET_FROZEN, and the sender keeps the money', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 500);
      freezeWallet(bob);

      const outcome = await pay(app, alice, bob, 100);
      assertRejected(app, outcome, alice, { code: 'WALLET_FROZEN', category: 'RULE_VIOLATION' });
      assert.equal(storedBalanceOf(app, alice), 50_000, 'the debit was rolled back with the failed credit');
      assert.equal(storedBalanceOf(app, bob), 0);
    });

    test('a bank payment into a frozen wallet is charged, cannot be credited, and is returned to the bank', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      freezeWallet(bob);

      const { result } = await pay(app, alice, bob, 100_000 / 20, { sourceId: bank.id });

      assert.equal(result.transaction.status, 'REFUNDED');
      assert.equal(result.error?.code, 'CREDIT_FAILED_REFUNDED');
      assert.deepEqual(result.error?.details, { cause: 'WALLET_FROZEN' });
      assert.equal(storedBalanceOf(app, bob), 0);
      assert.deepEqual(timelineOf(app, result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'FAILED', 'REFUNDED']);
      await fund(app, alice, 100_000, bank);
      await fund(app, alice, 100_000, bank); // the full Rs 2,00,000 is still there
    });
  });

  test('the ledger is still consistent after all those refusals', () => {
    assert.equal(verifyLedger(app).healthy, true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fraud rule: payment velocity', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp({ fraudMaxTransfersPerMinute: 3, fraudNewPayeeThresholdRupees: 900_000 });
  });

  after(() => closeApp(app));

  test('the first 3 payment attempts in a minute pass, the 4th -> FRAUD_SUSPECTED', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000); // attempt 1 (a top-up is a payment attempt too)
    assert.equal((await pay(app, alice, bob, 10)).result.transaction.status, 'SUCCESS'); // 2
    assert.equal((await pay(app, alice, bob, 10)).result.transaction.status, 'SUCCESS'); // 3

    const outcome = await pay(app, alice, bob, 10); // 4
    const result = assertRejected(app, outcome, alice, { code: 'FRAUD_SUSPECTED', category: 'FORBIDDEN' });
    assert.deepEqual(result.error?.details, { rule: 'Payment velocity' });
    assert.match(result.error!.message, /3 in the last minute/);
    assert.equal(balanceOf(app, alice), 98_000);
    assert.equal(balanceOf(app, bob), 2_000);
  });

  test('refused attempts keep counting, so hammering does not help', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    await pay(app, alice, bob, 10);
    await pay(app, alice, bob, 10);
    for (let i = 0; i < 3; i += 1) {
      const outcome = await pay(app, alice, bob, 10);
      assert.equal(outcome.result.error?.code, 'FRAUD_SUSPECTED');
    }
    assert.equal(balanceOf(app, bob), 2_000);
  });

  test('the count is per sender: receiving money and other users are unaffected', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    await pay(app, alice, bob, 10);
    await pay(app, alice, bob, 10);
    assert.equal((await pay(app, alice, bob, 10)).result.error?.code, 'FRAUD_SUSPECTED');

    // Bob received two payments but has made none himself.
    const carol = registerUser(app);
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await pay(app, bob, carol, 5)).result.transaction.status, 'SUCCESS');
    }
    assert.equal((await pay(app, bob, carol, 5)).result.error?.code, 'FRAUD_SUSPECTED');
  });

  test('a concurrent burst is throttled as well', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => pay(app, alice, bob, 10)));
    const succeeded = outcomes.filter((o) => o.result.transaction.status === 'SUCCESS').length;
    assert.ok(succeeded <= 2, `at most 2 more payments fit in the window, ${succeeded} went through`);
    for (const outcome of outcomes.filter((o) => o.result.error)) {
      assert.equal(outcome.result.error?.code, 'FRAUD_SUSPECTED');
    }
    assert.equal(balanceOf(app, bob), succeeded * 1_000);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fraud rule: high value to a new payee', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp({ fraudNewPayeeThresholdRupees: 1_000 });
  });

  after(() => closeApp(app));

  test('a first payment at the threshold -> FRAUD_SUSPECTED; just below it passes', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const carol = registerUser(app);
    await fund(app, alice, 5_000);

    const outcome = await pay(app, alice, bob, 1_000);
    const result = assertRejected(app, outcome, alice, { code: 'FRAUD_SUSPECTED', category: 'FORBIDDEN' });
    assert.deepEqual(result.error?.details, { rule: 'High value to new payee' });
    assert.ok(result.error!.message.includes(bob.upiId));
    assert.match(result.error!.message, /₹1,000\.00/);

    assert.equal((await pay(app, alice, carol, 999.99)).result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, bob), 0);
  });

  test('once the payee has been paid before, a high-value payment passes', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 5_000);

    assert.equal((await pay(app, alice, bob, 2_000)).result.error?.code, 'FRAUD_SUSPECTED');
    assert.equal((await pay(app, alice, bob, 1)).result.transaction.status, 'SUCCESS');
    const large = await pay(app, alice, bob, 2_000);
    assert.equal(large.result.error, undefined);
    assert.equal(large.result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, bob), 200_100);
  });

  test('a refused attempt does not make the payee known', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 5_000);
    await pay(app, alice, bob, 1_500);
    assert.equal((await pay(app, alice, bob, 1_500)).result.error?.code, 'FRAUD_SUSPECTED');
  });

  test('trust is per payee and per direction', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const carol = registerUser(app);
    await fund(app, alice, 5_000);
    await fund(app, bob, 5_000);
    await pay(app, alice, bob, 1);

    assert.equal((await pay(app, alice, carol, 1_000)).result.error?.code, 'FRAUD_SUSPECTED', 'carol is new to alice');
    assert.equal((await pay(app, bob, alice, 1_000)).result.error?.code, 'FRAUD_SUSPECTED', 'alice is new to bob');
    assert.equal((await pay(app, alice, bob, 1_000)).result.transaction.status, 'SUCCESS');
  });

  test('loading your own wallet is never a "new payee", whatever the amount', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, alice, 50_000, { sourceId: bank.id });
    assert.equal(result.transaction.status, 'SUCCESS');
  });

  test('when several rules object, the first rule in the engine is the one reported', async () => {
    const alice = registerUser(app);
    const scammer = registerUser(app, { blacklisted: true });
    await fund(app, alice, 5_000);
    const { result } = await pay(app, alice, scammer, 2_000);
    assert.deepEqual(result.error?.details, { rule: 'Blacklisted payee' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('ValidationPipeline and FraudEngine (extension points)', () => {
  const context = {} as ValidationContext;

  class Recording extends ValidationHandler {
    constructor(
      readonly name: string,
      private readonly log: string[],
      private readonly failWith?: Error,
    ) {
      super();
    }

    protected check(): void {
      this.log.push(this.name);
      if (this.failWith) throw this.failWith;
    }
  }

  test('runs every handler in the order given', () => {
    const log: string[] = [];
    const pipeline = new ValidationPipeline([new Recording('a', log), new Recording('b', log), new Recording('c', log)]);
    pipeline.validate(context);
    assert.deepEqual(log, ['a', 'b', 'c']);
    assert.deepEqual(pipeline.steps(), ['a', 'b', 'c']);
  });

  test('stops at the first handler that throws and passes its error on', () => {
    const log: string[] = [];
    const refusal = new BusinessRuleError('NOPE', 'second link says no');
    const pipeline = new ValidationPipeline([new Recording('a', log), new Recording('b', log, refusal), new Recording('c', log)]);
    assert.throws(() => pipeline.validate(context), (error: unknown) => error === refusal);
    assert.deepEqual(log, ['a', 'b'], 'the third link never ran');
  });

  test('an empty pipeline accepts everything', () => {
    const pipeline = new ValidationPipeline([]);
    assert.doesNotThrow(() => pipeline.validate(context));
    assert.deepEqual(pipeline.steps(), []);
  });

  test('setNext returns the next handler so links can be chained by hand', () => {
    const log: string[] = [];
    const head = new Recording('a', log);
    head.setNext(new Recording('b', log)).setNext(new Recording('c', log));
    head.handle(context);
    assert.deepEqual(log, ['a', 'b', 'c']);
  });

  test('the fraud engine evaluates every rule, including ones added later', () => {
    const rule = (name: string, suspicious: boolean): FraudRule => ({
      name,
      evaluate: () => ({ rule: name, suspicious, reason: suspicious ? `${name} objects` : '' }),
    });
    const engine = new FraudEngine([rule('first', false)]);
    engine.addRule(rule('second', true));
    assert.deepEqual(engine.ruleNames(), ['first', 'second']);
    assert.deepEqual(engine.assess(context), [
      { rule: 'first', suspicious: false, reason: '' },
      { rule: 'second', suspicious: true, reason: 'second objects' },
    ]);
  });

  test('the rule list handed to the engine is copied, not shared', () => {
    const rules: FraudRule[] = [];
    const engine = new FraudEngine(rules);
    rules.push({ name: 'sneaked in', evaluate: () => ({ rule: 'sneaked in', suspicious: true, reason: 'x' }) });
    assert.deepEqual(engine.ruleNames(), []);
  });
});

describe('TransactionEventPublisher (observer extension point)', () => {
  const event = { transition: { from: null, to: 'INITIATED', detail: 'x', at: new Date() } } as unknown as TransactionEvent;
  const recorder = (name: string, log: string[]): TransactionObserver => ({
    name,
    onTransactionEvent: () => void log.push(name),
  });

  test('every subscribed observer hears every event, in subscription order', () => {
    const log: string[] = [];
    const publisher = new TransactionEventPublisher();
    publisher.subscribe(recorder('audit', log));
    publisher.subscribe(recorder('cashback', log));
    publisher.publish(event);
    publisher.publish(event);
    assert.deepEqual(log, ['audit', 'cashback', 'audit', 'cashback']);
    assert.deepEqual(publisher.observerNames(), ['audit', 'cashback']);
  });

  test('an unsubscribed observer hears nothing more; unsubscribing a stranger is harmless', () => {
    const log: string[] = [];
    const publisher = new TransactionEventPublisher();
    const cashback = recorder('cashback', log);
    publisher.subscribe(recorder('audit', log));
    publisher.subscribe(cashback);
    publisher.unsubscribe(cashback);
    publisher.unsubscribe(recorder('never subscribed', log));
    publisher.publish(event);
    assert.deepEqual(log, ['audit']);
    assert.deepEqual(publisher.observerNames(), ['audit']);
  });

  test('an observer that throws does not stop the others, and the failure is logged', (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const log: string[] = [];
    const publisher = new TransactionEventPublisher();
    publisher.subscribe({
      name: 'broken webhook',
      onTransactionEvent: () => {
        throw new Error('webhook endpoint is down');
      },
    });
    publisher.subscribe(recorder('notifications', log));

    assert.doesNotThrow(() => publisher.publish(event));
    assert.deepEqual(log, ['notifications']);
    assert.equal(logged.mock.callCount(), 1);
  });
});
