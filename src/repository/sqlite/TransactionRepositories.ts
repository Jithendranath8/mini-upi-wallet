import { PaymentSourceType, TransactionStatus, TransactionType } from '../../domain/enums';
import { OptimisticLockError } from '../../domain/errors';
import { Money } from '../../domain/Money';
import { Transaction } from '../../domain/Transaction';
import type { SqlReader, SqlWriter, UnitOfWork } from '../../infrastructure/db/Database';
import type { TransactionView } from '../../readmodel/views';
import type {
  OutboxEvent,
  TransactionEventRecord,
  TransactionEventRepository,
  TransactionQueryRepository,
  TransactionRepository,
} from '../interfaces';
import { mapPaymentSource } from './AccountRepositories';

interface TransactionRow {
  id: string;
  idempotency_key: string;
  type: string;
  sender_id: string;
  receiver_id: string;
  source_id: string;
  source_type: string;
  amount_paise: number;
  note: string;
  status: string;
  failure_code: string | null;
  failure_reason: string | null;
  funds_captured: number;
  gateway_ref: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Stores transactions together with their audit trail: the row and the transaction_events
 * rows for every new state transition are written in ONE unit of work. A status can
 * therefore never exist without the event that explains it.
 */
export class SqliteTransactionRepository implements TransactionRepository {
  constructor(
    private readonly db: SqlWriter & UnitOfWork,
    private readonly events: TransactionEventRepository,
  ) {}

  insert(txn: Transaction): void {
    this.db.runInTransaction(() => {
      this.insertRow(txn);
      this.recordTransitions(txn);
    });
    txn.markInserted();
  }

  /**
   * Optimistic locking: the UPDATE only matches the version this object was loaded with.
   * Zero rows changed means another request changed the transaction first.
   */
  update(txn: Transaction): void {
    this.db.runInTransaction(() => {
      this.updateRow(txn);
      this.recordTransitions(txn);
    });
    txn.markPersisted();
  }

  private recordTransitions(txn: Transaction): void {
    for (const transition of txn.unrecordedTransitions()) {
      this.events.append({ transactionId: txn.id, ...transition });
    }
  }

  private insertRow(txn: Transaction): void {
    const p = txn.toProps();
    this.db.run(
      `INSERT INTO transactions (id, idempotency_key, type, sender_id, receiver_id, source_id, source_type,
                                 amount_paise, note, status, failure_code, failure_reason, funds_captured,
                                 gateway_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.idempotencyKey,
      p.type,
      p.senderId,
      p.receiverId,
      p.sourceId,
      p.sourceType,
      p.amount.paise,
      p.note,
      p.status,
      p.failureCode,
      p.failureReason,
      p.fundsCaptured ? 1 : 0,
      p.gatewayReference,
      p.createdAt.toISOString(),
      p.updatedAt.toISOString(),
    );
  }

  private updateRow(txn: Transaction): void {
    const p = txn.toProps();
    const { changes } = this.db.run(
      `UPDATE transactions
          SET status = ?, failure_code = ?, failure_reason = ?, funds_captured = ?, gateway_ref = ?,
              updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?`,
      p.status,
      p.failureCode,
      p.failureReason,
      p.fundsCaptured ? 1 : 0,
      p.gatewayReference,
      p.updatedAt.toISOString(),
      p.id,
      txn.version,
    );
    if (changes !== 1) throw new OptimisticLockError('Transaction', p.id);
  }

  findUnfinished(): Transaction[] {
    return this.db
      .all<TransactionRow>(`SELECT * FROM transactions WHERE status IN ('INITIATED', 'PROCESSING') ORDER BY created_at`)
      .map((row) => this.map(row)!);
  }

  /** Charges that were captured at a bank or card network, for rebuilding gateway state at start-up. */
  findCaptured(): Transaction[] {
    return this.db
      .all<TransactionRow>('SELECT * FROM transactions WHERE gateway_ref IS NOT NULL ORDER BY created_at')
      .map((row) => this.map(row)!);
  }

  findById(id: string): Transaction | undefined {
    return this.map(this.db.get<TransactionRow>('SELECT * FROM transactions WHERE id = ?', id));
  }

  findBySenderAndKey(senderId: string, idempotencyKey: string): Transaction | undefined {
    return this.map(
      this.db.get<TransactionRow>(
        'SELECT * FROM transactions WHERE sender_id = ? AND idempotency_key = ?',
        senderId,
        idempotencyKey,
      ),
    );
  }

  countByStatus(): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(Object.values(TransactionStatus).map((s) => [s, 0]));
    for (const row of this.db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM transactions GROUP BY status',
    )) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  // ---- TransferHistoryReader ---------------------------------------------------------

  sumOutgoingSince(senderId: string, since: Date, excludeTransactionId: string): Money {
    const row = this.db.get<{ total: number }>(
      `SELECT COALESCE(SUM(amount_paise), 0) AS total
         FROM transactions
        WHERE sender_id = ? AND created_at >= ? AND id <> ?
          AND type = 'P2P' AND status IN ('SUCCESS', 'PROCESSING')`,
      senderId,
      since.toISOString(),
      excludeTransactionId,
    );
    return Money.ofPaise(row?.total ?? 0);
  }

  countInitiatedSince(senderId: string, since: Date, excludeTransactionId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ? AND created_at >= ? AND id <> ?',
      senderId,
      since.toISOString(),
      excludeTransactionId,
    );
    return row?.n ?? 0;
  }

  hasSuccessfulTransfer(senderId: string, receiverId: string): boolean {
    const row = this.db.get<{ found: number }>(
      `SELECT 1 AS found FROM transactions
        WHERE sender_id = ? AND receiver_id = ? AND status = 'SUCCESS' LIMIT 1`,
      senderId,
      receiverId,
    );
    return row !== undefined;
  }

  private map(row: TransactionRow | undefined): Transaction | undefined {
    if (!row) return undefined;
    return Transaction.rehydrate({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      type: row.type as TransactionType,
      senderId: row.sender_id,
      receiverId: row.receiver_id,
      sourceId: row.source_id,
      sourceType: row.source_type as PaymentSourceType,
      amount: Money.ofPaise(row.amount_paise),
      note: row.note,
      status: row.status as TransactionStatus,
      failureCode: row.failure_code,
      failureReason: row.failure_reason,
      fundsCaptured: row.funds_captured === 1,
      gatewayReference: row.gateway_ref,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      version: row.version,
    });
  }
}

interface TransactionViewRow extends TransactionRow {
  sender_name: string;
  sender_upi: string;
  receiver_name: string;
  receiver_upi: string;
  ps_user_id: string;
  ps_type: string;
  ps_details: string;
  ps_created_at: string;
}

const VIEW_SELECT = `
  SELECT t.*,
         s.name AS sender_name,   s.upi_id AS sender_upi,
         r.name AS receiver_name, r.upi_id AS receiver_upi,
         ps.user_id AS ps_user_id, ps.type AS ps_type, ps.details AS ps_details, ps.created_at AS ps_created_at
    FROM transactions t
    JOIN users s            ON s.id  = t.sender_id
    JOIN users r            ON r.id  = t.receiver_id
    JOIN payment_sources ps ON ps.id = t.source_id`;

/** Read side: one joined query per screen instead of loading aggregates one by one. */
export class SqliteTransactionQueryRepository implements TransactionQueryRepository {
  findHistory(
    reader: SqlReader,
    userId: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ): TransactionView[] {
    // Keyset pagination: "rows older than the last one I showed you". Unlike OFFSET it stays
    // fast on page 1,000 and never skips or repeats rows when new payments arrive.
    const rows = before
      ? reader.all<TransactionViewRow>(
          `${VIEW_SELECT}
            WHERE (t.sender_id = ? OR t.receiver_id = ?) AND (t.created_at, t.id) < (?, ?)
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ?`,
          userId,
          userId,
          before.createdAt,
          before.id,
          limit,
        )
      : reader.all<TransactionViewRow>(
          `${VIEW_SELECT}
            WHERE t.sender_id = ? OR t.receiver_id = ?
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ?`,
          userId,
          userId,
          limit,
        );
    return rows.map(toView);
  }

  findView(reader: SqlReader, transactionId: string): TransactionView | undefined {
    const row = reader.get<TransactionViewRow>(`${VIEW_SELECT} WHERE t.id = ?`, transactionId);
    return row ? toView(row) : undefined;
  }
}

function toView(row: TransactionViewRow): TransactionView {
  const source = mapPaymentSource({
    id: row.source_id,
    user_id: row.ps_user_id,
    type: row.ps_type,
    details: row.ps_details,
    created_at: row.ps_created_at,
  });
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    amount: row.amount_paise / 100,
    amountPaise: row.amount_paise,
    sender: { id: row.sender_id, name: row.sender_name, upiId: row.sender_upi },
    receiver: { id: row.receiver_id, name: row.receiver_name, upiId: row.receiver_upi },
    source: { id: source.id, type: source.type, label: source.describe() },
    note: row.note,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface EventRow {
  id: number;
  transaction_id: string;
  from_status: string | null;
  to_status: string;
  detail: string;
  created_at: string;
}

export class SqliteTransactionEventRepository implements TransactionEventRepository {
  constructor(private readonly db: SqlWriter) {}

  append(event: TransactionEventRecord): void {
    this.db.run(
      'INSERT INTO transaction_events (transaction_id, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      event.transactionId,
      event.from,
      event.to,
      event.detail,
      event.at.toISOString(),
    );
  }

  findByTransaction(reader: SqlReader, transactionId: string): TransactionEventRecord[] {
    return reader
      .all<EventRow>('SELECT * FROM transaction_events WHERE transaction_id = ? ORDER BY id', transactionId)
      .map(toEvent);
  }

  findUnpublished(transactionId: string): OutboxEvent[] {
    return this.db
      .all<EventRow>(
        'SELECT * FROM transaction_events WHERE transaction_id = ? AND published_at IS NULL ORDER BY id',
        transactionId,
      )
      .map(toEvent);
  }

  markPublished(eventIds: number[], at: Date): void {
    for (const id of eventIds) {
      this.db.run('UPDATE transaction_events SET published_at = ? WHERE id = ?', at.toISOString(), id);
    }
  }

  findTransactionsWithUnpublished(): string[] {
    return this.db
      .all<{ transaction_id: string }>(
        `SELECT transaction_id FROM transaction_events
          WHERE published_at IS NULL GROUP BY transaction_id ORDER BY MIN(id)`,
      )
      .map((row) => row.transaction_id);
  }
}

function toEvent(row: EventRow): OutboxEvent {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    from: row.from_status as TransactionStatus | null,
    to: row.to_status as TransactionStatus,
    detail: row.detail,
    at: new Date(row.created_at),
  };
}
