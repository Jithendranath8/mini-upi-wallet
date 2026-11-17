import { TransactionStatus } from '../domain/enums';
import { ForbiddenError, IllegalStateTransitionError, NotFoundError } from '../domain/errors';
import type { Transaction } from '../domain/Transaction';
import type { User } from '../domain/User';
import type { TransactionEvent, TransactionObserver } from '../events/TransactionEvents';
import type { LockManager } from '../infrastructure/lock/LockManager';
import { tracer } from '../infrastructure/observability/Tracer';
import type { MessageQueue } from '../infrastructure/queue/MessageQueue';
import { redactFor, toPartyView, toTransactionView, type TransactionView } from '../readmodel/views';
import type { PartyResolver, TransactionJournal } from './TransactionJournal';

export const COMPENSATIONS_TOPIC = 'compensations';

/**
 * Returns the money of a payment.
 *
 *   SUCCESS -> REFUNDED   requested by the RECEIVER, who gives the money back. The payer cannot
 *                         pull money out of someone else's wallet.
 *   FAILED  -> REFUNDED   only when the payer's bank or card was charged but the receiver was
 *                         never credited: releases the captured charge. Runs automatically
 *                         (see CompensationObserver); the payer may also trigger it.
 *
 * A refund is idempotent without a key: the state machine allows the transition once, and the
 * state check commits in the same database transaction as the money movement.
 */
export class RefundService {
  constructor(
    private readonly parties: PartyResolver,
    private readonly journal: TransactionJournal,
    private readonly locks: LockManager,
  ) {}

  async refund(transactionId: string, requester: User): Promise<TransactionView> {
    const found = this.journal.find(transactionId);
    // Only the two parties may act on a transaction. To anyone else it does not exist.
    if (!found || (requester.id !== found.senderId && requester.id !== found.receiverId)) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', `No transaction ${transactionId} on your account.`);
    }
    const refunded = await this.reverse(transactionId, requester);
    this.journal.pinReads(requester.id); // the requester must see the refund in their own history at once
    return redactFor(refunded, requester.id);
  }

  /**
   * Who may refund depends on the state, and the state can change while we wait for the locks
   * (the payment may still be in flight). So this runs on the transaction as re-read UNDER the
   * locks, never on an earlier snapshot.
   */
  private assertMayRefund(current: Transaction, requester: User): void {
    const givingMoneyBack = current.status === TransactionStatus.SUCCESS;
    if (givingMoneyBack && requester.id !== current.receiverId) {
      throw new ForbiddenError('REFUND_NOT_ALLOWED', 'Only the person who received this payment can refund it.');
    }
  }

  /** System-initiated: return a captured charge whose credit never happened. Safe to repeat. */
  async releaseCapturedFunds(transactionId: string): Promise<void> {
    const txn = this.journal.find(transactionId);
    if (!txn || txn.status !== TransactionStatus.FAILED || !txn.fundsCaptured) return; // nothing left to do
    await this.reverse(transactionId, null);
  }

  /** `requester` is null when the system itself releases captured funds. */
  private async reverse(transactionId: string, requester: User | null): Promise<TransactionView> {
    const parties = this.parties.of(this.journal.require(transactionId));
    const { sender, receiver, source } = parties;
    const strategy = this.parties.strategyFor(source);

    // Hold BOTH wallets, always in the same order (so two refunds cannot deadlock):
    //  - the receiver's, because a refund takes money out of it;
    //  - the payer's, because their own payment (and its compensation) runs under that lock,
    //    and a refund must never overlap with it.
    const keys = [...new Set([`wallet:${sender.id}`, `wallet:${receiver.id}`])].sort();
    const underLocks = (work: () => Promise<TransactionView>, remaining = keys): Promise<TransactionView> =>
      remaining.length === 0 ? work() : this.locks.withLock(remaining[0], () => underLocks(work, remaining.slice(1)));

    return underLocks(async () => {
      const current = this.journal.require(transactionId); // state may have changed while we waited
      if (requester) this.assertMayRefund(current, requester);
      if (!requester && current.status !== TransactionStatus.FAILED) {
        // The system only ever releases captured funds of a FAILED payment, nothing else.
        throw new IllegalStateTransitionError(current.status, TransactionStatus.REFUNDED);
      }
      if (!current.canBeRefunded()) {
        throw new IllegalStateTransitionError(current.status, TransactionStatus.REFUNDED);
      }
      const refunded = await strategy.reverse({ transaction: current, sender, receiver, source });
      this.journal.announce(refunded, parties);
      return toTransactionView(refunded, toPartyView(sender), toPartyView(receiver), source);
    });
  }
}

/**
 * Observer that makes sure captured money never stays parked.
 *
 * If a bank or card was charged, the credit failed, AND the immediate refund could not reach
 * the gateway, the transaction is left FAILED with funds captured. This observer puts a job on
 * the queue, whose retries with backoff keep trying to return the money until the gateway is
 * back. Added without changing TransferService: it only subscribes to events.
 */
export class CompensationObserver implements TransactionObserver {
  readonly name = 'CompensationRetry';

  constructor(private readonly queue: MessageQueue) {}

  onTransactionEvent({ transaction, transition }: TransactionEvent): void {
    const stuck =
      transition.to === TransactionStatus.FAILED &&
      transaction.status === TransactionStatus.FAILED && // still FAILED now, i.e. the inline refund did not happen
      transaction.fundsCaptured;
    if (!stuck) return;
    this.queue.publish(COMPENSATIONS_TOPIC, { transactionId: transaction.id });
    tracer.step('Saga', 'Refund could not be completed now: queued for retry until the gateway is back', 'warn');
  }
}
