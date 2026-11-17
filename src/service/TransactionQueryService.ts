import { NotFoundError, ValidationError } from '../domain/errors';
import type { ReadRouter } from '../infrastructure/db/Replication';
import { redactFor, redactLedgerFor, type LedgerEntryView, type TransactionView } from '../readmodel/views';
import type {
  PaymentSourceRepository,
  TransactionEventRepository,
  TransactionQueryRepository,
} from '../repository/interfaces';
import type { LedgerService } from './LedgerService';

export interface Served<T> {
  data: T;
  /** Which database node answered: shown to the client in the X-Data-Source header. */
  servedBy: 'primary' | 'replica';
  /** For lists: opaque cursor of the next (older) page, or null when there is none. */
  nextCursor?: string | null;
}

export interface TransactionDetails {
  transaction: TransactionView;
  timeline: Array<{ from: string | null; to: string; detail: string; at: string }>;
  ledger: LedgerEntryView[];
}

/**
 * Read side of the application. Queries go to the read replica unless the caller needs
 * (or has earned, by just writing) an up-to-date answer from the primary.
 */
export class TransactionQueryService {
  constructor(
    private readonly queries: TransactionQueryRepository,
    private readonly events: TransactionEventRepository,
    private readonly ledger: LedgerService,
    private readonly readRouter: ReadRouter,
    private readonly sources: PaymentSourceRepository,
  ) {}

  /**
   * Newest first, one page at a time. `cursor` is the opaque `nextCursor` of the previous page.
   * One row more than asked for is fetched to learn whether another page exists.
   */
  history(userId: string, limit: number, strong = false, cursor?: string): Served<TransactionView[]> {
    const reader = this.readRouter.route(userId, { strong });
    const rows = this.queries.findHistory(reader, userId, limit + 1, cursor ? decodeCursor(cursor) : undefined);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((view) => redactFor(view, userId)),
      servedBy: reader.role,
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  details(transactionId: string, requesterId: string, strong = false): Served<TransactionDetails> {
    let reader = this.readRouter.route(requesterId, { strong });
    let transaction = this.queries.findView(reader, transactionId);
    if (!transaction && reader.role === 'replica') {
      // The replica may simply not have it yet. Ask the primary before saying "not found".
      reader = this.readRouter.route(requesterId, { strong: true });
      transaction = this.queries.findView(reader, transactionId);
    }
    const isParty = transaction && [transaction.sender.id, transaction.receiver.id].includes(requesterId);
    if (!transaction || !isParty) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', `No transaction ${transactionId} on your account.`);
    }
    // The requester sees their own accounts in full and the other party's side redacted.
    const ownAccounts = new Set(this.sources.findByUserId(requesterId).map((source) => source.ledgerAccountId()));
    return {
      data: {
        transaction: redactFor(transaction, requesterId),
        timeline: this.events.findByTransaction(reader, transactionId).map((event) => ({
          from: event.from,
          to: event.to,
          detail: event.detail,
          at: event.at.toISOString(),
        })),
        ledger: redactLedgerFor(this.ledger.forTransaction(reader, transactionId), ownAccounts),
      },
      servedBy: reader.role,
    };
  }
}

/** The cursor is opaque to clients: they pass back exactly what they were given. */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw new ValidationError('INVALID_CURSOR', 'The "before" cursor is not valid.');
  }
  return { createdAt, id };
}
