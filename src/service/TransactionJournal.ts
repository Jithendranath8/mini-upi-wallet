import { NotFoundError } from '../domain/errors';
import type { PaymentSource } from '../domain/PaymentSource';
import type { Transaction } from '../domain/Transaction';
import type { User } from '../domain/User';
import type { OutboxRelay, TransactionParties } from '../events/Outbox';
import type { ReadRouter } from '../infrastructure/db/Replication';
import type { PaymentStrategy, PaymentStrategyFactory } from '../payment/PaymentStrategy';
import type { PaymentSourceRepository, TransactionRepository } from '../repository/interfaces';
import type { UserService } from './UserService';

/**
 * Works out who and what a payment involves. One responsibility, used by transfers, refunds,
 * the outbox and start-up recovery, so that lookup rules live in exactly one place.
 */
export class PartyResolver {
  constructor(
    private readonly users: UserService,
    private readonly sources: PaymentSourceRepository,
    private readonly strategies: PaymentStrategyFactory,
  ) {}

  /** For a new payment. Throws (nothing recorded yet) if anyone or anything is missing. */
  forNewPayment(senderId: string, receiverUpiId: string, sourceId: string | undefined): TransactionParties {
    const sender = this.users.require(senderId);
    const receiver = this.users.findByUpiId(receiverUpiId);
    if (!receiver) {
      throw new NotFoundError('RECEIVER_NOT_FOUND', `${receiverUpiId} is not a registered UPI ID.`);
    }
    return { sender, receiver, source: this.sourceOf(sender, sourceId) };
  }

  /** For a payment that already exists. */
  of(transaction: Transaction): TransactionParties {
    const source = this.sources.findById(transaction.sourceId);
    if (!source) throw new NotFoundError('SOURCE_NOT_FOUND', 'The original payment source no longer exists.');
    return {
      sender: this.users.require(transaction.senderId),
      receiver: this.users.require(transaction.receiverId),
      source,
    };
  }

  strategyFor(source: PaymentSource): PaymentStrategy {
    return this.strategies.for(source.type);
  }

  private sourceOf(sender: User, sourceId: string | undefined): PaymentSource {
    const source = sourceId ? this.sources.findById(sourceId) : this.sources.findWalletSource(sender.id);
    // A source that belongs to someone else is reported as "not found": never confirm it exists.
    if (!source || source.userId !== sender.id) {
      throw new NotFoundError('SOURCE_NOT_FOUND', 'That payment source is not linked to your account.');
    }
    return source;
  }
}

/**
 * Stores transactions and announces what happened to them.
 *
 * Saving writes the row and its state-change events atomically (the repository does that);
 * announcing relays those events from the outbox to the observers. Services call this instead
 * of handling repositories, publishers and read routing separately.
 */
export class TransactionJournal {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly outbox: OutboxRelay,
    private readonly readRouter: ReadRouter,
  ) {}

  /** Records a brand-new transaction. From now on the payer reads their history from the primary. */
  open(transaction: Transaction, parties: TransactionParties): void {
    this.transactions.insert(transaction);
    this.announce(transaction, parties);
  }

  /** Stores a state change made outside a payment strategy, and announces it. */
  save(transaction: Transaction, parties: TransactionParties): void {
    this.transactions.update(transaction);
    this.announce(transaction, parties);
  }

  /** Announces changes that a payment strategy has already committed. */
  announce(transaction: Transaction, parties: TransactionParties): void {
    this.outbox.relay(transaction, parties);
    this.readRouter.recordWrite(parties.sender.id);
  }

  /** Read-your-writes for someone other than the payer (e.g. the receiver who just refunded). */
  pinReads(userId: string): void {
    this.readRouter.recordWrite(userId);
  }

  find(transactionId: string): Transaction | undefined {
    return this.transactions.findById(transactionId);
  }

  require(transactionId: string): Transaction {
    const transaction = this.transactions.findById(transactionId);
    if (!transaction) throw new NotFoundError('TRANSACTION_NOT_FOUND', `No transaction ${transactionId}.`);
    return transaction;
  }

  findByKey(senderId: string, idempotencyKey: string): Transaction | undefined {
    return this.transactions.findBySenderAndKey(senderId, idempotencyKey);
  }
}
