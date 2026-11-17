import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  LedgerEntryType,
  NotificationChannelType,
  PaymentSourceType,
  ScheduledPaymentStatus,
  TransactionStatus,
  TransactionType,
  UserStatus,
  WalletStatus,
} from '../src/domain/enums';
import {
  BusinessRuleError,
  ConflictError,
  DomainError,
  IllegalStateTransitionError,
  InsufficientBalanceError,
  ValidationError,
} from '../src/domain/errors';
import { LedgerEntry } from '../src/domain/LedgerEntry';
import { Money } from '../src/domain/Money';
import {
  BankAccountSource,
  CardSource,
  PaymentSourceFactory,
  type PaymentSourceRecord,
  WalletSource,
} from '../src/domain/PaymentSource';
import { PinHasher } from '../src/domain/PinHasher';
import { ScheduledPayment } from '../src/domain/ScheduledPayment';
import { Transaction, type TransactionProps } from '../src/domain/Transaction';
import { User } from '../src/domain/User';
import { Wallet } from '../src/domain/Wallet';

const hasCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
};

// ---------------------------------------------------------------------------------------------
describe('Money', () => {
  test('stores rupees as an integer number of paise', () => {
    assert.equal(Money.fromRupees(10).paise, 1_000);
    assert.equal(Money.fromRupees(10.5).paise, 1_050);
    assert.equal(Money.fromRupees(19.99).paise, 1_999);
    assert.equal(Money.fromRupees(0.01).paise, 1);
    assert.equal(Money.fromRupees(0).paise, 0);
    assert.equal(Money.ofPaise(12_345).toRupees(), 123.45);
  });

  test('every two-decimal amount up to Rs 1,000 converts to the exact paise value', () => {
    for (let paise = 0; paise <= 100_000; paise += 1) {
      assert.equal(Money.fromRupees(paise / 100).paise, paise, `Rs ${paise / 100}`);
    }
  });

  test('values that floating point cannot represent exactly still land on the right paise', () => {
    // 4.35 * 100 is 434.99999999999994 and 1.15 * 100 is 114.99999999999999 in IEEE-754.
    assert.equal(Money.fromRupees(4.35).paise, 435);
    assert.equal(Money.fromRupees(1.15).paise, 115);
    assert.equal(Money.fromRupees(0.07).paise, 7);
    assert.equal(Money.fromRupees(1_000_000.01).paise, 100_000_001);
  });

  test('arithmetic never drifts: 0.10 + 0.20 is exactly 0.30', () => {
    assert.equal(Money.fromRupees(0.1).plus(Money.fromRupees(0.2)).paise, 30);
    let total = Money.zero();
    for (let i = 0; i < 1_000; i += 1) total = total.plus(Money.fromRupees(0.1));
    assert.equal(total.paise, 10_000);
  });

  test('rejects more than two decimal places', () => {
    for (const rupees of [1.005, 1.234, 0.001, 10.999, 99.995, 10.005]) {
      assert.throws(() => Money.fromRupees(rupees), hasCode('INVALID_AMOUNT'), `Rs ${rupees}`);
    }
  });

  test('rejects a tiny excess instead of silently rounding it to a different amount', () => {
    for (const rupees of [10.000000001, 0.010000001, 99.99999999, 0.1 + 0.2, 1e-9]) {
      assert.throws(() => Money.fromRupees(rupees), hasCode('INVALID_AMOUNT'), `Rs ${rupees}`);
    }
  });

  test('rejects negative amounts', () => {
    assert.throws(() => Money.fromRupees(-1), hasCode('INVALID_AMOUNT'));
    assert.throws(() => Money.fromRupees(-0.01), hasCode('INVALID_AMOUNT'));
    assert.throws(() => Money.ofPaise(-1), hasCode('INVALID_AMOUNT'));
  });

  test('rejects values that are not finite numbers', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => Money.fromRupees(bad), ValidationError);
      assert.throws(() => Money.ofPaise(bad), ValidationError);
    }
    for (const bad of ['10', null, undefined, {}, [], true]) {
      assert.throws(() => Money.fromRupees(bad as unknown as number), ValidationError, `fromRupees(${String(bad)})`);
      assert.throws(() => Money.ofPaise(bad as unknown as number), ValidationError, `ofPaise(${String(bad)})`);
    }
  });

  test('rejects fractional paise and amounts beyond the safe integer range', () => {
    assert.throws(() => Money.ofPaise(1.5), hasCode('INVALID_AMOUNT'));
    assert.throws(() => Money.ofPaise(Number.MAX_SAFE_INTEGER + 1), hasCode('INVALID_AMOUNT'));
    assert.throws(() => Money.fromRupees(Number.MAX_SAFE_INTEGER), hasCode('INVALID_AMOUNT'));
    assert.equal(Money.ofPaise(Number.MAX_SAFE_INTEGER).paise, Number.MAX_SAFE_INTEGER);
  });

  test('plus and minus return new values and leave the operands untouched', () => {
    const a = Money.ofPaise(500);
    const b = Money.ofPaise(200);
    assert.equal(a.plus(b).paise, 700);
    assert.equal(a.minus(b).paise, 300);
    assert.equal(a.paise, 500);
    assert.equal(b.paise, 200);
    assert.equal(a.minus(a).isZero(), true);
  });

  test('minus refuses to go below zero: Money can never be a debt', () => {
    assert.throws(() => Money.ofPaise(100).minus(Money.ofPaise(101)), hasCode('INVALID_AMOUNT'));
  });

  test('plus refuses to overflow the safe integer range', () => {
    assert.throws(() => Money.ofPaise(Number.MAX_SAFE_INTEGER).plus(Money.ofPaise(1)), hasCode('INVALID_AMOUNT'));
  });

  test('comparisons', () => {
    const small = Money.ofPaise(100);
    const big = Money.ofPaise(101);
    assert.equal(big.isGreaterThan(small), true);
    assert.equal(small.isGreaterThan(big), false);
    assert.equal(small.isGreaterThan(small), false);
    assert.equal(small.isAtLeast(small), true);
    assert.equal(small.isAtLeast(big), false);
    assert.equal(big.isAtLeast(small), true);
    assert.equal(small.equals(Money.fromRupees(1)), true);
    assert.equal(small.equals(big), false);
    assert.equal(Money.zero().isZero(), true);
    assert.equal(small.isZero(), false);
  });

  test('formats with the rupee sign, Indian digit grouping and two decimals', () => {
    assert.equal(Money.fromRupees(100_000).format(), '₹1,00,000.00');
    assert.equal(Money.fromRupees(1_234.5).format(), '₹1,234.50');
    assert.equal(Money.zero().format(), '₹0.00');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Wallet', () => {
  const walletWith = (paise: number, status = WalletStatus.ACTIVE) =>
    new Wallet('wal_1', 'usr_1', Money.ofPaise(paise), 0, status, new Date('2026-01-01T00:00:00.000Z'));

  test('credit raises and debit lowers the balance', () => {
    const wallet = walletWith(1_000);
    wallet.credit(Money.ofPaise(250));
    assert.equal(wallet.balance.paise, 1_250);
    wallet.debit(Money.ofPaise(1_000));
    assert.equal(wallet.balance.paise, 250);
  });

  test('debit of the exact balance leaves zero', () => {
    const wallet = walletWith(999);
    wallet.debit(Money.ofPaise(999));
    assert.equal(wallet.balance.paise, 0);
    assert.equal(wallet.balance.isZero(), true);
  });

  test('debit beyond the balance throws InsufficientBalanceError and changes nothing', () => {
    const wallet = walletWith(999);
    const before = wallet.updatedAt;
    assert.throws(
      () => wallet.debit(Money.ofPaise(1_000)),
      (error: unknown) => {
        assert.ok(error instanceof InsufficientBalanceError);
        assert.equal(error.code, 'INSUFFICIENT_BALANCE');
        assert.equal(error.category, 'RULE_VIOLATION');
        assert.deepEqual(error.details, { availablePaise: 999, requiredPaise: 1_000 });
        return true;
      },
    );
    assert.equal(wallet.balance.paise, 999);
    assert.equal(wallet.updatedAt, before);
  });

  test('hasSufficientBalance is inclusive of the exact balance', () => {
    const wallet = walletWith(500);
    assert.equal(wallet.hasSufficientBalance(Money.ofPaise(499)), true);
    assert.equal(wallet.hasSufficientBalance(Money.ofPaise(500)), true);
    assert.equal(wallet.hasSufficientBalance(Money.ofPaise(501)), false);
  });

  test('a frozen wallet can neither be debited nor credited', () => {
    const wallet = walletWith(1_000, WalletStatus.FROZEN);
    for (const move of [() => wallet.debit(Money.ofPaise(1)), () => wallet.credit(Money.ofPaise(1))]) {
      assert.throws(move, (error: unknown) => {
        assert.ok(error instanceof BusinessRuleError);
        assert.equal(error.code, 'WALLET_FROZEN');
        return true;
      });
    }
    assert.equal(wallet.balance.paise, 1_000);
  });

  test('a balance change stamps updatedAt; the version only moves when the repository persists', () => {
    const wallet = walletWith(1_000);
    const before = wallet.updatedAt.getTime();
    wallet.credit(Money.ofPaise(1));
    assert.ok(wallet.updatedAt.getTime() > before);
    assert.equal(wallet.version, 0);
    wallet.markPersisted();
    assert.equal(wallet.version, 1);
  });

  test('snapshot round trip preserves every field', () => {
    const wallet = walletWith(4_242);
    wallet.markPersisted();
    const snapshot = wallet.toSnapshot();
    assert.deepEqual(snapshot, {
      id: 'wal_1',
      userId: 'usr_1',
      balancePaise: 4_242,
      version: 1,
      status: 'ACTIVE',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual(Wallet.fromSnapshot(JSON.parse(JSON.stringify(snapshot))).toSnapshot(), snapshot);
  });
});

// ---------------------------------------------------------------------------------------------
const BASE_PROPS: TransactionProps = {
  id: 'txn_1',
  idempotencyKey: 'key-12345678',
  type: TransactionType.P2P,
  senderId: 'usr_a',
  receiverId: 'usr_b',
  sourceId: 'src_a',
  sourceType: PaymentSourceType.WALLET,
  amount: Money.fromRupees(100),
  note: '',
  status: TransactionStatus.INITIATED,
  failureCode: null,
  failureReason: null,
  fundsCaptured: false,
  gatewayReference: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const transactionIn = (status: TransactionStatus, fundsCaptured = false): Transaction =>
  Transaction.rehydrate({ ...BASE_PROPS, status, fundsCaptured });

type Action = 'startProcessing' | 'succeed' | 'fail' | 'refund';

const perform = (txn: Transaction, action: Action): void => {
  if (action === 'fail') txn.fail('SOME_CODE', 'Some reason');
  else txn[action]();
};

const TARGET: Record<Action, TransactionStatus> = {
  startProcessing: TransactionStatus.PROCESSING,
  succeed: TransactionStatus.SUCCESS,
  fail: TransactionStatus.FAILED,
  refund: TransactionStatus.REFUNDED,
};

describe('Transaction state machine', () => {
  const S = TransactionStatus;

  const LEGAL: Array<{ from: TransactionStatus; action: Action; captured?: boolean }> = [
    { from: S.INITIATED, action: 'startProcessing' },
    { from: S.INITIATED, action: 'fail' },
    { from: S.PROCESSING, action: 'succeed' },
    { from: S.PROCESSING, action: 'fail' },
    { from: S.SUCCESS, action: 'refund' },
    { from: S.FAILED, action: 'refund', captured: true },
  ];

  const ILLEGAL: Array<{ from: TransactionStatus; action: Action; captured?: boolean }> = [
    { from: S.INITIATED, action: 'succeed' },
    { from: S.INITIATED, action: 'refund' },
    { from: S.PROCESSING, action: 'startProcessing' },
    { from: S.PROCESSING, action: 'refund' },
    { from: S.SUCCESS, action: 'startProcessing' },
    { from: S.SUCCESS, action: 'succeed' },
    { from: S.SUCCESS, action: 'fail' },
    { from: S.FAILED, action: 'startProcessing' },
    { from: S.FAILED, action: 'succeed' },
    { from: S.FAILED, action: 'fail' },
    { from: S.FAILED, action: 'refund', captured: false },
    { from: S.FAILED, action: 'startProcessing', captured: true },
    { from: S.FAILED, action: 'succeed', captured: true },
    { from: S.FAILED, action: 'fail', captured: true },
    { from: S.REFUNDED, action: 'startProcessing' },
    { from: S.REFUNDED, action: 'succeed' },
    { from: S.REFUNDED, action: 'fail' },
    { from: S.REFUNDED, action: 'refund' },
    { from: S.REFUNDED, action: 'refund', captured: true },
  ];

  test('the two tables cover every (state, action) pair exactly once', () => {
    const seen = new Set([...LEGAL, ...ILLEGAL].map(({ from, action }) => `${from}:${action}`));
    for (const status of Object.values(S)) {
      for (const action of Object.keys(TARGET)) {
        assert.ok(seen.has(`${status}:${action}`), `${status}.${action}() is not covered`);
      }
    }
  });

  for (const { from, action, captured } of LEGAL) {
    const label = `${from}${captured ? ' (funds captured)' : ''} -> ${TARGET[action]} via ${action}() is legal`;
    test(label, () => {
      const txn = transactionIn(from, captured);
      perform(txn, action);
      assert.equal(txn.status, TARGET[action]);

      const transitions = txn.unrecordedTransitions();
      assert.equal(transitions.length, 1);
      assert.equal(transitions[0].from, from);
      assert.equal(transitions[0].to, TARGET[action]);
      assert.ok(transitions[0].detail.length > 0);
      assert.equal(txn.updatedAt, transitions[0].at);
    });
  }

  for (const { from, action, captured } of ILLEGAL) {
    const label = `${from}${captured === undefined ? '' : captured ? ' (funds captured)' : ' (nothing captured)'} -> ${TARGET[action]} via ${action}() is rejected`;
    test(label, () => {
      const txn = transactionIn(from, captured);
      assert.throws(
        () => perform(txn, action),
        (error: unknown) => {
          assert.ok(error instanceof IllegalStateTransitionError);
          assert.equal(error.code, 'ILLEGAL_STATE_TRANSITION');
          assert.equal(error.category, 'CONFLICT');
          assert.deepEqual(error.details, { from, to: TARGET[action] });
          return true;
        },
      );
      // A rejected transition must leave no trace.
      assert.equal(txn.status, from);
      assert.deepEqual(txn.unrecordedTransitions(), []);
      assert.equal(txn.failureCode, null);
      assert.equal(txn.failureReason, null);
      assert.equal(txn.updatedAt.getTime(), BASE_PROPS.updatedAt.getTime());
    });
  }

  test('fail() records the failure code and reason', () => {
    const txn = transactionIn(S.PROCESSING);
    txn.fail('INSUFFICIENT_BALANCE', 'Wallet balance is too low for this payment.');
    assert.equal(txn.status, S.FAILED);
    assert.equal(txn.failureCode, 'INSUFFICIENT_BALANCE');
    assert.equal(txn.failureReason, 'Wallet balance is too low for this payment.');
    assert.equal(txn.unrecordedTransitions()[0].detail, 'Wallet balance is too low for this payment.');
  });

  test('a FAILED payment becomes refundable only once funds were captured', () => {
    const txn = transactionIn(S.PROCESSING);
    txn.fail('CREDIT_FAILED', 'Receiver could not be credited');
    assert.equal(txn.canBeRefunded(), false);
    assert.throws(() => txn.refund(), IllegalStateTransitionError);

    txn.markFundsCaptured('BANK-000001');
    assert.equal(txn.fundsCaptured, true);
    assert.equal(txn.gatewayReference, 'BANK-000001');
    assert.equal(txn.canBeRefunded(), true);
    txn.refund('Charge returned to the source automatically');
    assert.equal(txn.status, S.REFUNDED);
  });

  test('canBeRefunded per state', () => {
    assert.equal(transactionIn(S.INITIATED).canBeRefunded(), false);
    assert.equal(transactionIn(S.PROCESSING).canBeRefunded(), false);
    assert.equal(transactionIn(S.PROCESSING, true).canBeRefunded(), false);
    assert.equal(transactionIn(S.SUCCESS).canBeRefunded(), true);
    assert.equal(transactionIn(S.FAILED).canBeRefunded(), false);
    assert.equal(transactionIn(S.FAILED, true).canBeRefunded(), true);
    assert.equal(transactionIn(S.REFUNDED).canBeRefunded(), false);
    assert.equal(transactionIn(S.REFUNDED, true).canBeRefunded(), false);
  });

  test('isTerminal per state', () => {
    assert.equal(transactionIn(S.INITIATED).isTerminal(), false);
    assert.equal(transactionIn(S.PROCESSING).isTerminal(), false);
    assert.equal(transactionIn(S.SUCCESS).isTerminal(), false); // may still be refunded
    assert.equal(transactionIn(S.FAILED).isTerminal(), true);
    assert.equal(transactionIn(S.FAILED, true).isTerminal(), false, 'captured funds still have to be returned');
    assert.equal(transactionIn(S.REFUNDED).isTerminal(), true);
    assert.equal(transactionIn(S.REFUNDED, true).isTerminal(), true);
  });

  test('a refund cannot be applied twice', () => {
    const txn = transactionIn(S.SUCCESS);
    txn.refund();
    assert.throws(() => txn.refund(), IllegalStateTransitionError);
    assert.equal(txn.status, S.REFUNDED);
  });

  test('the full happy lifecycle collects its transitions in order and hands them over once', () => {
    const txn = Transaction.builder()
      .withId('txn_life')
      .withIdempotencyKey('key-12345678')
      .from('usr_a')
      .to('usr_b')
      .fundedBy('src_a', PaymentSourceType.WALLET)
      .forAmount(Money.fromRupees(10))
      .build();
    txn.startProcessing();
    txn.succeed();
    txn.refund();

    const transitions = txn.unrecordedTransitions();
    assert.deepEqual(
      transitions.map(({ from, to }) => [from, to]),
      [
        [null, S.INITIATED],
        [S.INITIATED, S.PROCESSING],
        [S.PROCESSING, S.SUCCESS],
        [S.SUCCESS, S.REFUNDED],
      ],
    );
    assert.equal(transitions[3].detail, 'Amount returned to the payer');
    txn.markPersisted();
    assert.deepEqual(txn.unrecordedTransitions(), [], 'once stored, a transition is not queued again');
  });

  test('a rehydrated transaction starts with no pending transitions and round-trips its props', () => {
    const props: TransactionProps = {
      ...BASE_PROPS,
      status: S.FAILED,
      failureCode: 'GATEWAY_UNAVAILABLE',
      failureReason: 'down',
      fundsCaptured: true,
      gatewayReference: 'BANK-000007',
      note: 'rent',
    };
    const txn = Transaction.rehydrate(props);
    assert.deepEqual(txn.unrecordedTransitions(), []);
    assert.deepEqual(txn.toProps(), { ...props, version: 0 }, 'a transaction without a stored version starts at 0');
    assert.deepEqual(Transaction.rehydrate({ ...props, version: 7 }).toProps(), { ...props, version: 7 });
  });

  test('every transition is queued for the repository until it reports the write', () => {
    const txn = transactionIn(S.INITIATED);
    txn.startProcessing();
    txn.succeed();

    const queued = txn.unrecordedTransitions().map(({ from, to }) => [from, to]);
    assert.deepEqual(queued, [
      [S.INITIATED, S.PROCESSING],
      [S.PROCESSING, S.SUCCESS],
    ]);
    assert.equal(txn.unrecordedTransitions().length, 2, 'reading the queue does not empty it');
    txn.markPersisted();
    assert.deepEqual(txn.unrecordedTransitions(), []);
  });

  test('the domain object has no publishing queue of its own: observers are fed from the stored events', () => {
    const txn = transactionIn(S.INITIATED) as unknown as Record<string, unknown>;
    assert.equal(txn.pullTransitions, undefined);
  });

  test('the version moves only when the repository reports a write', () => {
    const txn = transactionIn(S.INITIATED);
    assert.equal(txn.version, 0);
    txn.startProcessing();
    assert.equal(txn.version, 0, 'a state change alone does not touch the version');
    txn.markInserted();
    assert.equal(txn.version, 0, 'the first INSERT stores version 0');
    assert.deepEqual(txn.unrecordedTransitions(), []);
    txn.markPersisted();
    txn.markPersisted();
    assert.equal(txn.version, 2);
  });

  test('a new transaction has its creation queued for the audit trail', () => {
    const txn = Transaction.builder()
      .withId('txn_new')
      .withIdempotencyKey('key-12345678')
      .from('usr_a')
      .to('usr_b')
      .fundedBy('src_a', PaymentSourceType.WALLET)
      .forAmount(Money.fromRupees(10))
      .build();
    assert.deepEqual(
      txn.unrecordedTransitions().map(({ from, to }) => [from, to]),
      [[null, S.INITIATED]],
    );
    assert.equal(txn.version, 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('TransactionBuilder', () => {
  const complete = () =>
    Transaction.builder()
      .withId('txn_b')
      .withIdempotencyKey('key-12345678')
      .from('usr_a')
      .to('usr_b')
      .fundedBy('src_a', PaymentSourceType.WALLET)
      .forAmount(Money.fromRupees(25));

  test('builds an INITIATED P2P transaction with sensible defaults', () => {
    const txn = complete().build();
    assert.equal(txn.status, TransactionStatus.INITIATED);
    assert.equal(txn.type, TransactionType.P2P);
    assert.equal(txn.note, '');
    assert.equal(txn.amount.paise, 2_500);
    assert.equal(txn.failureCode, null);
    assert.equal(txn.failureReason, null);
    assert.equal(txn.fundsCaptured, false);
    assert.equal(txn.gatewayReference, null);
    assert.equal(txn.updatedAt, txn.createdAt);
    assert.deepEqual(
      txn.unrecordedTransitions().map(({ from, to, detail }) => ({ from, to, detail })),
      [{ from: null, to: TransactionStatus.INITIATED, detail: 'Payment request accepted' }],
    );
  });

  test('is order independent and honours the optional parts', () => {
    const at = new Date('2026-03-04T05:06:07.000Z');
    const txn = Transaction.builder()
      .forAmount(Money.fromRupees(1))
      .createdAt(at)
      .withNote('  top up  ')
      .ofType(TransactionType.TOPUP)
      .fundedBy('src_bank', PaymentSourceType.BANK_ACCOUNT)
      .to('usr_a')
      .from('usr_a')
      .withIdempotencyKey('key-abcdefgh')
      .withId('txn_c')
      .build();
    assert.equal(txn.type, TransactionType.TOPUP);
    assert.equal(txn.note, 'top up', 'the note is trimmed');
    assert.equal(txn.createdAt, at);
    assert.equal(txn.sourceType, PaymentSourceType.BANK_ACCOUNT);
    assert.equal(txn.sourceId, 'src_bank');
    assert.equal(txn.id, 'txn_c');
    assert.equal(txn.idempotencyKey, 'key-abcdefgh');
  });

  test('refuses to build when nothing was supplied, naming every missing part', () => {
    assert.throws(
      () => Transaction.builder().build(),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'INCOMPLETE_TRANSACTION');
        for (const part of ['id', 'idempotencyKey', 'senderId', 'receiverId', 'sourceId', 'sourceType', 'amount']) {
          assert.match(error.message, new RegExp(`\\b${part}\\b`));
        }
        return true;
      },
    );
  });

  const partial: Array<[string, () => Transaction]> = [
    ['id', () => Transaction.builder().withIdempotencyKey('key-12345678').from('a').to('b').fundedBy('s', PaymentSourceType.WALLET).forAmount(Money.ofPaise(1)).build()],
    ['idempotencyKey', () => Transaction.builder().withId('t').from('a').to('b').fundedBy('s', PaymentSourceType.WALLET).forAmount(Money.ofPaise(1)).build()],
    ['senderId', () => Transaction.builder().withId('t').withIdempotencyKey('key-12345678').to('b').fundedBy('s', PaymentSourceType.WALLET).forAmount(Money.ofPaise(1)).build()],
    ['receiverId', () => Transaction.builder().withId('t').withIdempotencyKey('key-12345678').from('a').fundedBy('s', PaymentSourceType.WALLET).forAmount(Money.ofPaise(1)).build()],
    ['sourceId', () => Transaction.builder().withId('t').withIdempotencyKey('key-12345678').from('a').to('b').forAmount(Money.ofPaise(1)).build()],
    ['amount', () => Transaction.builder().withId('t').withIdempotencyKey('key-12345678').from('a').to('b').fundedBy('s', PaymentSourceType.WALLET).build()],
  ];
  for (const [missing, build] of partial) {
    test(`refuses to build without ${missing}`, () => {
      assert.throws(build, (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'INCOMPLETE_TRANSACTION');
        assert.match(error.message, new RegExp(`\\b${missing}\\b`));
        return true;
      });
    });
  }

  test('rejects a zero amount', () => {
    assert.throws(() => complete().forAmount(Money.zero()).build(), hasCode('INVALID_AMOUNT'));
  });

  test('accepts the smallest amount, one paisa', () => {
    assert.equal(complete().forAmount(Money.ofPaise(1)).build().amount.paise, 1);
  });

  test('accepts a note of exactly 80 characters and rejects 81', () => {
    assert.equal(complete().withNote('n'.repeat(80)).build().note.length, 80);
    assert.throws(() => complete().withNote('n'.repeat(81)).build(), hasCode('NOTE_TOO_LONG'));
  });

  test('measures the note after trimming and treats undefined as empty', () => {
    assert.equal(complete().withNote(`   ${'n'.repeat(80)}   `).build().note.length, 80);
    assert.equal(complete().withNote(undefined).build().note, '');
    assert.equal(complete().withNote('   ').build().note, '');
  });

  test('keeps unicode, emoji and SQL metacharacters in the note verbatim', () => {
    const note = `Chai ☕ "50%" off'; DROP TABLE users;-- ₹`;
    assert.equal(complete().withNote(note).build().note, note);
  });
});

// ---------------------------------------------------------------------------------------------
describe('PaymentSource', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');

  test('WalletSource is internal and posts to the wallet ledger account', () => {
    const source = new WalletSource('src_w', 'usr_1', 'wal_1', createdAt);
    assert.equal(source.type, PaymentSourceType.WALLET);
    assert.equal(source.isExternal(), false);
    assert.equal(source.perTransactionLimit().paise, 100_000 * 100);
    assert.equal(source.maskedIdentifier(), '');
    assert.equal(source.describe(), 'Wallet balance');
    assert.equal(source.ledgerAccountId(), 'WALLET:wal_1');
    assert.deepEqual(source.details(), { walletId: 'wal_1' });
    assert.doesNotThrow(() => source.assertUsable(new Date()));
  });

  test('BankAccountSource is external, masks the account number and posts to an external account', () => {
    const source = new BankAccountSource('src_b', 'usr_1', 'HDFC Bank', '6789', 'HDFC0001234', createdAt);
    assert.equal(source.type, PaymentSourceType.BANK_ACCOUNT);
    assert.equal(source.isExternal(), true);
    assert.equal(source.perTransactionLimit().paise, 100_000 * 100);
    assert.equal(source.maskedIdentifier(), 'XXXX6789');
    assert.equal(source.describe(), 'HDFC Bank XXXX6789');
    assert.equal(source.ledgerAccountId(), 'EXTERNAL:src_b');
    assert.deepEqual(source.details(), { bankName: 'HDFC Bank', accountLast4: '6789', ifsc: 'HDFC0001234' });
    assert.doesNotThrow(() => source.assertUsable(new Date()));
  });

  test('CardSource is external, has the lower limit and masks all but the last four digits', () => {
    const source = new CardSource('src_c', 'usr_1', 'Visa', '1111', 12, 2030, createdAt);
    assert.equal(source.type, PaymentSourceType.CARD);
    assert.equal(source.isExternal(), true);
    assert.equal(source.perTransactionLimit().paise, 50_000 * 100);
    assert.equal(source.maskedIdentifier(), '•••• 1111');
    assert.equal(source.describe(), 'Visa card •••• 1111');
    assert.equal(source.ledgerAccountId(), 'EXTERNAL:src_c');
    assert.deepEqual(source.details(), { network: 'Visa', last4: '1111', expiryMonth: 12, expiryYear: 2030 });
  });

  test('a card is valid through the last moment of its expiry month', () => {
    const june = new CardSource('src_c', 'usr_1', 'Visa', '1111', 6, 2030, createdAt);
    assert.equal(june.isExpired(new Date(2030, 4, 31, 12, 0, 0)), false);
    assert.equal(june.isExpired(new Date(2030, 5, 1, 0, 0, 0)), false);
    assert.equal(june.isExpired(new Date(2030, 5, 30, 23, 59, 59, 999)), false);
    assert.equal(june.isExpired(new Date(2030, 6, 1, 0, 0, 0, 0)), true);
    assert.equal(june.isExpired(new Date(2031, 0, 1)), true);
  });

  test('a December card expires at the start of the following January', () => {
    const december = new CardSource('src_c', 'usr_1', 'RuPay', '0000', 12, 2030, createdAt);
    assert.equal(december.isExpired(new Date(2030, 11, 31, 23, 59, 59, 999)), false);
    assert.equal(december.isExpired(new Date(2031, 0, 1, 0, 0, 0, 0)), true);
  });

  test('assertUsable throws CARD_EXPIRED for an expired card only', () => {
    const card = new CardSource('src_c', 'usr_1', 'Visa', '1111', 1, 2026, createdAt);
    assert.doesNotThrow(() => card.assertUsable(new Date(2026, 0, 15)));
    assert.throws(
      () => card.assertUsable(new Date(2026, 1, 1)),
      (error: unknown) => {
        assert.ok(error instanceof BusinessRuleError);
        assert.equal(error.code, 'CARD_EXPIRED');
        assert.deepEqual(error.details, { sourceId: 'src_c' });
        return true;
      },
    );
  });
});

describe('PaymentSourceFactory', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const record = (type: PaymentSourceType, details: Record<string, string | number>): PaymentSourceRecord => ({
    id: 'src_x',
    userId: 'usr_1',
    type,
    details,
    createdAt,
  });

  test('creates a WalletSource', () => {
    const source = PaymentSourceFactory.create(record(PaymentSourceType.WALLET, { walletId: 'wal_9' }));
    assert.ok(source instanceof WalletSource);
    assert.equal(source.walletId, 'wal_9');
    assert.equal(source.id, 'src_x');
    assert.equal(source.userId, 'usr_1');
    assert.equal(source.createdAt, createdAt);
  });

  test('creates a BankAccountSource', () => {
    const source = PaymentSourceFactory.create(
      record(PaymentSourceType.BANK_ACCOUNT, { bankName: 'Axis Bank', accountLast4: '0042', ifsc: 'UTIB0000123' }),
    );
    assert.ok(source instanceof BankAccountSource);
    assert.equal(source.bankName, 'Axis Bank');
    assert.equal(source.accountLast4, '0042', 'leading zeros of the last four digits survive');
    assert.equal(source.ifsc, 'UTIB0000123');
  });

  test('creates a CardSource and coerces numeric fields that were stored as text', () => {
    const source = PaymentSourceFactory.create(
      record(PaymentSourceType.CARD, { network: 'Mastercard', last4: '4444', expiryMonth: '7', expiryYear: '2031' }),
    );
    assert.ok(source instanceof CardSource);
    assert.equal(source.network, 'Mastercard');
    assert.equal(source.last4, '4444');
    assert.equal(source.expiryMonth, 7);
    assert.equal(source.expiryYear, 2031);
  });

  test('round-trips each subclass through its persisted details', () => {
    const sources = [
      new WalletSource('src_1', 'usr_1', 'wal_1', createdAt),
      new BankAccountSource('src_2', 'usr_1', 'HDFC Bank', '6789', 'HDFC0001234', createdAt),
      new CardSource('src_3', 'usr_1', 'Visa', '1111', 12, 2030, createdAt),
    ];
    for (const source of sources) {
      const details = JSON.parse(JSON.stringify(source.details())) as Record<string, string | number>;
      const copy = PaymentSourceFactory.create({ id: source.id, userId: source.userId, type: source.type, details, createdAt });
      assert.equal(copy.constructor, source.constructor);
      assert.deepEqual(copy.details(), source.details());
      assert.equal(copy.describe(), source.describe());
      assert.equal(copy.ledgerAccountId(), source.ledgerAccountId());
    }
  });

  test('rejects an unknown source type', () => {
    assert.throws(
      () => PaymentSourceFactory.create(record('CRYPTO' as PaymentSourceType, {})),
      hasCode('UNSUPPORTED_SOURCE_TYPE'),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('LedgerEntry', () => {
  const fields = {
    prevHash: LedgerEntry.GENESIS_HASH,
    id: 'led_1',
    transactionId: 'txn_1',
    accountId: 'WALLET:wal_1',
    entryType: LedgerEntryType.DEBIT,
    amountPaise: 12_345,
    balanceAfterPaise: 55_000 as number | null,
    description: 'Paid to bob@miniupi',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const entryFrom = (overrides: Partial<ConstructorParameters<typeof LedgerEntry>[0]> = {}) =>
    new LedgerEntry({
      sequence: 1,
      id: fields.id,
      transactionId: fields.transactionId,
      accountId: fields.accountId,
      entryType: fields.entryType,
      amount: Money.ofPaise(fields.amountPaise),
      balanceAfter: Money.ofPaise(55_000),
      description: fields.description,
      prevHash: fields.prevHash,
      hash: LedgerEntry.computeHash(fields),
      createdAt: new Date(fields.createdAt),
      ...overrides,
    });

  test('the genesis hash is 64 zeros', () => {
    assert.equal(LedgerEntry.GENESIS_HASH, '0'.repeat(64));
  });

  test('computeHash is a deterministic SHA-256 digest', () => {
    const hash = LedgerEntry.computeHash(fields);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(LedgerEntry.computeHash({ ...fields }), hash);
    assert.notEqual(hash, LedgerEntry.GENESIS_HASH);
  });

  test('changing any stored field changes the hash, including the balance and the description', () => {
    const original = LedgerEntry.computeHash(fields);
    const variants: Array<Partial<typeof fields>> = [
      { prevHash: '1'.repeat(64) },
      { id: 'led_2' },
      { transactionId: 'txn_2' },
      { accountId: 'WALLET:wal_2' },
      { entryType: LedgerEntryType.CREDIT },
      { amountPaise: 12_346 },
      { balanceAfterPaise: 55_001 },
      { balanceAfterPaise: null },
      { balanceAfterPaise: 0 },
      { description: 'Paid to mallory@miniupi' },
      { description: '' },
      { createdAt: '2026-01-01T00:00:00.001Z' },
    ];
    const hashes = variants.map((change) => LedgerEntry.computeHash({ ...fields, ...change }));
    for (const hash of hashes) assert.notEqual(hash, original);
    assert.equal(new Set(hashes).size, variants.length, 'every variant hashes differently');
  });

  test('field boundaries are unambiguous: shifting characters between fields changes the hash', () => {
    const a = LedgerEntry.computeHash({ ...fields, id: 'led_1|x', transactionId: 'txn' });
    const b = LedgerEntry.computeHash({ ...fields, id: 'led_1', transactionId: 'x|txn' });
    const c = LedgerEntry.computeHash({ ...fields, accountId: 'WALLET:w', description: '","x' });
    const d = LedgerEntry.computeHash({ ...fields, accountId: 'WALLET:w","', description: 'x' });
    assert.notEqual(a, b);
    assert.notEqual(c, d);
  });

  test('an omitted balance and description hash like null and the empty string', () => {
    const { balanceAfterPaise: _balance, description: _description, ...minimal } = fields;
    assert.equal(
      LedgerEntry.computeHash(minimal),
      LedgerEntry.computeHash({ ...minimal, balanceAfterPaise: null, description: '' }),
    );
  });

  test('expectedHash matches the stored hash of an untouched entry', () => {
    const entry = entryFrom();
    assert.equal(entry.expectedHash(), entry.hash);

    const external = entryFrom({
      accountId: 'EXTERNAL:src_1',
      balanceAfter: null,
      hash: LedgerEntry.computeHash({ ...fields, accountId: 'EXTERNAL:src_1', balanceAfterPaise: null }),
    });
    assert.equal(external.expectedHash(), external.hash, 'an entry without a running balance verifies too');
  });

  test('expectedHash exposes an entry whose contents were altered after hashing', () => {
    const stored = LedgerEntry.computeHash(fields);
    const tampered = [
      entryFrom({ amount: Money.ofPaise(99_999) }),
      entryFrom({ accountId: 'WALLET:attacker' }),
      entryFrom({ prevHash: 'f'.repeat(64) }),
      entryFrom({ balanceAfter: Money.ofPaise(9_999_999) }),
      entryFrom({ balanceAfter: null }),
      entryFrom({ description: 'Paid to attacker@miniupi' }),
      entryFrom({ entryType: LedgerEntryType.CREDIT }),
      entryFrom({ transactionId: 'txn_other' }),
      entryFrom({ createdAt: new Date('2020-01-01T00:00:00.000Z') }),
    ];
    for (const entry of tampered) {
      assert.equal(entry.hash, stored);
      assert.notEqual(entry.expectedHash(), stored);
    }
  });

  test('entries chain: the next entry commits to the hash of the previous one', () => {
    const first = entryFrom();
    const secondFields = { ...fields, id: 'led_2', entryType: LedgerEntryType.CREDIT, prevHash: first.hash };
    const second = entryFrom({
      sequence: 2,
      id: 'led_2',
      entryType: LedgerEntryType.CREDIT,
      prevHash: first.hash,
      hash: LedgerEntry.computeHash(secondFields),
    });
    assert.equal(second.prevHash, first.hash);
    assert.equal(second.expectedHash(), second.hash);
    assert.notEqual(second.hash, first.hash);

    // Rewriting the first entry changes its hash, so the second no longer links to it.
    const rewrittenFirst = LedgerEntry.computeHash({ ...fields, amountPaise: 1 });
    assert.notEqual(second.prevHash, rewrittenFirst);
  });

  test('an entry is frozen: it cannot be modified after construction', () => {
    const entry = entryFrom();
    assert.equal(Object.isFrozen(entry), true);
    assert.throws(() => {
      (entry as { description: string }).description = 'rewritten';
    }, TypeError);
    assert.throws(() => {
      (entry as { amount: Money }).amount = Money.ofPaise(1);
    }, TypeError);
    assert.equal(entry.description, 'Paid to bob@miniupi');
  });
});

// ---------------------------------------------------------------------------------------------
describe('ScheduledPayment', () => {
  const executeAt = new Date('2026-06-01T10:00:00.000Z');
  const scheduled = (status = ScheduledPaymentStatus.PENDING) =>
    new ScheduledPayment({
      id: 'sch_1',
      userId: 'usr_1',
      receiverUpiId: 'bob@miniupi',
      sourceId: null,
      amount: Money.fromRupees(50),
      note: 'rent',
      executeAt,
      status,
      transactionId: null,
      failureReason: null,
      createdAt: new Date('2026-05-01T10:00:00.000Z'),
    });

  test('is due from its execution time onwards, while it is pending', () => {
    const payment = scheduled();
    assert.equal(payment.isDue(new Date(executeAt.getTime() - 1)), false);
    assert.equal(payment.isDue(executeAt), true);
    assert.equal(payment.isDue(new Date(executeAt.getTime() + 1)), true);
  });

  test('is never due once it is running, executed, failed or cancelled', () => {
    for (const status of [
      ScheduledPaymentStatus.RUNNING,
      ScheduledPaymentStatus.EXECUTED,
      ScheduledPaymentStatus.FAILED,
      ScheduledPaymentStatus.CANCELLED,
    ]) {
      assert.equal(scheduled(status).isDue(new Date(executeAt.getTime() + 1_000)), false, status);
    }
  });

  test('PENDING -> RUNNING -> EXECUTED records the transaction', () => {
    const payment = scheduled();
    payment.markRunning();
    assert.equal(payment.status, ScheduledPaymentStatus.RUNNING);
    payment.markExecuted('txn_9');
    assert.equal(payment.status, ScheduledPaymentStatus.EXECUTED);
    assert.equal(payment.transactionId, 'txn_9');
    assert.equal(payment.failureReason, null);
  });

  test('PENDING -> RUNNING -> FAILED records the reason and the transaction, if there was one', () => {
    const failed = scheduled();
    failed.markRunning();
    failed.markFailed('Wallet balance is too low', 'txn_8');
    assert.equal(failed.status, ScheduledPaymentStatus.FAILED);
    assert.equal(failed.failureReason, 'Wallet balance is too low');
    assert.equal(failed.transactionId, 'txn_8');

    const neverStarted = scheduled();
    neverStarted.markRunning();
    neverStarted.markFailed('The payment could not be started.', null);
    assert.equal(neverStarted.transactionId, null);
  });

  test('PENDING -> CANCELLED', () => {
    const cancelled = scheduled();
    cancelled.cancel();
    assert.equal(cancelled.status, ScheduledPaymentStatus.CANCELLED);
  });

  const conflict = (code: string) => (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, code);
    assert.equal(error.category, 'CONFLICT');
    return true;
  };

  test('a payment must be claimed (RUNNING) before it can be completed or failed', () => {
    for (const status of [
      ScheduledPaymentStatus.PENDING,
      ScheduledPaymentStatus.EXECUTED,
      ScheduledPaymentStatus.FAILED,
      ScheduledPaymentStatus.CANCELLED,
    ]) {
      const completing = scheduled(status);
      assert.throws(() => completing.markExecuted('txn_1'), conflict('SCHEDULE_NOT_RUNNING'), `markExecuted from ${status}`);
      assert.equal(completing.status, status);
      assert.equal(completing.transactionId, null);

      const failing = scheduled(status);
      assert.throws(() => failing.markFailed('reason', null), conflict('SCHEDULE_NOT_RUNNING'), `markFailed from ${status}`);
      assert.equal(failing.status, status);
      assert.equal(failing.failureReason, null);
    }
  });

  test('only a pending payment can be claimed or cancelled', () => {
    for (const status of [
      ScheduledPaymentStatus.RUNNING,
      ScheduledPaymentStatus.EXECUTED,
      ScheduledPaymentStatus.FAILED,
      ScheduledPaymentStatus.CANCELLED,
    ]) {
      const claiming = scheduled(status);
      assert.throws(() => claiming.markRunning(), conflict('SCHEDULE_NOT_PENDING'), `markRunning from ${status}`);
      assert.equal(claiming.status, status);

      const cancelling = scheduled(status);
      assert.throws(() => cancelling.cancel(), conflict('SCHEDULE_NOT_PENDING'), `cancel from ${status}`);
      assert.equal(cancelling.status, status);
    }
  });

  test('a running payment can no longer be cancelled, and it finishes exactly once', () => {
    const payment = scheduled();
    payment.markRunning();
    assert.throws(() => payment.cancel(), conflict('SCHEDULE_NOT_PENDING'));
    payment.markExecuted('txn_1');
    assert.throws(() => payment.markExecuted('txn_2'), conflict('SCHEDULE_NOT_RUNNING'));
    assert.throws(() => payment.markFailed('late failure', null), conflict('SCHEDULE_NOT_RUNNING'));
    assert.equal(payment.transactionId, 'txn_1');
  });

  test('its idempotency key is stable and derived from the schedule id', () => {
    const payment = scheduled();
    assert.equal(payment.idempotencyKey(), 'scheduled:sch_1');
    assert.equal(payment.idempotencyKey(), scheduled().idempotencyKey());
  });
});

// ---------------------------------------------------------------------------------------------
describe('User and PinHasher', () => {
  test('a PIN verifies against its own hash and salt only', () => {
    const { hash, salt } = PinHasher.hash('1234');
    assert.equal(PinHasher.verify('1234', hash, salt), true);
    assert.equal(PinHasher.verify('1235', hash, salt), false);
    assert.equal(PinHasher.verify('', hash, salt), false);
    assert.equal(PinHasher.verify('1234', hash, PinHasher.hash('1234').salt), false);
  });

  test('the same PIN hashes differently every time (random salt)', () => {
    const first = PinHasher.hash('1234');
    const second = PinHasher.hash('1234');
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.hash, second.hash);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.match(first.salt, /^[0-9a-f]{32}$/);
  });

  test('a User answers "is this PIN right?" without exposing the hash', () => {
    const { hash, salt } = PinHasher.hash('4321');
    const user = new User({
      id: 'usr_1',
      name: 'Alice',
      upiId: 'alice@miniupi',
      phone: '9876543210',
      email: null,
      pinHash: hash,
      pinSalt: salt,
      status: UserStatus.ACTIVE,
      dailyLimit: Money.fromRupees(50_000),
      notificationChannels: [NotificationChannelType.SMS],
      blacklisted: false,
      createdAt: new Date(),
    });
    assert.equal(user.verifyPin('4321'), true);
    assert.equal(user.verifyPin('1234'), false);
    assert.equal(user.isActive(), true);
    assert.equal(JSON.stringify(user).includes(hash), false, 'the hash must not serialise with the user');
    assert.equal(Object.values(user).includes(hash), false);
  });

  test('a blocked user is not active', () => {
    const { hash, salt } = PinHasher.hash('4321');
    const user = new User({
      id: 'usr_2',
      name: 'Mallory',
      upiId: 'mallory@miniupi',
      phone: '9876543299',
      email: null,
      pinHash: hash,
      pinSalt: salt,
      status: UserStatus.BLOCKED,
      dailyLimit: Money.fromRupees(1),
      notificationChannels: [],
      blacklisted: true,
      createdAt: new Date(),
    });
    assert.equal(user.isActive(), false);
  });
});
