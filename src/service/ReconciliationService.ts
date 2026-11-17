import type { OutboxRelay } from '../events/Outbox';
import { tracer } from '../infrastructure/observability/Tracer';
import type { PaymentGateway } from '../payment/gateway/PaymentGateway';
import type { PaymentSource } from '../domain/PaymentSource';
import type {
  IdempotencyRepository,
  ScheduledPaymentRepository,
  TransactionRepository,
} from '../repository/interfaces';
import type { PartyResolver, TransactionJournal } from './TransactionJournal';

export interface ReconciliationReport {
  /** Payments found half-done and closed as FAILED. */
  interruptedPayments: number;
  /** Of those, how many had already been charged at a bank or card (their refund is now queued). */
  capturedAndQueuedForRefund: number;
  /** Payments we could not decide because the gateway did not answer; left for the next run. */
  undecided: number;
  /** Committed state changes that were never announced to observers, now announced. */
  relayedEvents: number;
  /** Idempotency keys left IN_PROGRESS by requests that died. */
  releasedKeys: number;
  /** Scheduled payments claimed by a scheduler that died, put back in line. */
  requeuedSchedules: number;
}

/**
 * Cleans up after a crash. Runs once at start-up, before any request is served.
 *
 * A process can die at any line. Everything that moves money commits atomically, so a crash
 * never leaves money half-moved; what it can leave behind is bookkeeping in a non-final state:
 *
 *   payment INITIATED / PROCESSING   wallet-funded: the money transaction never committed, so
 *                                    nothing moved -> FAILED.
 *                                    bank/card-funded: ASK THE GATEWAY whether the charge
 *                                    happened. Charged -> FAILED with funds captured (the
 *                                    refund is queued). Not charged -> FAILED.
 *   events committed, not published  relay them from the outbox.
 *   idempotency key IN_PROGRESS      release it; a retry is then answered from the stored
 *                                    transaction (TransferService, second line of defence).
 *   scheduled payment RUNNING        back to PENDING; its fixed idempotency key makes the
 *                                    re-run safe.
 *
 * With several app nodes this would run as a periodic job that only touches rows older than
 * a lease time, instead of "everything unfinished at start-up".
 */
export class ReconciliationService {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly parties: PartyResolver,
    private readonly journal: TransactionJournal,
    private readonly outbox: OutboxRelay,
    private readonly idempotencyKeys: IdempotencyRepository,
    private readonly scheduled: ScheduledPaymentRepository,
    private readonly gatewayFor: (source: PaymentSource) => PaymentGateway | undefined,
  ) {}

  async run(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      interruptedPayments: 0,
      capturedAndQueuedForRefund: 0,
      undecided: 0,
      relayedEvents: 0,
      releasedKeys: 0,
      requeuedSchedules: 0,
    };

    for (const txn of this.transactions.findUnfinished()) {
      let parties;
      try {
        parties = this.parties.of(txn);
      } catch (error) {
        // A row we cannot interpret must not stop the service from starting. Leave it, say so.
        console.error(`[reconciliation] cannot resolve the parties of ${txn.id}; left as ${txn.status}`, error);
        report.undecided += 1;
        continue;
      }
      const gateway = this.gatewayFor(parties.source);

      if (gateway && !txn.fundsCaptured) {
        // We never saw the outcome of the charge. Do not guess: ask.
        try {
          const status = await gateway.statusOf(txn.id);
          if (status.state === 'CAPTURED') txn.markFundsCaptured(status.gatewayTransactionId);
        } catch {
          report.undecided += 1; // gateway unreachable: decide on a later run, never by assumption
          continue;
        }
      }

      txn.fail(
        'INTERRUPTED',
        txn.fundsCaptured
          ? 'The service restarted before this payment finished. Your money will be returned automatically.'
          : 'The service restarted before this payment finished. No money was moved.',
      );
      // Saving announces the FAILED event; CompensationObserver queues the refund if funds were captured.
      this.journal.save(txn, parties);
      report.interruptedPayments += 1;
      if (txn.fundsCaptured) report.capturedAndQueuedForRefund += 1;
    }

    report.relayedEvents = this.outbox.relayAll();
    report.releasedKeys = this.idempotencyKeys.releaseAllInProgress();
    report.requeuedSchedules = this.scheduled.requeueRunning();

    const touched = Object.values(report).some((count) => count > 0);
    if (touched) tracer.step('Recovery', `Start-up reconciliation: ${JSON.stringify(report)}`, 'warn');
    return report;
  }
}
