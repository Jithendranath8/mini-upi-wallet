import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { PaymentSourceType } from '../src/domain/enums';
import { BusinessRuleError, IllegalStateTransitionError, ValidationError } from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import type { PaymentSource } from '../src/domain/PaymentSource';
import type { User } from '../src/domain/User';
import { RequestTrace, tracer } from '../src/infrastructure/observability/Tracer';
import { PaymentStrategyFactory } from '../src/payment/PaymentStrategy';
import type { IdempotentOutcome } from '../src/service/IdempotencyService';
import type { TransferResult } from '../src/service/TransferService';
import {
  balanceOf,
  closeApp,
  closeAppIgnoringScheduledRetries,
  createTestApp,
  eventually,
  freezeClock,
  fund,
  keepAlive,
  ledgerOf,
  linkBank,
  linkCard,
  notificationsFor,
  pay,
  type PayOptions,
  registerUser,
  sleep,
  storedBalanceOf,
  timelineOf,
  verifyLedger,
} from './helpers';

const breakerOf = (app: Application, name: 'Bank network' | 'Card network') =>
  app.system.snapshot().circuitBreakers.find((breaker) => breaker.name === name)!;

/** Runs one payment inside its own request trace and returns the trace lines it produced. */
async function tracedPay(
  app: Application,
  sender: User,
  receiver: User,
  rupees: number,
  options: PayOptions,
): Promise<{ outcome: IdempotentOutcome<TransferResult>; steps: string[] }> {
  const trace = new RequestTrace(`test-${Math.random().toString(36).slice(2)}`, 'test payment');
  const outcome = await tracer.run(trace, () => pay(app, sender, receiver, rupees, options));
  return { outcome, steps: trace.steps.map((step) => `${step.component}: ${step.message}`) };
}

/**
 * The simulated bank holds Rs 2,00,000 per linked account. If the account is back at its
 * opening balance, two maximum top-ups go through and the next rupee is declined.
 */
async function assertBankAccountIsFull(app: Application, user: User, bank: PaymentSource): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    const { result } = await pay(app, user, user, 100_000, { sourceId: bank.id });
    assert.equal(result.transaction.status, 'SUCCESS', `top-up ${i + 1} of 2 should fit: ${result.error?.code}`);
  }
  const { result } = await pay(app, user, user, 1, { sourceId: bank.id });
  assert.equal(result.error?.code, 'PAYMENT_DECLINED');
}

/**
 * Charge succeeds, credit fails, and by the time the refund is attempted the bank is down.
 * The gateway reads its fault settings when a call starts, so taking the bank down while the
 * charge is "on the wire" lets the charge through and fails the refund that follows.
 */
async function strandCharge(app: Application, payer: User, receiver: User, bank: PaymentSource) {
  app.chaos.update({ bank: { latencyMs: 50 }, failNextCredit: true });
  const inFlight = pay(app, payer, receiver, 500, { sourceId: bank.id });
  await sleep(15);
  app.chaos.update({ bank: { down: true } });
  return inFlight;
}

// ---------------------------------------------------------------------------------------------
describe('bank and card payments', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.chaos.reset();
    app.system.resetBreakers();
  });

  after(() => closeApp(app));

  test('a top-up from a linked bank account credits the wallet', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);

    const { result, replayed } = await pay(app, alice, alice, 2_500.75, { sourceId: bank.id, note: 'Wallet top-up' });

    assert.equal(replayed, false);
    assert.equal(result.error, undefined);
    assert.equal(result.transaction.status, 'SUCCESS');
    assert.equal(result.transaction.type, 'TOPUP');
    assert.equal(result.transaction.amountPaise, 250_075);
    assert.deepEqual(result.transaction.source, { id: bank.id, type: 'BANK_ACCOUNT', label: 'Test Bank XXXX9012' });
    assert.equal(result.transaction.sender.id, alice.id);
    assert.equal(result.transaction.receiver.id, alice.id);
    assert.equal(balanceOf(app, alice), 250_075);
    assert.deepEqual(timelineOf(app, result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'SUCCESS']);
  });

  test('a top-up posts a debit on the external account and a credit on the wallet', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, alice, 1_000, { sourceId: bank.id });

    const [debit, credit] = ledgerOf(app, result.transaction.id);
    assert.equal(ledgerOf(app, result.transaction.id).length, 2);
    assert.equal(debit.entryType, 'DEBIT');
    assert.equal(debit.accountId, `EXTERNAL:${bank.id}`);
    assert.equal(debit.amount, 1_000);
    assert.equal(debit.balanceAfter, null, 'we do not know the balance of an account we do not hold');
    assert.match(debit.description, /via Bank network/);
    assert.equal(credit.entryType, 'CREDIT');
    assert.equal(credit.accountId, `WALLET:${app.users.walletOf(alice.id).id}`);
    assert.equal(credit.balanceAfter, 1_000);
    assert.equal(verifyLedger(app).healthy, true);
  });

  test('a top-up notifies its owner once per channel with "Money added"', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const { result } = await pay(app, alice, alice, 300, { sourceId: bank.id });
    await app.settle();

    const notifications = notificationsFor(app, alice, result.transaction.id);
    assert.deepEqual(notifications.map((n) => n.channel).sort(), ['PUSH', 'SMS']);
    for (const notification of notifications) {
      assert.equal(notification.title, 'Money added');
      assert.match(notification.body, /₹300\.00 added to your wallet from Test Bank XXXX9012/);
    }
  });

  test('paying someone straight from the bank credits them and leaves the payer wallet alone', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = await fund(app, alice, 200);

    const { result } = await pay(app, alice, bob, 750, { sourceId: bank.id });

    assert.equal(result.transaction.status, 'SUCCESS');
    assert.equal(result.transaction.type, 'P2P');
    assert.equal(balanceOf(app, alice), 20_000, 'more than the wallet held was paid: it came from the bank');
    assert.equal(balanceOf(app, bob), 75_000);
    const [debit, credit] = ledgerOf(app, result.transaction.id);
    assert.equal(debit.accountId, `EXTERNAL:${bank.id}`);
    assert.equal(credit.accountId, `WALLET:${app.users.walletOf(bob.id).id}`);
  });

  test('a card payment goes through CardPaymentStrategy, including its extra authorisation step', async () => {
    const alice = registerUser(app);
    const card = linkCard(app, alice);

    const { outcome, steps } = await tracedPay(app, alice, alice, 1_200, { sourceId: card.id });

    assert.equal(outcome.result.transaction.status, 'SUCCESS');
    assert.deepEqual(outcome.result.transaction.source, { id: card.id, type: 'CARD', label: 'Visa card •••• 1111' });
    assert.equal(balanceOf(app, alice), 120_000);
    assert.ok(steps.includes('Strategy: CARD source selected: CardPaymentStrategy'), steps.join('\n'));
    assert.ok(steps.some((step) => /3-D Secure check passed for Visa card •••• 1111/.test(step)));
    assert.ok(steps.some((step) => /via Card network/.test(step)));
    assert.match(ledgerOf(app, outcome.result.transaction.id)[0].description, /via Card network/);
  });

  test('bank and wallet payments use their own strategies, without the card-only step', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = linkBank(app, alice);

    const viaBank = await tracedPay(app, alice, alice, 500, { sourceId: bank.id });
    assert.ok(viaBank.steps.includes('Strategy: BANK_ACCOUNT source selected: BankTransferStrategy'));
    assert.equal(viaBank.steps.some((step) => /3-D Secure/.test(step)), false);

    const viaWallet = await tracedPay(app, alice, bob, 100, {});
    assert.ok(viaWallet.steps.includes('Strategy: WALLET source selected: WalletPaymentStrategy'));
    assert.equal(viaWallet.steps.some((step) => step.startsWith('Gateway:')), false, 'a wallet payment never calls a gateway');
  });

  test('the card network and the bank network fail independently', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const card = linkCard(app, alice);
    app.chaos.update({ card: { down: true } });

    const viaCard = await pay(app, alice, alice, 100, { sourceId: card.id });
    const viaBank = await pay(app, alice, alice, 100, { sourceId: bank.id });

    assert.equal(viaCard.result.error?.code, 'GATEWAY_UNAVAILABLE');
    assert.match(viaCard.result.error!.message, /Card network/);
    assert.equal(viaBank.result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, alice), 10_000);
    assert.equal(breakerOf(app, 'Card network').consecutiveFailures, 1);
    assert.equal(breakerOf(app, 'Bank network').consecutiveFailures, 0);
  });

  test('gateway down -> FAILED with GATEWAY_UNAVAILABLE and no money moved', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ bank: { down: true } });

    const { result } = await pay(app, alice, bob, 400, { sourceId: bank.id });

    assert.equal(result.transaction.status, 'FAILED');
    assert.equal(result.error?.code, 'GATEWAY_UNAVAILABLE');
    assert.equal(result.error?.category, 'UNAVAILABLE');
    assert.equal(result.transaction.failureCode, 'GATEWAY_UNAVAILABLE');
    assert.equal(balanceOf(app, alice), 0);
    assert.equal(balanceOf(app, bob), 0);
    assert.deepEqual(ledgerOf(app, result.transaction.id), []);
    assert.deepEqual(timelineOf(app, result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'FAILED']);

    // Nothing was charged: with the network back, the account still holds its full balance.
    app.chaos.update({ bank: { down: false } });
    await assertBankAccountIsFull(app, alice, bank);
  });

  test('a gateway that times out on every call (failure rate 1) fails the payment the same way', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ bank: { failureRate: 1 } });
    const { result } = await pay(app, alice, alice, 100, { sourceId: bank.id });
    assert.equal(result.error?.code, 'GATEWAY_UNAVAILABLE');
    assert.match(result.error!.message, /timed out/);
    assert.equal(balanceOf(app, alice), 0);
  });

  test('the bank declines once the simulated account (Rs 2,00,000) is exhausted', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    await fund(app, alice, 100_000, bank);
    await fund(app, alice, 99_999.99, bank);

    const tooMuch = await pay(app, alice, alice, 0.02, { sourceId: bank.id });
    assert.equal(tooMuch.result.transaction.status, 'FAILED');
    assert.equal(tooMuch.result.error?.code, 'PAYMENT_DECLINED');
    assert.equal(tooMuch.result.error?.category, 'DECLINED');
    assert.match(tooMuch.result.error!.message, /insufficient funds in the linked account/);
    assert.deepEqual(ledgerOf(app, tooMuch.result.transaction.id), []);
    assert.equal(balanceOf(app, alice), 19_999_999);

    const lastPaisa = await pay(app, alice, alice, 0.01, { sourceId: bank.id });
    assert.equal(lastPaisa.result.transaction.status, 'SUCCESS', 'the exact remaining balance can still be charged');
    assert.equal(balanceOf(app, alice), 20_000_000);
  });

  test('a decline is a business answer: it never opens the circuit breaker', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    await fund(app, alice, 100_000, bank);
    await fund(app, alice, 100_000, bank);
    for (let i = 0; i < 5; i += 1) {
      const { result } = await pay(app, alice, alice, 10, { sourceId: bank.id });
      assert.equal(result.error?.code, 'PAYMENT_DECLINED');
    }
    const breaker = breakerOf(app, 'Bank network');
    assert.equal(breaker.state, 'CLOSED');
    assert.equal(breaker.consecutiveFailures, 0);
  });

  test('each linked account has its own balance at the bank', async () => {
    const alice = registerUser(app);
    const first = linkBank(app, alice);
    const second = linkBank(app, alice);
    await fund(app, alice, 100_000, first);
    await fund(app, alice, 100_000, first);
    assert.equal((await pay(app, alice, alice, 1, { sourceId: first.id })).result.error?.code, 'PAYMENT_DECLINED');
    assert.equal((await pay(app, alice, alice, 1, { sourceId: second.id })).result.transaction.status, 'SUCCESS');
  });
});

// ---------------------------------------------------------------------------------------------
describe('circuit breaker around the bank gateway', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp({ breakerFailureThreshold: 2, breakerOpenMs: 8_000 });
  });

  afterEach(() => {
    app.chaos.reset();
    app.system.resetBreakers();
  });

  after(() => closeApp(app));

  const topUp = (user: User, bank: PaymentSource) => pay(app, user, user, 100, { sourceId: bank.id });

  test('after the threshold of outages the next call fails fast with CIRCUIT_OPEN', async (t) => {
    const advance = freezeClock(t);
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    const before = breakerOf(app, 'Bank network');
    app.chaos.update({ bank: { down: true } });

    assert.equal((await topUp(alice, bank)).result.error?.code, 'GATEWAY_UNAVAILABLE');
    assert.equal(breakerOf(app, 'Bank network').state, 'CLOSED');
    assert.equal((await topUp(alice, bank)).result.error?.code, 'GATEWAY_UNAVAILABLE');
    assert.equal(breakerOf(app, 'Bank network').state, 'OPEN');

    // The bank is healthy again, but for the whole cool-down the open circuit does not even try.
    app.chaos.update({ bank: { down: false } });
    advance(7_999);
    const rejected = await topUp(alice, bank);
    assert.equal(rejected.result.transaction.status, 'FAILED');
    assert.equal(rejected.result.error?.code, 'CIRCUIT_OPEN');
    assert.equal(rejected.result.error?.category, 'UNAVAILABLE');
    assert.equal(rejected.result.transaction.failureCode, 'CIRCUIT_OPEN');
    assert.equal(balanceOf(app, alice), 0);

    const breaker = breakerOf(app, 'Bank network');
    assert.equal(breaker.state, 'OPEN');
    assert.equal(breaker.callsRejected - before.callsRejected, 1);
    assert.equal(breaker.timesOpened - before.timesOpened, 1);
    assert.equal(breaker.retryInMs, 1);
    assert.equal(breakerOf(app, 'Card network').state, 'CLOSED', 'the card network has its own breaker');
  });

  test('after the cool-down a healthy gateway closes the circuit again', async (t) => {
    const advance = freezeClock(t);
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ bank: { down: true } });
    await topUp(alice, bank);
    await topUp(alice, bank);
    assert.equal((await topUp(alice, bank)).result.error?.code, 'CIRCUIT_OPEN');

    app.chaos.update({ bank: { down: false } });
    advance(8_000);
    assert.equal(breakerOf(app, 'Bank network').state, 'HALF_OPEN');

    const trial = await topUp(alice, bank);
    assert.equal(trial.result.error, undefined);
    assert.equal(trial.result.transaction.status, 'SUCCESS');
    assert.equal(breakerOf(app, 'Bank network').state, 'CLOSED');
    assert.equal(breakerOf(app, 'Bank network').consecutiveFailures, 0);

    assert.equal((await topUp(alice, bank)).result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, alice), 20_000);
  });

  test('if the trial call after the cool-down fails, the circuit opens again at once', async (t) => {
    const advance = freezeClock(t);
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ bank: { down: true } });
    const openedBefore = breakerOf(app, 'Bank network').timesOpened;
    await topUp(alice, bank);
    await topUp(alice, bank);
    advance(8_000);

    assert.equal((await topUp(alice, bank)).result.error?.code, 'GATEWAY_UNAVAILABLE', 'the trial call reaches the gateway');
    assert.equal(breakerOf(app, 'Bank network').state, 'OPEN');
    assert.equal(breakerOf(app, 'Bank network').timesOpened - openedBefore, 2);
    assert.equal((await topUp(alice, bank)).result.error?.code, 'CIRCUIT_OPEN');
    advance(7_999);
    assert.equal((await topUp(alice, bank)).result.error?.code, 'CIRCUIT_OPEN', 'a full new cool-down applies');
  });

  test('the operator can reset the breakers by hand', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ bank: { down: true } });
    await topUp(alice, bank);
    await topUp(alice, bank);
    assert.equal(breakerOf(app, 'Bank network').state, 'OPEN');

    app.chaos.update({ bank: { down: false } });
    app.system.resetBreakers();
    assert.equal(breakerOf(app, 'Bank network').state, 'CLOSED');
    assert.equal((await topUp(alice, bank)).result.transaction.status, 'SUCCESS');
  });

  test('wallet payments keep working while the bank circuit is open', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = await fund(app, alice, 500);
    app.chaos.update({ bank: { down: true } });
    await topUp(alice, bank);
    await topUp(alice, bank);
    assert.equal(breakerOf(app, 'Bank network').state, 'OPEN');

    assert.equal((await pay(app, alice, bob, 200)).result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, bob), 20_000);
  });
});

// ---------------------------------------------------------------------------------------------
describe('saga: the charge succeeded but the receiver could not be credited', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.chaos.reset();
    app.system.resetBreakers();
  });

  after(() => closeApp(app));

  test('the charge is returned at once: REFUNDED, CREDIT_FAILED_REFUNDED, receiver untouched', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ failNextCredit: true });

    const { result } = await pay(app, alice, bob, 900, { sourceId: bank.id });

    assert.equal(result.transaction.status, 'REFUNDED');
    assert.equal(result.error?.code, 'CREDIT_FAILED_REFUNDED');
    assert.equal(result.error?.category, 'RULE_VIOLATION');
    assert.deepEqual(result.error?.details, { cause: 'CREDIT_FAILED' });
    assert.equal(result.transaction.failureCode, 'CREDIT_FAILED');
    assert.equal(balanceOf(app, bob), 0, 'the receiver wallet is unchanged');
    assert.equal(balanceOf(app, alice), 0);
    assert.deepEqual(timelineOf(app, result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'FAILED', 'REFUNDED']);
    assert.deepEqual(ledgerOf(app, result.transaction.id), [], 'no money entered our books, so nothing is posted');
    assert.equal(app.chaos.state.failNextCredit, false, 'the injected fault is consumed');
    assert.equal(verifyLedger(app).healthy, true);
    assert.equal(app.system.snapshot().queue.compensations?.published ?? 0, 0, 'nothing was left for the retry queue');
  });

  test('the bank really got the instruction to return the money', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ failNextCredit: true });

    const { result } = await pay(app, alice, alice, 100_000, { sourceId: bank.id });
    assert.equal(result.transaction.status, 'REFUNDED');
    assert.equal(balanceOf(app, alice), 0);

    // Had the Rs 1,00,000 stayed captured, only one more maximum top-up would fit.
    await assertBankAccountIsFull(app, alice, bank);
  });

  test('the payer is told about the failure and the refund; the receiver hears nothing', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ failNextCredit: true });
    const { result } = await pay(app, alice, bob, 900, { sourceId: bank.id });
    await app.settle();

    const titles = notificationsFor(app, alice, result.transaction.id).map((n) => n.title);
    assert.deepEqual([...new Set(titles)].sort(), ['Payment failed', 'Refund received']);
    assert.equal(titles.length, 4, 'two events on two channels');
    assert.deepEqual(notificationsFor(app, bob, result.transaction.id), []);
  });

  test('the fault fires once: the next payment goes through', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ failNextCredit: true });
    assert.equal((await pay(app, alice, alice, 100, { sourceId: bank.id })).result.transaction.status, 'REFUNDED');
    assert.equal((await pay(app, alice, alice, 100, { sourceId: bank.id })).result.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, alice), 10_000);
  });

  test('a card payment is compensated the same way', async () => {
    const alice = registerUser(app);
    const card = linkCard(app, alice);
    app.chaos.update({ failNextCredit: true });
    const { result } = await pay(app, alice, alice, 100, { sourceId: card.id });
    assert.equal(result.transaction.status, 'REFUNDED');
    assert.equal(result.error?.code, 'CREDIT_FAILED_REFUNDED');
    assert.equal(balanceOf(app, alice), 0);
  });

  test('a wallet payment whose credit fails needs no saga: debit and credit roll back together', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    app.chaos.update({ failNextCredit: true });

    const { result } = await pay(app, alice, bob, 50);

    assert.equal(result.transaction.status, 'FAILED', 'not REFUNDED: nothing ever left the payer');
    assert.equal(result.error?.code, 'CREDIT_FAILED');
    assert.equal(result.error?.category, 'RULE_VIOLATION');
    assert.equal(storedBalanceOf(app, alice), 10_000, 'the debit was undone with the failed credit');
    assert.equal(storedBalanceOf(app, bob), 0);
    assert.equal(balanceOf(app, alice), 10_000, 'and the cached balance agrees');
    assert.deepEqual(ledgerOf(app, result.transaction.id), []);
    assert.deepEqual(timelineOf(app, result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'FAILED']);
    assert.equal(app.chaos.state.failNextCredit, false, 'the fault fired once');

    assert.equal((await pay(app, alice, bob, 50)).result.transaction.status, 'SUCCESS');
    assert.equal(verifyLedger(app).healthy, true);
  });

  test('a debit never triggers the injected credit fault: a refused payment leaves it armed', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    app.chaos.update({ failNextCredit: true });
    const { result } = await pay(app, alice, bob, 50); // empty wallet: refused before any wallet is saved
    assert.equal(result.error?.code, 'INSUFFICIENT_BALANCE');
    assert.equal(app.chaos.state.failNextCredit, true);
  });

  test('a wallet refund whose credit fails changes nothing and can simply be repeated', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    const paid = await pay(app, alice, bob, 60);
    app.chaos.update({ failNextCredit: true });

    await assert.rejects(app.refunds.refund(paid.result.transaction.id, bob), (error: unknown) => {
      assert.ok(error instanceof BusinessRuleError);
      assert.equal(error.code, 'CREDIT_FAILED');
      return true;
    });
    assert.equal(storedBalanceOf(app, bob), 6_000, "the receiver's debit was rolled back");
    assert.equal(storedBalanceOf(app, alice), 4_000);
    assert.equal(ledgerOf(app, paid.result.transaction.id).length, 2);

    assert.equal((await app.refunds.refund(paid.result.transaction.id, bob)).status, 'REFUNDED');
    assert.equal(storedBalanceOf(app, alice), 10_000);
  });

  test('a retry with the same key replays the refunded outcome instead of charging again', async () => {
    const alice = registerUser(app);
    const bank = linkBank(app, alice);
    app.chaos.update({ failNextCredit: true });
    const first = await pay(app, alice, alice, 100, { sourceId: bank.id, key: 'saga-retry-key-1' });
    const second = await pay(app, alice, alice, 100, { sourceId: bank.id, key: 'saga-retry-key-1' });
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(balanceOf(app, alice), 0);
  });
});

describe('fault injection switched off (faultInjection: false)', () => {
  test('arming "fail the next credit" has no effect: bank, card and wallet payments all go through', async () => {
    const app = await createTestApp({ faultInjection: false });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      const card = linkCard(app, alice);
      app.chaos.update({ failNextCredit: true });

      const viaBank = await pay(app, alice, alice, 300, { sourceId: bank.id });
      const viaCard = await pay(app, alice, alice, 200, { sourceId: card.id });
      const viaWallet = await pay(app, alice, bob, 120);

      for (const outcome of [viaBank, viaCard, viaWallet]) {
        assert.equal(outcome.result.error, undefined);
        assert.equal(outcome.result.transaction.status, 'SUCCESS');
      }
      assert.equal(balanceOf(app, alice), 38_000);
      assert.equal(balanceOf(app, bob), 12_000);
      assert.equal(app.chaos.state.failNextCredit, true, 'nothing ever consumed the fault: the decorator is not wired in');

      await app.refunds.refund(viaWallet.result.transaction.id, bob);
      assert.equal(balanceOf(app, alice), 50_000);
      assert.equal(verifyLedger(app).healthy, true);
    } finally {
      await closeApp(app);
    }
  });

  test('with the switch on (the default) the very same sequence trips on the first credit', async () => {
    const app = await createTestApp({ faultInjection: true });
    try {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      app.chaos.update({ failNextCredit: true });
      const { result } = await pay(app, alice, alice, 300, { sourceId: bank.id });
      assert.equal(result.transaction.status, 'REFUNDED');
      assert.equal(app.chaos.state.failNextCredit, false);
      assert.equal(app.settings.faultInjection, true);
    } finally {
      await closeApp(app);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('saga: the refund cannot reach the gateway either', () => {
  test('the client gets CREDIT_FAILED_REFUND_PENDING and the money is released automatically once the gateway is back', async () => {
    const app = await createTestApp();
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);

      const { result } = await strandCharge(app, alice, bob, bank);

      assert.equal(result.transaction.status, 'FAILED', 'the charge is captured but could not be returned yet');
      assert.equal(result.error?.code, 'CREDIT_FAILED_REFUND_PENDING');
      assert.equal(result.error?.category, 'RULE_VIOLATION');
      assert.equal(result.transaction.failureCode, 'CREDIT_FAILED');
      assert.equal(balanceOf(app, bob), 0);
      assert.deepEqual(timelineOf(app, result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'FAILED']);

      // The bank comes back before the queued compensation job makes its first attempt.
      app.chaos.update({ bank: { down: false, latencyMs: 0 } });
      await keepAlive(app.settle());

      const details = app.queries.details(result.transaction.id, alice.id, true).data;
      assert.equal(details.transaction.status, 'REFUNDED');
      assert.deepEqual(
        details.timeline.map((step) => step.to),
        ['INITIATED', 'PROCESSING', 'FAILED', 'REFUNDED'],
      );
      assert.equal(details.timeline[3].detail, 'Captured charge returned to the source');
      assert.deepEqual(details.ledger, []);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(app.system.snapshot().queue.compensations.processed, 1);
      assert.equal(app.system.snapshot().stuckCompensations, 0);
      assert.deepEqual(
        [...new Set(notificationsFor(app, alice, result.transaction.id).map((n) => n.title))].sort(),
        ['Payment failed', 'Refund received'],
      );
      await assertBankAccountIsFull(app, alice, bank);
      assert.equal(verifyLedger(app).healthy, true);
    } finally {
      await closeApp(app);
    }
  });

  for (const who of ['payer', 'receiver'] as const) {
    test(`while the automatic retry is still waiting, the ${who} can release the captured charge by hand`, async () => {
      const app = await createTestApp();
      try {
        const alice = registerUser(app);
        const bob = registerUser(app);
        const bank = linkBank(app, alice);
        const { result } = await strandCharge(app, alice, bob, bank);
        assert.equal(result.error?.code, 'CREDIT_FAILED_REFUND_PENDING');

        // The first automatic attempt also finds the bank down and schedules a retry (1 s away).
        await eventually(() => app.system.snapshot().queue.compensations?.scheduledRetries === 1);
        assert.equal(app.queries.details(result.transaction.id, alice.id, true).data.transaction.status, 'FAILED');

        app.chaos.update({ bank: { down: false, latencyMs: 0 } });
        const requester = who === 'payer' ? alice : bob;
        const released = await app.refunds.refund(result.transaction.id, requester);

        assert.equal(released.status, 'REFUNDED');
        assert.deepEqual(timelineOf(app, result.transaction.id, alice), ['INITIATED', 'PROCESSING', 'FAILED', 'REFUNDED']);
        assert.equal(balanceOf(app, bob), 0);
        await assert.rejects(app.refunds.refund(result.transaction.id, requester), IllegalStateTransitionError);
        await assertBankAccountIsFull(app, alice, bank);
      } finally {
        // Not closeApp(): settle() would wait a full second for the retry that is still scheduled.
        // That retry would find the transaction already REFUNDED and do nothing.
        await closeAppIgnoringScheduledRetries(app);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
describe('restart: data on disk survives and stranded charges are recovered', () => {
  test('a charge left captured by a crash is returned to the bank after the restart', async () => {
    // The only test that uses real database files; they live in a throwaway folder under tests/.
    const dataDir = mkdtempSync(join(import.meta.dirname, '.tmp-restart-'));
    try {
      // ---- first run: a payment ends FAILED with the charge still captured, then the process "dies"
      const first = await createTestApp({ dataDir });
      const alice = registerUser(first);
      const bob = registerUser(first);
      const bank = await fund(first, alice, 1_000);
      const walletPayment = await pay(first, alice, bob, 250);
      const { result: stranded } = await strandCharge(first, alice, bob, bank);
      assert.equal(stranded.error?.code, 'CREDIT_FAILED_REFUND_PENDING');
      await closeAppIgnoringScheduledRetries(first);

      // ---- second run on the same files
      const second = await createTestApp({ dataDir });
      try {
        assert.deepEqual(second.users.list().map((user) => user.id).sort(), [alice.id, bob.id].sort());
        assert.equal(balanceOf(second, alice), 75_000);
        assert.equal(balanceOf(second, bob), 25_000);
        assert.equal(second.users.require(alice.id).verifyPin('1234'), true);
        assert.equal(
          second.queries.details(walletPayment.result.transaction.id, alice.id, true).data.transaction.status,
          'SUCCESS',
        );
        assert.equal(verifyLedger(second).healthy, true, 'the hash chain verifies after being read back from disk');

        // The replica was rebuilt from a snapshot of the primary at start-up.
        const fromReplica = second.queries.history(bob.id, 10);
        assert.equal(fromReplica.servedBy, 'replica');
        assert.equal(fromReplica.data.length, 2);

        // Start-up recovery re-queued the stranded charge; the (healthy) bank now returns it.
        await keepAlive(second.settle());
        const details = second.queries.details(stranded.transaction.id, alice.id, true).data;
        assert.equal(details.transaction.status, 'REFUNDED');
        assert.deepEqual(
          details.timeline.map((step) => step.to),
          ['INITIATED', 'PROCESSING', 'FAILED', 'REFUNDED'],
        );
        assert.equal(balanceOf(second, bob), 25_000);

        // The simulated bank was told again about both charges: the Rs 1,000 top-up is still
        // taken, the stranded Rs 500 is back. So Rs 1,99,000 is left, to the paisa.
        const linked = second.users.sourcesOf(alice.id).find((source) => source.id === bank.id)!;
        await fund(second, alice, 100_000, linked);
        await fund(second, alice, 99_000, linked);
        assert.equal((await pay(second, alice, alice, 0.01, { sourceId: bank.id })).result.error?.code, 'PAYMENT_DECLINED');

        // Idempotency keys are on disk too: the old key still answers with the old payment.
        const retry = await second.transfers.transfer({
          idempotencyKey: 'restart-key-0001',
          senderId: alice.id,
          receiverUpiId: bob.upiId,
          amount: Money.fromRupees(10),
        });
        const again = await second.transfers.transfer({
          idempotencyKey: 'restart-key-0001',
          senderId: alice.id,
          receiverUpiId: bob.upiId,
          amount: Money.fromRupees(10),
        });
        assert.equal(again.replayed, true);
        assert.equal(again.result.transaction.id, retry.result.transaction.id);
      } finally {
        await closeApp(second);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('PaymentStrategyFactory', () => {
  test('rejects a source type nobody registered a strategy for', () => {
    const factory = new PaymentStrategyFactory();
    assert.deepEqual(factory.supportedTypes(), []);
    assert.throws(
      () => factory.for(PaymentSourceType.CARD),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'UNSUPPORTED_PAYMENT_METHOD');
        return true;
      },
    );
  });
});
