import { LedgerEntryType, NotificationChannelType, NotificationStatus, ScheduledPaymentStatus } from '../../domain/enums';
import { LedgerEntry } from '../../domain/LedgerEntry';
import { Money } from '../../domain/Money';
import type { Notification } from '../../domain/Notification';
import { ScheduledPayment } from '../../domain/ScheduledPayment';
import type { SqlReader, SqlWriter } from '../../infrastructure/db/Database';
import type {
  IdempotencyRecord,
  IdempotencyRepository,
  LedgerRepository,
  NotificationRepository,
  ScheduledPaymentRepository,
} from '../interfaces';

interface LedgerRow {
  seq: number;
  id: string;
  transaction_id: string;
  account_id: string;
  entry_type: string;
  amount_paise: number;
  balance_after_paise: number | null;
  description: string;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export class SqliteLedgerRepository implements LedgerRepository {
  constructor(private readonly db: SqlWriter) {}

  append(entry: LedgerEntry): void {
    this.db.run(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount_paise, balance_after_paise,
                                   description, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.transactionId,
      entry.accountId,
      entry.entryType,
      entry.amount.paise,
      entry.balanceAfter ? entry.balanceAfter.paise : null,
      entry.description,
      entry.prevHash,
      entry.hash,
      entry.createdAt.toISOString(),
    );
  }

  lastHash(): string {
    const row = this.db.get<{ hash: string }>('SELECT hash FROM ledger_entries ORDER BY seq DESC LIMIT 1');
    return row?.hash ?? LedgerEntry.GENESIS_HASH;
  }

  findByTransaction(reader: SqlReader, transactionId: string): LedgerEntry[] {
    return reader
      .all<LedgerRow>('SELECT * FROM ledger_entries WHERE transaction_id = ? ORDER BY seq', transactionId)
      .map(mapLedger);
  }

  findRecent(reader: SqlReader, limit: number): LedgerEntry[] {
    return reader.all<LedgerRow>('SELECT * FROM ledger_entries ORDER BY seq DESC LIMIT ?', limit).map(mapLedger);
  }

  findAllInOrder(reader: SqlReader): LedgerEntry[] {
    return reader.all<LedgerRow>('SELECT * FROM ledger_entries ORDER BY seq').map(mapLedger);
  }
}

function mapLedger(row: LedgerRow): LedgerEntry {
  return new LedgerEntry({
    sequence: row.seq,
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    entryType: row.entry_type as LedgerEntryType,
    amount: Money.ofPaise(row.amount_paise),
    balanceAfter: row.balance_after_paise === null ? null : Money.ofPaise(row.balance_after_paise),
    description: row.description,
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: new Date(row.created_at),
  });
}

interface IdempotencyRow {
  user_id: string;
  idem_key: string;
  request_hash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_body: string | null;
  created_at: string;
}

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: SqlWriter) {}

  /**
   * The atomic claim. If two identical requests race, the PRIMARY KEY lets exactly one
   * INSERT succeed; the loser sees `changes === 0`.
   */
  tryBegin(userId: string, key: string, requestHash: string, now: Date): boolean {
    const { changes } = this.db.run(
      `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, status, created_at)
       VALUES (?, ?, ?, 'IN_PROGRESS', ?)
       ON CONFLICT (user_id, idem_key) DO NOTHING`,
      userId,
      key,
      requestHash,
      now.toISOString(),
    );
    return changes === 1;
  }

  find(userId: string, key: string): IdempotencyRecord | undefined {
    const row = this.db.get<IdempotencyRow>(
      'SELECT * FROM idempotency_keys WHERE user_id = ? AND idem_key = ?',
      userId,
      key,
    );
    if (!row) return undefined;
    return {
      userId: row.user_id,
      key: row.idem_key,
      requestHash: row.request_hash,
      status: row.status,
      responseBody: row.response_body,
      createdAt: new Date(row.created_at),
    };
  }

  complete(userId: string, key: string, responseBody: string, now: Date): void {
    this.db.run(
      `UPDATE idempotency_keys SET status = 'COMPLETED', response_body = ?, completed_at = ?
        WHERE user_id = ? AND idem_key = ?`,
      responseBody,
      now.toISOString(),
      userId,
      key,
    );
  }

  releaseAllInProgress(): number {
    return this.db.run(`DELETE FROM idempotency_keys WHERE status = 'IN_PROGRESS'`).changes;
  }

  release(userId: string, key: string): void {
    this.db.run(
      `DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND status = 'IN_PROGRESS'`,
      userId,
      key,
    );
  }
}

interface NotificationRow {
  id: string;
  user_id: string;
  transaction_id: string;
  channel: string;
  title: string;
  body: string;
  status: string;
  attempts: number;
  created_at: string;
}

export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly db: SqlWriter) {}

  /** Idempotent consumer: redelivery of the same message updates the row instead of duplicating it. */
  upsert(n: Notification): void {
    this.db.run(
      `INSERT INTO notifications (id, user_id, transaction_id, channel, title, body, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts`,
      n.id,
      n.userId,
      n.transactionId,
      n.channel,
      n.title,
      n.body,
      n.status,
      n.attempts,
      n.createdAt.toISOString(),
    );
  }

  findByUser(reader: SqlReader, userId: string, limit: number): Notification[] {
    return reader
      .all<NotificationRow>(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ?',
        userId,
        limit,
      )
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        transactionId: row.transaction_id,
        channel: row.channel as NotificationChannelType,
        title: row.title,
        body: row.body,
        status: row.status as NotificationStatus,
        attempts: row.attempts,
        createdAt: new Date(row.created_at),
      }));
  }
}

interface ScheduledRow {
  id: string;
  user_id: string;
  receiver_upi_id: string;
  source_id: string | null;
  amount_paise: number;
  note: string;
  execute_at: string;
  status: string;
  transaction_id: string | null;
  failure_reason: string | null;
  created_at: string;
}

export class SqliteScheduledPaymentRepository implements ScheduledPaymentRepository {
  constructor(private readonly db: SqlWriter) {}

  insert(payment: ScheduledPayment): void {
    const p = payment.toProps();
    this.db.run(
      `INSERT INTO scheduled_payments (id, user_id, receiver_upi_id, source_id, amount_paise, note, execute_at,
                                       status, transaction_id, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.userId,
      p.receiverUpiId,
      p.sourceId,
      p.amount.paise,
      p.note,
      p.executeAt.toISOString(),
      p.status,
      p.transactionId,
      p.failureReason,
      p.createdAt.toISOString(),
    );
  }

  transition(payment: ScheduledPayment, expected: ScheduledPaymentStatus): boolean {
    const { changes } = this.db.run(
      'UPDATE scheduled_payments SET status = ?, transaction_id = ?, failure_reason = ? WHERE id = ? AND status = ?',
      payment.status,
      payment.transactionId,
      payment.failureReason,
      payment.id,
      expected,
    );
    return changes === 1;
  }

  requeueRunning(): number {
    return this.db.run(`UPDATE scheduled_payments SET status = 'PENDING' WHERE status = 'RUNNING'`).changes;
  }

  findById(id: string): ScheduledPayment | undefined {
    const row = this.db.get<ScheduledRow>('SELECT * FROM scheduled_payments WHERE id = ?', id);
    return row ? mapScheduled(row) : undefined;
  }

  findDue(now: Date, limit: number): ScheduledPayment[] {
    return this.db
      .all<ScheduledRow>(
        `SELECT * FROM scheduled_payments WHERE status = 'PENDING' AND execute_at <= ? ORDER BY execute_at LIMIT ?`,
        now.toISOString(),
        limit,
      )
      .map(mapScheduled);
  }

  findByUser(userId: string): ScheduledPayment[] {
    return this.db
      .all<ScheduledRow>('SELECT * FROM scheduled_payments WHERE user_id = ? ORDER BY execute_at DESC LIMIT 20', userId)
      .map(mapScheduled);
  }
}

function mapScheduled(row: ScheduledRow): ScheduledPayment {
  return new ScheduledPayment({
    id: row.id,
    userId: row.user_id,
    receiverUpiId: row.receiver_upi_id,
    sourceId: row.source_id,
    amount: Money.ofPaise(row.amount_paise),
    note: row.note,
    executeAt: new Date(row.execute_at),
    status: row.status as ScheduledPaymentStatus,
    transactionId: row.transaction_id,
    failureReason: row.failure_reason,
    createdAt: new Date(row.created_at),
  });
}
