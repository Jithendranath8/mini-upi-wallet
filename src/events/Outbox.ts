import type { PaymentSource } from '../domain/PaymentSource';
import type { Transaction } from '../domain/Transaction';
import type { User } from '../domain/User';
import type { TransactionEventRepository } from '../repository/interfaces';
import type { TransactionEventPublisher } from './TransactionEvents';

/** The people and the payment source a transaction involves. */
export interface TransactionParties {
  sender: User;
  receiver: User;
  source: PaymentSource;
}

/**
 * PATTERN: Transactional outbox.
 *
 * The problem: "commit the payment" and "tell the observers" are two steps. If the process
 * dies between them, the payment exists but nobody was ever notified.
 *
 * The fix: the event is written to `transaction_events` in the SAME database transaction as
 * the status change (the repository does that). This relay then reads the events that have
 * not been published yet, hands them to the observers and only afterwards marks them
 * published. A crash before the mark means the event is published again at the next start:
 * delivery is at-least-once. The observers that act on the outside world tolerate a repeat
 * (notification ids are deterministic; releasing captured funds twice is a no-op); the
 * metrics and trace observers would simply count or show the event once more.
 */
export class OutboxRelay {
  #relayed = 0;

  constructor(
    private readonly events: TransactionEventRepository,
    private readonly publisher: TransactionEventPublisher,
    /** Rebuilds a transaction and its parties from storage (used when relaying after a restart). */
    private readonly load: (transactionId: string) => { transaction: Transaction; parties: TransactionParties } | undefined,
  ) {}

  /** Publishes this transaction's pending events, oldest first. Returns how many. */
  relay(transaction: Transaction, parties: TransactionParties): number {
    const pending = this.events.findUnpublished(transaction.id);
    if (pending.length === 0) return 0;
    for (const event of pending) {
      this.publisher.publish({
        transaction,
        transition: { from: event.from, to: event.to, detail: event.detail, at: event.at },
        ...parties,
      });
    }
    this.events.markPublished(
      pending.map((event) => event.id),
      new Date(),
    );
    this.#relayed += pending.length;
    return pending.length;
  }

  /** Start-up: publish whatever a previous run committed but never announced. */
  relayAll(): number {
    let relayed = 0;
    for (const transactionId of this.events.findTransactionsWithUnpublished()) {
      const context = this.load(transactionId);
      if (context) relayed += this.relay(context.transaction, context.parties);
    }
    return relayed;
  }

  stats(): { relayed: number } {
    return { relayed: this.#relayed };
  }
}
