import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { LedgerEntryType, PaymentSourceType, TransactionStatus, TransactionType, WalletStatus } from '../src/domain/enums';
import { OptimisticLockError } from '../src/domain/errors';
import { LedgerEntry, type LedgerEntryProps } from '../src/domain/LedgerEntry';
import { Money } from '../src/domain/Money';
import { Transaction } from '../src/domain/Transaction';
import { Wallet } from '../src/domain/Wallet';
import { PrimaryDatabase, type SqlReader } from '../src/infrastructure/db/Database';
import type { LedgerRepository, TransactionEventRepository, WalletRepository } from '../src/repository/interfaces';
import { SqliteWalletRepository } from '../src/repository/sqlite/AccountRepositories';
import {
  SqliteTransactionEventRepository,
  SqliteTransactionRepository,
} from '../src/repository/sqlite/TransactionRepositories';
import { LedgerService } from '../src/service/LedgerService';
import {
  balanceOf,
  closeApp,
  createTestApp,
  fund,
  ledgerOf,
  linkBank,
  linkCard,
  pay,
  primaryOf,
  registerUser,
  storedBalanceOf,
  verifyLedger,
} from './helpers';

// ---------------------------------------------------------------------------------------------
describe('ledger of the running application', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  afterEach(() => app.chaos.reset());

  after(() => closeApp(app));

  test('an empty ledger is healthy, and there is nothing to tamper with', async () => {
    const empty = await createTestApp();
    try {
      assert.deepEqual(verifyLedger(empty), {
        healthy: true,
        entries: 0,
        chainIntact: true,
        brokenAtSequence: null,
        unbalancedTransactions: [],
        walletMismatches: [],
      });
      const attempt = empty.system.attemptLedgerTamper();
      for (const result of [attempt.update, attempt.delete, attempt.replace]) {
        assert.deepEqual(result, { blocked: true, databaseSaid: 'no rows to change' });
      }
    } finally {
      await closeApp(empty);
    }
  });

  test('verify is healthy after a mix of top-ups, payments, refusals, refunds and a compensated saga', async () => {
    const [alice, bob, carol] = [registerUser(app), registerUser(app), registerUser(app)];
    const before = verifyLedger(app).entries;

    const bank = await fund(app, alice, 5_000); //                     2 entries
    const card = linkCard(app, bob);
    await pay(app, bob, bob, 1_200, { sourceId: card.id }); //          2 entries (card top-up)
    const lunch = await pay(app, alice, bob, 450.25); //                2 entries
    await pay(app, bob, carol, 99.99); //                               2 entries
    await pay(app, carol, alice, 5_000); //                             refused: insufficient balance
    await pay(app, alice, alice, 10); //                                refused: self transfer
    await pay(app, alice, carol, 300, { sourceId: bank.id }); //        2 entries (bank-funded P2P)
    await app.refunds.refund(lunch.result.transaction.id, bob); //      2 reversing entries
    app.chaos.update({ failNextCredit: true });
    await pay(app, alice, bob, 700, { sourceId: bank.id }); //          saga: refunded, nothing posted
    app.chaos.update({ bank: { down: true } });
    await pay(app, alice, alice, 100, { sourceId: bank.id }); //        gateway down: nothing posted

    const audit = verifyLedger(app);
    assert.deepEqual(
      { ...audit, entries: audit.entries - before },
      { healthy: true, entries: 12, chainIntact: true, brokenAtSequence: null, unbalancedTransactions: [], walletMismatches: [] },
    );
    assert.equal(balanceOf(app, alice), 500_000);
    assert.equal(balanceOf(app, bob), 120_000 - 9_999);
    assert.equal(balanceOf(app, carol), 9_999 + 30_000);
  });

  test('every entry links to the one before it, from the genesis hash onwards', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    await pay(app, alice, bob, 40);

    const entries = app.ledger.recent(primaryOf(app), 200).reverse(); // oldest first
    assert.ok(entries.length >= 4);
    assert.equal(entries[0].prevHash, '0'.repeat(64));
    for (let i = 1; i < entries.length; i += 1) {
      assert.equal(entries[i].prevHash, entries[i - 1].hash, `entry ${entries[i].sequence} does not link to its predecessor`);
      assert.equal(entries[i].sequence, entries[i - 1].sequence! + 1);
    }
    assert.equal(new Set(entries.map((entry) => entry.hash)).size, entries.length);
  });

  test('every posting is double entry: per transaction, debits equal credits', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 300);
    const paid = await pay(app, alice, bob, 120);
    await app.refunds.refund(paid.result.transaction.id, bob);

    const rows = primaryOf(app).all<{ transaction_id: string; debits: number; credits: number }>(
      `SELECT transaction_id,
              SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount_paise ELSE 0 END) AS debits,
              SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_paise ELSE 0 END) AS credits
         FROM ledger_entries GROUP BY transaction_id`,
    );
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.debits, row.credits, `transaction ${row.transaction_id} is unbalanced`);
  });

  test('every wallet balance equals the sum of its ledger entries', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    await pay(app, alice, bob, 333.33);
    await pay(app, bob, alice, 0.33);

    for (const user of [alice, bob]) {
      const walletId = app.users.walletOf(user.id).id;
      const row = primaryOf(app).get<{ net: number }>(
        `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_paise ELSE -amount_paise END), 0) AS net
           FROM ledger_entries WHERE account_id = ?`,
        `WALLET:${walletId}`,
      )!;
      assert.equal(row.net, storedBalanceOf(app, user));
    }
  });

  test('the running balance on each wallet entry is the balance right after that entry', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const first = await pay(app, alice, bob, 100);
    const second = await pay(app, alice, bob, 250);

    assert.deepEqual(
      ledgerOf(app, first.result.transaction.id).map((entry) => entry.balanceAfter),
      [900, 100],
    );
    assert.deepEqual(
      ledgerOf(app, second.result.transaction.id).map((entry) => entry.balanceAfter),
      [650, 350],
    );
  });

  test('the audit trail never disagrees with the stored status of a transaction', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    const bank = await fund(app, alice, 500);
    const paid = await pay(app, alice, bob, 100);
    await pay(app, alice, bob, 9_000); // refused
    await app.refunds.refund(paid.result.transaction.id, bob);
    app.chaos.update({ failNextCredit: true });
    await pay(app, alice, bob, 50, { sourceId: bank.id }); // compensated

    const rows = primaryOf(app).all<{ id: string; status: string; last_event: string | null; events: number }>(
      `SELECT t.id, t.status,
              (SELECT e.to_status FROM transaction_events e WHERE e.transaction_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event,
              (SELECT COUNT(*) FROM transaction_events e WHERE e.transaction_id = t.id) AS events
         FROM transactions t`,
    );
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.equal(row.last_event, row.status, `transaction ${row.id}: status ${row.status}, last event ${row.last_event}`);
      assert.ok(row.events >= 2, 'at least INITIATED and one outcome');
    }
    const statuses = new Set(rows.map((row) => row.status));
    for (const expected of ['SUCCESS', 'FAILED', 'REFUNDED']) assert.ok(statuses.has(expected), `no ${expected} transaction in the mix`);
  });

  test('the tamper test: UPDATE, DELETE and REPLACE of a ledger entry are all refused by the database', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    await pay(app, alice, bob, 25);
    const before = app.ledger.recent(primaryOf(app), 500);

    const attempt = app.system.attemptLedgerTamper();

    assert.deepEqual(Object.keys(attempt).sort(), ['delete', 'replace', 'update']);
    assert.equal(attempt.update.blocked, true);
    assert.match(attempt.update.databaseSaid, /append-only: UPDATE is not allowed/);
    assert.equal(attempt.delete.blocked, true);
    assert.match(attempt.delete.databaseSaid, /append-only: DELETE is not allowed/);
    assert.equal(attempt.replace.blocked, true);
    assert.match(attempt.replace.databaseSaid, /append-only/);

    assert.deepEqual(app.ledger.recent(primaryOf(app), 500), before, 'not a single entry changed');
    assert.equal(verifyLedger(app).healthy, true);
  });

  test('the refused tampering does not reach or disturb the replica', async () => {
    const alice = registerUser(app);
    await fund(app, alice, 100);
    app.system.attemptLedgerTamper();
    await app.settle();

    const replica = app.readRouter.route();
    assert.equal(replica.role, 'replica');
    assert.deepEqual(app.ledger.recent(replica, 500), app.ledger.recent(primaryOf(app), 500));
    assert.equal(app.system.snapshot().database.replication.resyncs, 0);
  });

  test('recent() returns the newest entries first and honours the limit', async () => {
    const alice = registerUser(app);
    await fund(app, alice, 10);
    await fund(app, alice, 20, app.users.sourcesOf(alice.id).find((s) => s.type === 'BANK_ACCOUNT'));
    const recent = app.ledger.recent(primaryOf(app), 3);
    assert.equal(recent.length, 3);
    assert.ok(recent[0].sequence! > recent[1].sequence! && recent[1].sequence! > recent[2].sequence!);
    assert.equal(recent[0].amount, 20);
  });
});

// ---------------------------------------------------------------------------------------------
describe('LedgerService in isolation (in-memory repositories)', () => {
  const reader = {} as SqlReader;

  class InMemoryLedger implements LedgerRepository {
    entries: LedgerEntry[] = [];

    append(entry: LedgerEntry): void {
      this.entries.push(copyOf(entry, { sequence: this.entries.length + 1 }));
    }
    lastHash(): string {
      return this.entries.at(-1)?.hash ?? LedgerEntry.GENESIS_HASH;
    }
    findByTransaction(_reader: SqlReader, transactionId: string): LedgerEntry[] {
      return this.entries.filter((entry) => entry.transactionId === transactionId);
    }
    findRecent(_reader: SqlReader, limit: number): LedgerEntry[] {
      return [...this.entries].reverse().slice(0, limit);
    }
    findAllInOrder(): LedgerEntry[] {
      return [...this.entries];
    }
  }

  class InMemoryWallets implements WalletRepository {
    constructor(private readonly wallets: Wallet[]) {}
    insert(wallet: Wallet): void {
      this.wallets.push(wallet);
    }
    findByUserId(userId: string): Wallet | undefined {
      return this.wallets.find((wallet) => wallet.userId === userId);
    }
    findByUserIdForUpdate(userId: string): Wallet | undefined {
      return this.findByUserId(userId);
    }
    save(): void {}
    findAll(): Wallet[] {
      return this.wallets;
    }
  }

  function copyOf(entry: LedgerEntry, overrides: Partial<LedgerEntryProps>): LedgerEntry {
    return new LedgerEntry({
      sequence: entry.sequence,
      id: entry.id,
      transactionId: entry.transactionId,
      accountId: entry.accountId,
      entryType: entry.entryType,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      description: entry.description,
      prevHash: entry.prevHash,
      hash: entry.hash,
      createdAt: entry.createdAt,
      ...overrides,
    });
  }

  const wallet = (id: string, paise: number) =>
    new Wallet(id, `usr_${id}`, Money.ofPaise(paise), 0, WalletStatus.ACTIVE, new Date());

  const transaction = (id: string, rupees: number) =>
    Transaction.rehydrate({
      id,
      idempotencyKey: `key-${id}`,
      type: TransactionType.P2P,
      senderId: 'usr_a',
      receiverId: 'usr_b',
      sourceId: 'src_a',
      sourceType: PaymentSourceType.WALLET,
      amount: Money.fromRupees(rupees),
      note: '',
      status: TransactionStatus.PROCESSING,
      failureCode: null,
      failureReason: null,
      fundsCaptured: false,
      gatewayReference: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  /** External account funds wallet A with Rs 100, then A pays B Rs 30. */
  function scenario() {
    const ledger = new InMemoryLedger();
    const a = wallet('a', 7_000);
    const b = wallet('b', 3_000);
    const service = new LedgerService(ledger, new InMemoryWallets([a, b]));
    service.record(transaction('txn_1', 100), [
      { accountId: 'EXTERNAL:src_bank', entryType: LedgerEntryType.DEBIT, balanceAfter: null, description: 'Charged the bank' },
      { accountId: 'WALLET:a', entryType: LedgerEntryType.CREDIT, balanceAfter: Money.ofPaise(10_000), description: 'Top-up' },
    ]);
    service.record(transaction('txn_2', 30), [
      { accountId: 'WALLET:a', entryType: LedgerEntryType.DEBIT, balanceAfter: Money.ofPaise(7_000), description: 'Paid to b' },
      { accountId: 'WALLET:b', entryType: LedgerEntryType.CREDIT, balanceAfter: Money.ofPaise(3_000), description: 'Received from a' },
    ]);
    return { ledger, service };
  }

  test('record appends one entry per line, each chained to the previous hash', () => {
    const { ledger } = scenario();
    assert.equal(ledger.entries.length, 4);
    assert.equal(ledger.entries[0].prevHash, LedgerEntry.GENESIS_HASH);
    for (let i = 1; i < 4; i += 1) assert.equal(ledger.entries[i].prevHash, ledger.entries[i - 1].hash);
    for (const entry of ledger.entries) {
      assert.equal(entry.expectedHash(), entry.hash);
      assert.match(entry.id, /^led_[0-9a-f]{16}$/);
    }
    assert.equal(ledger.entries[0].amount.paise, 10_000, 'every line carries the transaction amount');
    assert.equal(ledger.entries[2].amount.paise, 3_000);
    assert.equal(ledger.entries[0].createdAt.getTime(), ledger.entries[1].createdAt.getTime());
  });

  const unbalanced: Array<[string, LedgerEntryType[]]> = [
    ['no lines at all', []],
    ['a single debit', [LedgerEntryType.DEBIT]],
    ['a single credit', [LedgerEntryType.CREDIT]],
    ['two debits and one credit', [LedgerEntryType.DEBIT, LedgerEntryType.DEBIT, LedgerEntryType.CREDIT]],
    ['two credits', [LedgerEntryType.CREDIT, LedgerEntryType.CREDIT]],
  ];
  for (const [label, types] of unbalanced) {
    test(`record refuses a posting with ${label} and writes nothing`, () => {
      const { ledger, service } = scenario();
      assert.throws(
        () =>
          service.record(
            transaction('txn_bad', 10),
            types.map((entryType, i) => ({ accountId: `WALLET:x${i}`, entryType, balanceAfter: null, description: 'bad' })),
          ),
        /Unbalanced ledger posting for txn_bad/,
      );
      assert.equal(ledger.entries.length, 4);
    });
  }

  test('verify passes on an untouched ledger whose wallets match', () => {
    const { service } = scenario();
    assert.deepEqual(service.verify(reader), {
      healthy: true,
      entries: 4,
      chainIntact: true,
      brokenAtSequence: null,
      unbalancedTransactions: [],
      walletMismatches: [],
    });
  });

  test('verify pinpoints an entry whose amount was rewritten', () => {
    const { ledger, service } = scenario();
    ledger.entries[2] = copyOf(ledger.entries[2], { amount: Money.ofPaise(1) }); // "A paid only 1 paisa"

    const audit = service.verify(reader);
    assert.equal(audit.healthy, false);
    assert.equal(audit.chainIntact, false);
    assert.equal(audit.brokenAtSequence, 3);
    assert.deepEqual(audit.unbalancedTransactions, ['txn_2']);
    assert.deepEqual(audit.walletMismatches, [{ walletId: 'a', ledgerPaise: 9_999, balancePaise: 7_000 }]);
  });

  test('verify notices a rewritten running balance or description, which change no totals', () => {
    for (const change of [{ balanceAfter: Money.ofPaise(999_999) }, { description: 'Paid to someone else' }, { balanceAfter: null }]) {
      const { ledger, service } = scenario();
      ledger.entries[1] = copyOf(ledger.entries[1], change);
      const audit = service.verify(reader);
      assert.equal(audit.chainIntact, false, `change ${JSON.stringify(Object.keys(change))} went unnoticed`);
      assert.equal(audit.brokenAtSequence, 2);
      assert.equal(audit.healthy, false);
      assert.deepEqual(audit.unbalancedTransactions, []);
    }
  });

  test('verify notices an entry rewritten together with a freshly computed hash: the next link breaks', () => {
    const { ledger, service } = scenario();
    const forged = copyOf(ledger.entries[1], { description: 'forged' });
    ledger.entries[1] = copyOf(forged, { hash: forged.expectedHash() });

    const audit = service.verify(reader);
    assert.equal(audit.chainIntact, false);
    assert.equal(audit.brokenAtSequence, 3, 'entry 3 still commits to the original hash of entry 2');
  });

  test('verify notices a removed entry', () => {
    const { ledger, service } = scenario();
    ledger.entries.splice(1, 1);
    const audit = service.verify(reader);
    assert.equal(audit.chainIntact, false);
    assert.equal(audit.brokenAtSequence, 3);
    assert.deepEqual(audit.unbalancedTransactions, ['txn_1']);
  });

  test('verify reports a wallet whose stored balance drifted from the ledger', () => {
    const ledger = new InMemoryLedger();
    const service = new LedgerService(ledger, new InMemoryWallets([wallet('a', 10_001), wallet('untouched', 0), wallet('ghost', 500)]));
    service.record(transaction('txn_1', 100), [
      { accountId: 'EXTERNAL:src', entryType: LedgerEntryType.DEBIT, balanceAfter: null, description: 'Charged' },
      { accountId: 'WALLET:a', entryType: LedgerEntryType.CREDIT, balanceAfter: Money.ofPaise(10_000), description: 'Top-up' },
    ]);

    const audit = service.verify(reader);
    assert.equal(audit.chainIntact, true);
    assert.equal(audit.healthy, false);
    assert.deepEqual(audit.walletMismatches, [
      { walletId: 'a', ledgerPaise: 10_000, balancePaise: 10_001 },
      { walletId: 'ghost', ledgerPaise: 0, balancePaise: 500 },
    ]);
  });

  test('forTransaction and recent map entries to plain views', () => {
    const { service } = scenario();
    const views = service.forTransaction(reader, 'txn_2');
    assert.deepEqual(
      views.map(({ accountId, entryType, amount, balanceAfter }) => ({ accountId, entryType, amount, balanceAfter })),
      [
        { accountId: 'WALLET:a', entryType: 'DEBIT', amount: 30, balanceAfter: 70 },
        { accountId: 'WALLET:b', entryType: 'CREDIT', amount: 30, balanceAfter: 30 },
      ],
    );
    assert.deepEqual(
      service.recent(reader, 2).map((view) => view.sequence),
      [4, 3],
    );
    assert.equal(service.forTransaction(reader, 'txn_1')[0].balanceAfter, null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('transaction and wallet repositories: atomic audit trail and optimistic locking', () => {
  let primary: PrimaryDatabase;
  let events: SqliteTransactionEventRepository;
  let repository: SqliteTransactionRepository;

  beforeEach(() => {
    primary = new PrimaryDatabase(':memory:');
    events = new SqliteTransactionEventRepository(primary);
    repository = new SqliteTransactionRepository(primary, events);
    for (const id of ['usr_a', 'usr_b']) {
      primary.run(
        `INSERT INTO users (id, name, upi_id, phone, pin_hash, pin_salt, status, daily_limit_paise, notification_channels, created_at)
         VALUES (?, ?, ?, ?, 'hash', 'salt', 'ACTIVE', 0, '[]', 'now')`,
        id,
        id,
        `${id}@miniupi`,
        `phone-${id}`,
      );
      primary.run(
        `INSERT INTO wallets (id, user_id, balance_paise, version, status, updated_at) VALUES (?, ?, 10000, 0, 'ACTIVE', 'now')`,
        `wal_${id}`,
        id,
      );
    }
    primary.run(`INSERT INTO payment_sources (id, user_id, type, details, created_at) VALUES ('src_a', 'usr_a', 'WALLET', '{"walletId":"wal_usr_a"}', 'now')`);
  });

  afterEach(() => primary.close());

  const newTransaction = (id = 'txn_1') =>
    Transaction.builder()
      .withId(id)
      .withIdempotencyKey(`key-${id}`)
      .from('usr_a')
      .to('usr_b')
      .fundedBy('src_a', PaymentSourceType.WALLET)
      .forAmount(Money.fromRupees(10))
      .build();

  const timeline = (id = 'txn_1') => events.findByTransaction(primary, id).map((event) => event.to);
  const storedRow = (id = 'txn_1') =>
    primary.get<{ status: string; version: number; funds_captured: number }>(
      'SELECT status, version, funds_captured FROM transactions WHERE id = ?',
      id,
    )!;

  test('insert stores the row and its INITIATED event in one commit', () => {
    const txn = newTransaction();
    const lsnBefore = primary.lastLsn;

    repository.insert(txn);

    assert.equal(primary.lastLsn, lsnBefore + 1, 'row and event were shipped as one unit of work');
    assert.equal(storedRow().status, 'INITIATED');
    assert.equal(storedRow().version, 0);
    assert.deepEqual(timeline(), ['INITIATED']);
    assert.deepEqual(txn.unrecordedTransitions(), []);
    assert.deepEqual(
      events.findUnpublished('txn_1').map((event) => event.to),
      ['INITIATED'],
      'the event is stored unpublished: it waits in the outbox for the relay',
    );
  });

  test('update stores the new status and every new transition together, and bumps the version', () => {
    const txn = newTransaction();
    repository.insert(txn);
    txn.startProcessing();
    txn.succeed();
    const lsnBefore = primary.lastLsn;

    repository.update(txn);

    assert.equal(primary.lastLsn, lsnBefore + 1);
    assert.deepEqual(storedRow(), Object.assign(Object.create(null), { status: 'SUCCESS', version: 1, funds_captured: 0 }));
    assert.deepEqual(timeline(), ['INITIATED', 'PROCESSING', 'SUCCESS']);
    assert.equal(txn.version, 1);
    assert.equal(repository.findById('txn_1')!.version, 1);
  });

  test('an update without a state change (funds captured) writes no audit event', () => {
    const txn = newTransaction();
    repository.insert(txn);
    txn.markFundsCaptured('BANK-000001');
    repository.update(txn);

    assert.deepEqual(timeline(), ['INITIATED']);
    assert.equal(storedRow().funds_captured, 1);
    assert.equal(storedRow().version, 1);
    assert.deepEqual(
      repository.findCaptured().map((captured) => [captured.id, captured.gatewayReference]),
      [['txn_1', 'BANK-000001']],
    );
  });

  test('a stale object cannot overwrite a newer row: OptimisticLockError, and no event is written', () => {
    repository.insert(newTransaction());
    const first = repository.findById('txn_1')!;
    const stale = repository.findById('txn_1')!;

    first.startProcessing();
    repository.update(first);

    stale.fail('LOCK_TIMEOUT', 'gave up');
    assert.throws(
      () => repository.update(stale),
      (error: unknown) => {
        assert.ok(error instanceof OptimisticLockError);
        assert.equal(error.code, 'CONCURRENT_MODIFICATION');
        assert.equal(error.category, 'CONFLICT');
        assert.deepEqual(error.details, { entity: 'Transaction', id: 'txn_1' });
        return true;
      },
    );

    assert.equal(storedRow().status, 'PROCESSING', 'the newer status survived');
    assert.equal(storedRow().version, 1);
    assert.deepEqual(timeline(), ['INITIATED', 'PROCESSING'], 'the FAILED event of the rejected write was rolled back');
    assert.equal(stale.version, 0);
    assert.equal(stale.unrecordedTransitions().length, 1, 'the rejected transition is still unrecorded');
  });

  test('the same object can be saved repeatedly as it moves through its lifecycle', () => {
    const txn = newTransaction();
    repository.insert(txn);
    txn.startProcessing();
    repository.update(txn);
    txn.succeed();
    repository.update(txn);
    txn.refund();
    repository.update(txn);

    assert.equal(txn.version, 3);
    assert.equal(storedRow().version, 3);
    assert.deepEqual(timeline(), ['INITIATED', 'PROCESSING', 'SUCCESS', 'REFUNDED']);
  });

  test('if the audit event cannot be written, the status change is not stored either', () => {
    const failing: TransactionEventRepository = {
      append: () => {
        throw new Error('disk full');
      },
      findByTransaction: () => [],
      findUnpublished: () => [],
      markPublished: () => undefined,
      findTransactionsWithUnpublished: () => [],
    };
    const brittle = new SqliteTransactionRepository(primary, failing);

    assert.throws(() => brittle.insert(newTransaction('txn_lost')), /disk full/);
    assert.equal(primary.get('SELECT id FROM transactions WHERE id = ?', 'txn_lost'), undefined);

    const txn = newTransaction('txn_kept');
    repository.insert(txn);
    txn.startProcessing();
    assert.throws(() => brittle.update(txn), /disk full/);
    assert.equal(storedRow('txn_kept').status, 'INITIATED');
    assert.equal(storedRow('txn_kept').version, 0);
    assert.equal(txn.version, 0);
  });

  test('one idempotency key per sender is enforced by the database itself', () => {
    repository.insert(newTransaction('txn_1'));
    const duplicate = Transaction.builder()
      .withId('txn_2')
      .withIdempotencyKey('key-txn_1')
      .from('usr_a')
      .to('usr_b')
      .fundedBy('src_a', PaymentSourceType.WALLET)
      .forAmount(Money.fromRupees(10))
      .build();
    assert.throws(() => repository.insert(duplicate), /UNIQUE constraint failed/);
    assert.equal(repository.findBySenderAndKey('usr_a', 'key-txn_1')!.id, 'txn_1');
    assert.equal(repository.findBySenderAndKey('usr_b', 'key-txn_1'), undefined);
    assert.deepEqual(timeline('txn_2'), []);
  });

  test('a wallet read before someone else saved it cannot be saved: OptimisticLockError', () => {
    const wallets = new SqliteWalletRepository(primary);
    const first = wallets.findByUserIdForUpdate('usr_a')!;
    const stale = wallets.findByUserIdForUpdate('usr_a')!;

    first.debit(Money.ofPaise(4_000));
    wallets.save(first);
    assert.equal(first.version, 1);

    stale.debit(Money.ofPaise(9_000)); // would overdraw the real balance of 6,000
    assert.throws(
      () => wallets.save(stale),
      (error: unknown) => {
        assert.ok(error instanceof OptimisticLockError);
        assert.deepEqual(error.details, { entity: 'Wallet', id: 'wal_usr_a' });
        return true;
      },
    );
    assert.equal(wallets.findByUserId('usr_a')!.balance.paise, 6_000);
    assert.equal(wallets.findByUserId('usr_a')!.version, 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('seeded demo data', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp({ seedDemoData: true });
  });

  after(() => closeApp(app));

  const byHandle = (handle: string) => {
    const user = app.users.findByUpiId(`${handle}@miniupi`);
    assert.ok(user, `seeded user ${handle} is missing`);
    return user;
  };

  const assertSeededWorld = () => {
    assert.deepEqual(
      app.users.list().map((user) => user.upiId),
      ['alice@miniupi', 'bob@miniupi', 'charlie@miniupi', 'diya.store@miniupi', 'quickloan@miniupi'],
    );
    // Opening top-ups 25,000 / 8,000 / 2,500 / 12,000, then four payments between them.
    assert.equal(balanceOf(app, byHandle('alice')), (25_000 - 450 + 120 - 899 + 300) * 100);
    assert.equal(balanceOf(app, byHandle('bob')), (8_000 + 450 - 120) * 100);
    assert.equal(balanceOf(app, byHandle('charlie')), (2_500 - 300) * 100);
    assert.equal(balanceOf(app, byHandle('diya.store')), (12_000 + 899) * 100);
    assert.equal(balanceOf(app, byHandle('quickloan')), 0);

    const audit = verifyLedger(app);
    assert.equal(audit.healthy, true);
    assert.equal(audit.entries, 16, '8 seeded transactions, two entries each');
    assert.deepEqual(app.system.snapshot().transactions, { INITIATED: 0, PROCESSING: 0, SUCCESS: 8, FAILED: 0, REFUNDED: 0 });
  };

  test('the seeded balances are fully explained by the ledger', () => {
    assertSeededWorld();
    assert.equal(byHandle('quickloan').blacklisted, true);
    assert.equal(byHandle('charlie').dailyLimit.paise, 500_000);
    assert.equal(byHandle('alice').verifyPin('1234'), true);
    assert.deepEqual(
      app.users.sourcesOf(byHandle('alice').id).map((source) => source.type),
      ['WALLET', 'BANK_ACCOUNT', 'CARD'],
      'in the order they were linked, even when linked within the same millisecond',
    );
  });

  test('seeding is skipped when users already exist', async () => {
    const again = await createTestApp({ seedDemoData: false });
    try {
      assert.deepEqual(again.users.list(), []);
    } finally {
      await closeApp(again);
    }
  });

  test('resetDemo wipes everything and rebuilds the same world, with the ledger still append-only', async () => {
    const oldAlice = byHandle('alice');
    const bank = linkBank(app, oldAlice);
    await pay(app, oldAlice, oldAlice, 1_000, { sourceId: bank.id });
    await pay(app, oldAlice, byHandle('bob'), 500);
    app.chaos.update({ bank: { down: true }, replicaLagMs: 1_234 });
    app.system.setNodeHealth('app-node-2', false);

    await app.resetDemo();

    assertSeededWorld();
    assert.notEqual(byHandle('alice').id, oldAlice.id, 'the data was rebuilt, not kept');
    assert.throws(() => app.users.require(oldAlice.id));
    assert.equal(app.chaos.state.bank.down, false);
    assert.equal(app.chaos.state.replicaLagMs, 0);
    assert.ok(app.system.snapshot().loadBalancer.nodes.every((node) => node.healthy));

    const attempt = app.system.attemptLedgerTamper();
    assert.equal(attempt.update.blocked && attempt.delete.blocked && attempt.replace.blocked, true);
    assert.match(attempt.update.databaseSaid, /append-only/);

    // The replica was rebuilt too and follows the new data.
    await app.settle();
    const replica = app.readRouter.route();
    assert.deepEqual(app.ledger.recent(replica, 100), app.ledger.recent(primaryOf(app), 100));

    // And the rebuilt world is usable.
    const { result } = await pay(app, byHandle('alice'), byHandle('bob'), 100);
    assert.equal(result.transaction.status, 'SUCCESS');
  });
});
