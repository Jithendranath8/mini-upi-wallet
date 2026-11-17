import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import {
  BusinessRuleError,
  DomainError,
  ForbiddenError,
  GatewayUnavailableError,
  IllegalStateTransitionError,
  InsufficientBalanceError,
  NotFoundError,
} from '../src/domain/errors';
import type { User } from '../src/domain/User';
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
  storedBalanceOf,
  timelineOf,
  verifyLedger,
  writerOf,
} from './helpers';

const rejectsWith = (type: new (...args: never[]) => DomainError, code: string, category?: string) => (error: unknown) => {
  assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
  assert.equal(error.code, code);
  if (category !== undefined) assert.equal(error.category, category);
  return true;
};

describe('refunds', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.chaos.reset();
    app.system.resetBreakers();
  });

  after(() => closeApp(app));

  const statusOf = (transactionId: string, viewer: User) =>
    app.queries.details(transactionId, viewer.id, true).data.transaction.status;

  /** Alice pays Bob from her wallet. */
  async function walletPayment(rupees = 400) {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const { result } = await pay(app, alice, bob, rupees, { note: 'Dinner' });
    assert.equal(result.transaction.status, 'SUCCESS');
    return { alice, bob, transactionId: result.transaction.id };
  }

  describe('of a successful wallet payment', () => {
    test('the receiver gives the money back: both balances are restored', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      assert.equal(balanceOf(app, alice), 60_000);
      assert.equal(balanceOf(app, bob), 40_000);

      const refunded = await app.refunds.refund(transactionId, bob);

      assert.equal(refunded.id, transactionId);
      assert.equal(refunded.status, 'REFUNDED');
      assert.equal(refunded.amountPaise, 40_000);
      assert.equal(balanceOf(app, alice), 100_000);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(storedBalanceOf(app, alice), 100_000);
      assert.equal(storedBalanceOf(app, bob), 0);
      assert.deepEqual(timelineOf(app, transactionId, alice), ['INITIATED', 'PROCESSING', 'SUCCESS', 'REFUNDED']);
      assert.equal(statusOf(transactionId, alice), 'REFUNDED');
    });

    test('writes two reversing ledger entries; the original entries stay untouched', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      const before = ledgerOf(app, transactionId);
      await app.refunds.refund(transactionId, bob);

      const entries = ledgerOf(app, transactionId);
      assert.equal(entries.length, 4);
      assert.deepEqual(entries.slice(0, 2), before, 'history is appended to, never rewritten');

      const aliceWallet = `WALLET:${app.users.walletOf(alice.id).id}`;
      const bobWallet = `WALLET:${app.users.walletOf(bob.id).id}`;
      const [, , reversalDebit, reversalCredit] = entries;
      assert.equal(reversalDebit.entryType, 'DEBIT');
      assert.equal(reversalDebit.accountId, bobWallet);
      assert.equal(reversalDebit.amount, 400);
      assert.equal(reversalDebit.balanceAfter, 0);
      assert.equal(reversalDebit.description, `Refund of ${transactionId} to ${alice.upiId}`);
      assert.equal(reversalCredit.entryType, 'CREDIT');
      assert.equal(reversalCredit.accountId, aliceWallet);
      assert.equal(reversalCredit.amount, 400);
      assert.equal(reversalCredit.balanceAfter, 1_000);
      assert.equal(reversalCredit.description, `Refund of ${transactionId} from ${bob.upiId}`);
      assert.equal(reversalCredit.prevHash, reversalDebit.hash);

      const audit = verifyLedger(app);
      assert.equal(audit.healthy, true);
      assert.deepEqual(audit.unbalancedTransactions, []);
    });

    test('tells the payer the money is back and the receiver that it was refunded', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      await app.refunds.refund(transactionId, bob);
      await app.settle();

      const forAlice = notificationsFor(app, alice, transactionId).filter((n) => n.title === 'Refund received');
      assert.equal(forAlice.length, 2, 'SMS and PUSH');
      assert.match(forAlice[0].body, /₹400\.00 was returned to your Wallet balance/);
      const forBob = notificationsFor(app, bob, transactionId).filter((n) => n.title === 'Payment refunded');
      assert.equal(forBob.length, 2);
      assert.ok(forBob[0].body.includes(alice.name));
    });

    test('the payer cannot pull the money back: 403 REFUND_NOT_ALLOWED and nothing changes', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);

      await assert.rejects(app.refunds.refund(transactionId, alice), rejectsWith(ForbiddenError, 'REFUND_NOT_ALLOWED', 'FORBIDDEN'));

      assert.equal(statusOf(transactionId, alice), 'SUCCESS');
      assert.equal(balanceOf(app, alice), 60_000);
      assert.equal(balanceOf(app, bob), 40_000);
      assert.equal(ledgerOf(app, transactionId).length, 2);
    });

    test('a second refund is rejected with IllegalStateTransitionError and moves nothing', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      await app.refunds.refund(transactionId, bob);

      await assert.rejects(app.refunds.refund(transactionId, bob), (error: unknown) => {
        assert.ok(error instanceof IllegalStateTransitionError);
        assert.equal(error.code, 'ILLEGAL_STATE_TRANSITION');
        assert.equal(error.category, 'CONFLICT');
        assert.deepEqual(error.details, { from: 'REFUNDED', to: 'REFUNDED' });
        return true;
      });
      // The payer, who may act on a transaction that is no longer SUCCESS, cannot repeat it either.
      await assert.rejects(app.refunds.refund(transactionId, alice), IllegalStateTransitionError);

      assert.equal(balanceOf(app, alice), 100_000);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(ledgerOf(app, transactionId).length, 4);
      assert.deepEqual(timelineOf(app, transactionId, alice), ['INITIATED', 'PROCESSING', 'SUCCESS', 'REFUNDED']);
    });

    test('someone who is not a party gets NotFoundError, exactly as for an id that does not exist', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      const mallory = registerUser(app);

      await assert.rejects(app.refunds.refund(transactionId, mallory), rejectsWith(NotFoundError, 'TRANSACTION_NOT_FOUND', 'NOT_FOUND'));
      await assert.rejects(app.refunds.refund('txn_does_not_exist', bob), rejectsWith(NotFoundError, 'TRANSACTION_NOT_FOUND', 'NOT_FOUND'));

      assert.equal(statusOf(transactionId, alice), 'SUCCESS');
      assert.equal(balanceOf(app, bob), 40_000);
    });

    test('when the receiver no longer has the money the refund fails and changes nothing', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      const carol = registerUser(app);
      await pay(app, bob, carol, 400); // Bob spends it all

      await assert.rejects(app.refunds.refund(transactionId, bob), (error: unknown) => {
        assert.ok(error instanceof InsufficientBalanceError);
        assert.deepEqual(error.details, { availablePaise: 0, requiredPaise: 40_000 });
        return true;
      });

      assert.equal(statusOf(transactionId, alice), 'SUCCESS');
      assert.deepEqual(timelineOf(app, transactionId, alice), ['INITIATED', 'PROCESSING', 'SUCCESS']);
      assert.equal(balanceOf(app, alice), 60_000);
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(balanceOf(app, carol), 40_000);
      assert.equal(storedBalanceOf(app, alice), 60_000);
      assert.equal(ledgerOf(app, transactionId).length, 2);
      assert.equal(verifyLedger(app).healthy, true);
    });

    test('a receiver who has only part of the money left cannot make a partial refund', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      const carol = registerUser(app);
      await pay(app, bob, carol, 0.01);

      await assert.rejects(app.refunds.refund(transactionId, bob), InsufficientBalanceError);
      assert.equal(balanceOf(app, bob), 39_999);
      assert.equal(balanceOf(app, alice), 60_000);

      // Once the receiver has the full amount again, the refund goes through.
      await pay(app, carol, bob, 0.01);
      assert.equal((await app.refunds.refund(transactionId, bob)).status, 'REFUNDED');
      assert.equal(balanceOf(app, alice), 100_000);
    });

    test('the receiver can refund with money that came from elsewhere: it is the amount that matters', async () => {
      const { alice, bob, transactionId } = await walletPayment(400);
      const carol = registerUser(app);
      await pay(app, bob, carol, 400);
      await fund(app, bob, 400);

      assert.equal((await app.refunds.refund(transactionId, bob)).status, 'REFUNDED');
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(balanceOf(app, alice), 100_000);
    });

    test('the view returned to the receiver does not reveal which account the payer used', async () => {
      const { bob, transactionId } = await walletPayment(400);
      const refunded = await app.refunds.refund(transactionId, bob);
      assert.deepEqual(refunded.source, { id: '', type: 'WALLET', label: 'Wallet' });
    });
  });

  describe('of payments that did not succeed', () => {
    test('a payment that failed without capturing funds cannot be refunded by anyone', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const { result } = await pay(app, alice, bob, 50); // empty wallet
      assert.equal(result.transaction.status, 'FAILED');

      for (const requester of [alice, bob]) {
        await assert.rejects(app.refunds.refund(result.transaction.id, requester), (error: unknown) => {
          assert.ok(error instanceof IllegalStateTransitionError);
          assert.deepEqual(error.details, { from: 'FAILED', to: 'REFUNDED' });
          return true;
        });
      }
      assert.equal(statusOf(result.transaction.id, alice), 'FAILED');
      assert.deepEqual(ledgerOf(app, result.transaction.id), []);
    });

    test('a bank payment that failed before the charge (gateway down) has nothing to return', async () => {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      app.chaos.update({ bank: { down: true } });
      const { result } = await pay(app, alice, alice, 100, { sourceId: bank.id });
      app.chaos.update({ bank: { down: false } });

      await assert.rejects(app.refunds.refund(result.transaction.id, alice), IllegalStateTransitionError);
      assert.equal(statusOf(result.transaction.id, alice), 'FAILED');
    });
  });

  describe('of bank-funded payments', () => {
    /** Alice pays Bob straight from her bank account. */
    async function bankPayment(rupees = 600) {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      const { result } = await pay(app, alice, bob, rupees, { sourceId: bank.id });
      assert.equal(result.transaction.status, 'SUCCESS');
      return { alice, bob, bank, transactionId: result.transaction.id };
    }

    test('the receiver wallet is debited and the money goes back to the bank, not to the payer wallet', async () => {
      const { alice, bob, bank, transactionId } = await bankPayment(600);

      const refunded = await app.refunds.refund(transactionId, bob);

      assert.equal(refunded.status, 'REFUNDED');
      assert.deepEqual(refunded.source, { id: '', type: 'BANK_ACCOUNT', label: 'Bank account' });
      assert.equal(balanceOf(app, bob), 0);
      assert.equal(balanceOf(app, alice), 0, 'the payer wallet was never involved');

      const entries = ledgerOf(app, transactionId);
      assert.equal(entries.length, 4);
      assert.equal(entries[2].entryType, 'DEBIT');
      assert.equal(entries[2].accountId, `WALLET:${app.users.walletOf(bob.id).id}`);
      assert.equal(entries[3].entryType, 'CREDIT');
      assert.equal(entries[3].accountId, `EXTERNAL:${bank.id}`);
      assert.equal(entries[3].balanceAfter, null);
      assert.match(entries[3].description, /Returned to Test Bank XXXX9012 via Bank network/);
      assert.equal(verifyLedger(app).healthy, true);

      // The bank account is back at its full Rs 2,00,000.
      await fund(app, alice, 100_000, bank);
      await fund(app, alice, 100_000, bank);
    });

    test('if the receiver spent the money: REFUND_NOT_POSSIBLE, decided before the bank is even called', async () => {
      const { alice, bob, transactionId } = await bankPayment(600);
      const carol = registerUser(app);
      await pay(app, bob, carol, 600);
      app.chaos.update({ bank: { down: true } }); // would surface as GATEWAY_UNAVAILABLE if the bank were called

      await assert.rejects(app.refunds.refund(transactionId, bob), rejectsWith(BusinessRuleError, 'REFUND_NOT_POSSIBLE', 'RULE_VIOLATION'));

      assert.equal(statusOf(transactionId, alice), 'SUCCESS');
      assert.equal(balanceOf(app, carol), 60_000);
      assert.equal(ledgerOf(app, transactionId).length, 2);
      assert.equal(app.system.snapshot().circuitBreakers[0].consecutiveFailures, 0);
    });

    test('if the bank is down the refund fails cleanly and can be retried later', async () => {
      const { alice, bob, transactionId } = await bankPayment(600);
      app.chaos.update({ bank: { down: true } });

      await assert.rejects(app.refunds.refund(transactionId, bob), GatewayUnavailableError);
      assert.equal(statusOf(transactionId, alice), 'SUCCESS');
      assert.equal(balanceOf(app, bob), 60_000, 'the receiver keeps the money while the bank is unreachable');
      assert.equal(ledgerOf(app, transactionId).length, 2);

      app.chaos.update({ bank: { down: false } });
      assert.equal((await app.refunds.refund(transactionId, bob)).status, 'REFUNDED');
      assert.equal(balanceOf(app, bob), 0);
    });

    test('a frozen receiver wallet stops the refund before the bank returns anything', async () => {
      const { alice, bob, bank, transactionId } = await bankPayment(5_000);
      writerOf(app).run(`UPDATE wallets SET status = 'FROZEN' WHERE user_id = ?`, bob.id);

      await assert.rejects(app.refunds.refund(transactionId, bob), rejectsWith(BusinessRuleError, 'WALLET_FROZEN', 'RULE_VIOLATION'));
      assert.equal(statusOf(transactionId, alice), 'SUCCESS');
      assert.equal(storedBalanceOf(app, bob), 500_000);
      assert.equal(ledgerOf(app, transactionId).length, 2);

      // The Rs 5,000 is still charged at the bank: Rs 1,95,000 is left, not Rs 2,00,000.
      await fund(app, alice, 100_000, bank);
      await fund(app, alice, 95_000, bank);
      assert.equal((await pay(app, alice, alice, 1, { sourceId: bank.id })).result.error?.code, 'PAYMENT_DECLINED');
    });

    test('the payer still cannot pull the money back', async () => {
      const { alice, bob, transactionId } = await bankPayment(600);
      await assert.rejects(app.refunds.refund(transactionId, alice), rejectsWith(ForbiddenError, 'REFUND_NOT_ALLOWED', 'FORBIDDEN'));
      assert.equal(balanceOf(app, bob), 60_000);
    });
  });

  describe('of a top-up', () => {
    test('the owner (payer and receiver in one) can undo it: the wallet is debited and the bank credited', async () => {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      const { result } = await pay(app, alice, alice, 100_000, { sourceId: bank.id });
      assert.equal(balanceOf(app, alice), 10_000_000);

      const refunded = await app.refunds.refund(result.transaction.id, alice);

      assert.equal(refunded.status, 'REFUNDED');
      assert.deepEqual(refunded.source, { id: bank.id, type: 'BANK_ACCOUNT', label: 'Test Bank XXXX9012' }, 'the payer sees their own source');
      assert.equal(balanceOf(app, alice), 0);
      await fund(app, alice, 100_000, bank);
      await fund(app, alice, 100_000, bank);
    });

    test('only one "Refund received" notification per channel: there is no second party', async () => {
      const alice = registerUser(app);
      const bank = linkBank(app, alice);
      const { result } = await pay(app, alice, alice, 500, { sourceId: bank.id });
      await app.refunds.refund(result.transaction.id, alice);
      await app.settle();

      const titles = notificationsFor(app, alice, result.transaction.id).map((n) => n.title).sort();
      assert.deepEqual(titles, ['Money added', 'Money added', 'Refund received', 'Refund received']);
    });

    test('a top-up that has been spent cannot be undone', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      const { result } = await pay(app, alice, alice, 500, { sourceId: bank.id });
      await pay(app, alice, bob, 100);

      await assert.rejects(app.refunds.refund(result.transaction.id, alice), rejectsWith(BusinessRuleError, 'REFUND_NOT_POSSIBLE'));
      assert.equal(balanceOf(app, alice), 40_000);
      assert.equal(statusOf(result.transaction.id, alice), 'SUCCESS');
    });
  });

  test('after every refund scenario above the ledger still balances and matches every wallet', () => {
    const audit = verifyLedger(app);
    assert.equal(audit.healthy, true);
    assert.equal(audit.chainIntact, true);
    assert.deepEqual(audit.walletMismatches, []);
  });
});

/**
 * Regression tests for a bug found by this suite and since fixed in src/service/RefundService.ts.
 *
 * refund() used to decide "may this requester refund?" from the transaction as it was BEFORE the
 * wallet locks were taken. While a payment was still INITIATED/PROCESSING it was "not a SUCCESS
 * payment", so the payer passed the check; the request then queued behind the payment's own lock
 * and refunded it once it had become SUCCESS, although only the receiver may do that.
 */
describe('refund permission is decided on the state the transaction has when the refund runs', () => {
  const inFlightPaymentOf = (app: Application, payer: User) => {
    const row = primaryOf(app).get<{ id: string; status: string }>(
      `SELECT id, status FROM transactions WHERE sender_id = ? AND type = 'P2P'`,
      payer.id,
    );
    assert.ok(row, 'the payment should already be recorded');
    assert.ok(['INITIATED', 'PROCESSING'].includes(row.status), `expected the payment to be in flight, it is ${row.status}`);
    return row.id;
  };

  async function assertPayerCannotClawBack(app: Application, alice: User, bob: User, paying: ReturnType<typeof pay>) {
    const transactionId = inFlightPaymentOf(app, alice);
    const clawBack = app.refunds.refund(transactionId, alice).then(
      (view) => `refund went through, transaction is ${view.status}`,
      (error: unknown) => (error instanceof DomainError ? `rejected: ${error.code}` : `rejected: ${String(error)}`),
    );

    const paid = await paying;
    assert.equal(paid.result.transaction.status, 'SUCCESS');
    const outcome = await clawBack;

    assert.match(outcome, /^rejected: /, 'the payer must not be able to refund their own payment');
    assert.equal(app.queries.details(transactionId, bob.id, true).data.transaction.status, 'SUCCESS');
    assert.equal(balanceOf(app, bob), 60_000, 'the receiver keeps the money');
  }

  test('a payer cannot queue a refund behind their own bank payment and claw it back once it succeeds', async () => {
    const app = await createTestApp({ gatewayLatencyMs: 40 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      const paying = pay(app, alice, bob, 600, { sourceId: bank.id }); // waits 40 ms for the bank
      await assertPayerCannotClawBack(app, alice, bob, paying);
    } finally {
      await closeApp(app);
    }
  });

  test('the same holds for a wallet payment (the window is the database round trip)', async () => {
    const app = await createTestApp({ databaseLatencyMs: 5 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 600);
      const paying = pay(app, alice, bob, 600);
      await assertPayerCannotClawBack(app, alice, bob, paying);
      assert.equal(balanceOf(app, alice), 0);
    } finally {
      await closeApp(app);
    }
  });

  test('a receiver who asks while the payment is in flight either gets the refund or a clean refusal', async () => {
    const app = await createTestApp({ gatewayLatencyMs: 40 });
    try {
      const alice = registerUser(app);
      const bob = registerUser(app);
      const bank = linkBank(app, alice);
      const paying = pay(app, alice, bob, 600, { sourceId: bank.id });
      const transactionId = inFlightPaymentOf(app, alice);
      const refunding = app.refunds.refund(transactionId, bob).then(
        (view) => view.status,
        (error: unknown) => {
          assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
          return 'refused';
        },
      );

      assert.equal((await paying).result.transaction.status, 'SUCCESS');
      const outcome = await refunding;

      // Whichever it is, the books must agree with it.
      const status = app.queries.details(transactionId, bob.id, true).data.transaction.status;
      assert.equal(status, outcome === 'refused' ? 'SUCCESS' : 'REFUNDED');
      assert.equal(balanceOf(app, bob), outcome === 'refused' ? 60_000 : 0);
      assert.equal(ledgerOf(app, transactionId).length, outcome === 'refused' ? 2 : 4);
      assert.equal(verifyLedger(app).healthy, true);
    } finally {
      await closeApp(app);
    }
  });
});
