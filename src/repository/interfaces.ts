import type { LedgerEntry } from '../domain/LedgerEntry';
import type { Money } from '../domain/Money';
import type { Notification } from '../domain/Notification';
import type { PaymentSource, WalletSource } from '../domain/PaymentSource';
import type { ScheduledPaymentStatus } from '../domain/enums';
import type { ScheduledPayment } from '../domain/ScheduledPayment';
import type { StateTransition, Transaction } from '../domain/Transaction';
import type { User } from '../domain/User';
import type { Wallet } from '../domain/Wallet';
import type { SqlReader } from '../infrastructure/db/Database';
import type { TransactionView } from '../readmodel/views';

/**
 * Repository ports. Services depend on these interfaces, never on SQLite
 * (Dependency Inversion). Each interface is small and shaped around what its
 * clients need (Interface Segregation).
 *
 * Read-side methods take a SqlReader so the caller (via ReadRouter) decides whether the
 * query runs on the primary or on the replica.
 */

export interface UserRepository {
  insert(user: User): void;
  findById(id: string): User | undefined;
  findByUpiId(upiId: string): User | undefined;
  findByPhone(phone: string): User | undefined;
  findAll(): User[];
}

export interface WalletRepository {
  insert(wallet: Wallet): void;
  /** For display. May be served from a cache. */
  findByUserId(userId: string): Wallet | undefined;
  /** Always reads the primary. Use inside a unit of work before changing a balance. */
  findByUserIdForUpdate(userId: string): Wallet | undefined;
  /** Versioned write: throws OptimisticLockError if the row changed since it was read. */
  save(wallet: Wallet): void;
  findAll(): Wallet[];
}

export interface PaymentSourceRepository {
  insert(source: PaymentSource): void;
  findById(id: string): PaymentSource | undefined;
  findByUserId(userId: string): PaymentSource[];
  findWalletSource(userId: string): WalletSource | undefined;
}

/**
 * The narrow slice of transaction history that validation and fraud rules need.
 * They get this instead of the whole TransactionRepository.
 */
export interface TransferHistoryReader {
  /** Total sent to other people since `since` (successful or still in flight). */
  sumOutgoingSince(senderId: string, since: Date, excludeTransactionId: string): Money;
  /** Number of payment attempts started since `since`, whatever their outcome. */
  countInitiatedSince(senderId: string, since: Date, excludeTransactionId: string): number;
  hasSuccessfulTransfer(senderId: string, receiverId: string): boolean;
}

export interface TransactionRepository extends TransferHistoryReader {
  /** Stores the transaction and its new state transitions atomically. */
  insert(txn: Transaction): void;
  /** Versioned write (throws OptimisticLockError if stale), with its new state transitions. */
  update(txn: Transaction): void;
  findById(id: string): Transaction | undefined;
  findBySenderAndKey(senderId: string, idempotencyKey: string): Transaction | undefined;
  /** Payments that never reached a final state (INITIATED or PROCESSING). */
  findUnfinished(): Transaction[];
  /** Transactions whose money was captured at an external gateway. */
  findCaptured(): Transaction[];
  countByStatus(): Record<string, number>;
}

/** Read model: denormalised transaction views for lists and detail screens. */
export interface TransactionQueryRepository {
  /** Newest first. `before` is the (createdAt, id) of the last row of the previous page. */
  findHistory(
    reader: SqlReader,
    userId: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ): TransactionView[];
  findView(reader: SqlReader, transactionId: string): TransactionView | undefined;
}

export interface TransactionEventRecord extends StateTransition {
  transactionId: string;
}

/** A stored event that observers have not been told about yet. */
export interface OutboxEvent extends TransactionEventRecord {
  id: number;
}

export interface TransactionEventRepository {
  append(event: TransactionEventRecord): void;
  findByTransaction(reader: SqlReader, transactionId: string): TransactionEventRecord[];
  // ---- outbox ----
  findUnpublished(transactionId: string): OutboxEvent[];
  markPublished(eventIds: number[], at: Date): void;
  /** Transactions that still have events waiting, oldest first (used at start-up). */
  findTransactionsWithUnpublished(): string[];
}

export interface LedgerRepository {
  /** Append only. There is deliberately no update or delete. */
  append(entry: LedgerEntry): void;
  lastHash(): string;
  findByTransaction(reader: SqlReader, transactionId: string): LedgerEntry[];
  findRecent(reader: SqlReader, limit: number): LedgerEntry[];
  findAllInOrder(reader: SqlReader): LedgerEntry[];
}

export interface IdempotencyRecord {
  userId: string;
  key: string;
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  responseBody: string | null;
  createdAt: Date;
}

export interface IdempotencyRepository {
  /** Atomically claims the key. Returns false if someone else already holds it. */
  tryBegin(userId: string, key: string, requestHash: string, now: Date): boolean;
  find(userId: string, key: string): IdempotencyRecord | undefined;
  complete(userId: string, key: string, responseBody: string, now: Date): void;
  release(userId: string, key: string): void;
  /** Start-up only: every key still IN_PROGRESS belongs to a request that died. Returns how many. */
  releaseAllInProgress(): number;
}

export interface NotificationRepository {
  /** Insert, or update status/attempts if this notification id already exists. */
  upsert(notification: Notification): void;
  findByUser(reader: SqlReader, userId: string, limit: number): Notification[];
}

export interface ScheduledPaymentRepository {
  insert(payment: ScheduledPayment): void;
  /**
   * Compare-and-set: writes the payment's new state only if the stored status is still
   * `expected`. Returns false if someone else changed it first.
   */
  transition(payment: ScheduledPayment, expected: ScheduledPaymentStatus): boolean;
  /** Start-up only: payments claimed by a scheduler that died go back to PENDING. Returns how many. */
  requeueRunning(): number;
  findById(id: string): ScheduledPayment | undefined;
  findDue(now: Date, limit: number): ScheduledPayment[];
  findByUser(userId: string): ScheduledPayment[];
}
