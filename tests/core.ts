import { Money } from '../src/domain/Money';
import { TransactionStatus } from '../src/domain/enums';
import type { PaymentSource } from '../src/domain/PaymentSource';
import { Transaction } from '../src/domain/Transaction';
import type { User } from '../src/domain/User';
import { OutboxRelay } from '../src/events/Outbox';
import { type TransactionEvent, TransactionEventPublisher } from '../src/events/TransactionEvents';
import { InMemoryCache } from '../src/infrastructure/cache/Cache';
import { PrimaryDatabase, ReplicaDatabase } from '../src/infrastructure/db/Database';
import { ReadRouter } from '../src/infrastructure/db/Replication';
import { InMemoryMessageQueue } from '../src/infrastructure/queue/MessageQueue';
import { PaymentStrategyFactory } from '../src/payment/PaymentStrategy';
import { WalletPaymentStrategy } from '../src/payment/strategies';
import {
  SqlitePaymentSourceRepository,
  SqliteUserRepository,
  SqliteWalletRepository,
} from '../src/repository/sqlite/AccountRepositories';
import {
  SqliteIdempotencyRepository,
  SqliteLedgerRepository,
  SqliteScheduledPaymentRepository,
} from '../src/repository/sqlite/SupportRepositories';
import {
  SqliteTransactionEventRepository,
  SqliteTransactionRepository,
} from '../src/repository/sqlite/TransactionRepositories';
import { LedgerService } from '../src/service/LedgerService';
import { CompensationObserver } from '../src/service/RefundService';
import { PartyResolver, TransactionJournal } from '../src/service/TransactionJournal';
import { UserService } from '../src/service/UserService';

/**
 * A hand-wired slice of the application for unit tests of the pieces the composition root
 * keeps to itself (outbox, journal, party resolver, reconciliation): real SQLite repositories
 * on an in-memory database, a real event publisher with a recording observer, no HTTP, no
 * gateways. Not a test file itself.
 */
export function buildCore() {
  const primary = new PrimaryDatabase(':memory:');
  const replica = new ReplicaDatabase(':memory:');
  const cache = new InMemoryCache(30_000, 1_000);

  const userRepository = new SqliteUserRepository(primary);
  const wallets = new SqliteWalletRepository(primary);
  const sources = new SqlitePaymentSourceRepository(primary);
  const events = new SqliteTransactionEventRepository(primary);
  const transactions = new SqliteTransactionRepository(primary, events);
  const idempotencyKeys = new SqliteIdempotencyRepository(primary);
  const scheduled = new SqliteScheduledPaymentRepository(primary);

  const users = new UserService(userRepository, wallets, sources, primary, cache, {
    upiHandle: 'miniupi',
    defaultDailyLimitRupees: 50_000,
    pinMaxAttempts: 5,
    pinLockMs: 60_000,
  });
  const ledger = new LedgerService(new SqliteLedgerRepository(primary), wallets);
  const strategies = new PaymentStrategyFactory().register(
    new WalletPaymentStrategy({ unitOfWork: primary, wallets, transactions, ledger }),
  );

  /** Everything the observers were told, in order. */
  const published: TransactionEvent[] = [];
  const queue = new InMemoryMessageQueue({ concurrency: 1, maxAttempts: 1, backoffBaseMs: 1 });
  const publisher = new TransactionEventPublisher();
  publisher.subscribe({ name: 'Recorder', onTransactionEvent: (event) => void published.push(event) });
  publisher.subscribe(new CompensationObserver(queue)); // the real one: queues refunds of captured charges

  const parties = new PartyResolver(users, sources, strategies);
  const loadForRelay = (transactionId: string) => {
    const transaction = transactions.findById(transactionId);
    return transaction ? { transaction, parties: parties.of(transaction) } : undefined;
  };
  const outbox = new OutboxRelay(events, publisher, loadForRelay);
  const readRouter = new ReadRouter(primary, replica);
  const journal = new TransactionJournal(transactions, outbox, readRouter);

  let userSequence = 0;
  const newUser = (): User => {
    userSequence += 1;
    return users.register({
      name: `Core User ${userSequence}`,
      upiHandle: `core${userSequence}`,
      phone: `7${String(userSequence).padStart(9, '0')}`,
      pin: '1234',
    });
  };

  const linkBank = (user: User): PaymentSource =>
    users.linkBankAccount(user.id, { bankName: 'Test Bank', accountNumber: '123456789012', ifsc: 'TEST0001234' });

  let transactionSequence = 0;
  /** A brand-new INITIATED transaction object (not stored yet), funded by the sender's wallet unless a source is given. */
  const newTransaction = (sender: User, receiver: User, rupees = 100, source?: PaymentSource): Transaction => {
    transactionSequence += 1;
    const funding = source ?? sources.findWalletSource(sender.id)!;
    return Transaction.builder()
      .withId(`txn_core_${String(transactionSequence).padStart(4, '0')}`)
      .withIdempotencyKey(`core-key-${transactionSequence}`)
      .from(sender.id)
      .to(receiver.id)
      .fundedBy(funding.id, funding.type)
      .forAmount(Money.fromRupees(rupees))
      .build();
  };

  /**
   * Stores a payment exactly as a process that died mid-way would have left it: the row and
   * its events are committed, nothing was announced. Returns the stored transaction.
   */
  const leaveUnfinished = (
    sender: User,
    receiver: User,
    options: { status?: TransactionStatus.INITIATED | TransactionStatus.PROCESSING; source?: PaymentSource; rupees?: number; captured?: string } = {},
  ): Transaction => {
    const txn = newTransaction(sender, receiver, options.rupees ?? 100, options.source);
    transactions.insert(txn);
    if ((options.status ?? TransactionStatus.PROCESSING) === TransactionStatus.PROCESSING) {
      txn.startProcessing();
      transactions.update(txn);
    }
    if (options.captured) {
      txn.markFundsCaptured(options.captured);
      transactions.update(txn);
    }
    outbox.relay(txn, parties.of(txn)); // those early events were announced before the crash
    published.length = 0;
    return transactions.findById(txn.id)!;
  };

  const close = () => {
    primary.close();
    replica.close();
  };

  return {
    primary,
    replica,
    users,
    wallets,
    sources,
    events,
    transactions,
    idempotencyKeys,
    scheduled,
    strategies,
    publisher,
    published,
    queue,
    parties,
    outbox,
    loadForRelay,
    readRouter,
    journal,
    newUser,
    linkBank,
    newTransaction,
    leaveUnfinished,
    close,
  };
}

export type Core = ReturnType<typeof buildCore>;

