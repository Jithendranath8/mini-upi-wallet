import { ScheduledPaymentStatus } from '../domain/enums';
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../domain/errors';
import type { Money } from '../domain/Money';
import { ScheduledPayment } from '../domain/ScheduledPayment';
import type { User } from '../domain/User';
import { RequestTrace, tracer } from '../infrastructure/observability/Tracer';
import type { PaymentSourceRepository, ScheduledPaymentRepository } from '../repository/interfaces';
import { newId } from '../util/ids';
import type { TransferService } from './TransferService';
import type { UserService } from './UserService';

export interface SchedulePaymentInput {
  receiverUpiId: string;
  amount: Money;
  sourceId?: string;
  note?: string;
  executeAt: Date;
}

const MAX_DAYS_AHEAD = 30;

/**
 * Scheduled payments, added WITHOUT modifying the payment flow (Open/Closed in practice).
 *
 * This class only decides *when* to pay. To actually pay it calls the same
 * TransferService.transfer() the API uses, so a scheduled payment gets the validation chain,
 * fraud rules, locking, ledger and notifications for free. Its idempotency key is derived
 * from the schedule id, so a scheduler that crashes and re-runs can never pay twice.
 *
 * Run versus cancel is decided by the database: both are compare-and-set writes on the status
 * (PENDING -> RUNNING, PENDING -> CANCELLED), so exactly one of them can win.
 */
export class ScheduledPaymentService {
  constructor(
    private readonly scheduled: ScheduledPaymentRepository,
    private readonly users: UserService,
    private readonly sources: PaymentSourceRepository,
    private readonly transfers: TransferService,
  ) {}

  /** The caller has already verified the user's PIN: that is the authorisation for the later debit. */
  schedule(user: User, input: SchedulePaymentInput): ScheduledPayment {
    const now = new Date();
    if (Number.isNaN(input.executeAt.getTime()) || input.executeAt <= now) {
      throw new ValidationError('INVALID_SCHEDULE_TIME', 'Choose a time in the future.');
    }
    if (input.executeAt.getTime() - now.getTime() > MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
      throw new ValidationError('INVALID_SCHEDULE_TIME', `Payments can be scheduled at most ${MAX_DAYS_AHEAD} days ahead.`);
    }
    if (input.amount.isZero()) {
      throw new ValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.');
    }
    const receiver = this.users.findByUpiId(input.receiverUpiId);
    if (!receiver) {
      throw new NotFoundError('RECEIVER_NOT_FOUND', `${input.receiverUpiId} is not a registered UPI ID.`);
    }
    if (input.sourceId && this.sources.findById(input.sourceId)?.userId !== user.id) {
      throw new NotFoundError('SOURCE_NOT_FOUND', 'That payment source is not linked to your account.');
    }

    const payment = new ScheduledPayment({
      id: newId('sch'),
      userId: user.id,
      receiverUpiId: receiver.upiId,
      sourceId: input.sourceId ?? null,
      amount: input.amount,
      note: (input.note ?? '').trim().slice(0, 80),
      executeAt: input.executeAt,
      status: ScheduledPaymentStatus.PENDING,
      transactionId: null,
      failureReason: null,
      createdAt: now,
    });
    this.scheduled.insert(payment);
    return payment;
  }

  cancel(user: User, id: string): ScheduledPayment {
    const payment = this.scheduled.findById(id);
    if (!payment || payment.userId !== user.id) {
      throw new NotFoundError('SCHEDULE_NOT_FOUND', `No scheduled payment ${id} on your account.`);
    }
    payment.cancel(); // throws unless PENDING
    if (!this.scheduled.transition(payment, ScheduledPaymentStatus.PENDING)) {
      // The scheduler claimed it between our read and our write.
      throw new ConflictError('SCHEDULE_NOT_PENDING', 'This payment has just started and can no longer be cancelled.', {
        id,
      });
    }
    return payment;
  }

  listFor(userId: string): ScheduledPayment[] {
    return this.scheduled.findByUser(userId);
  }

  /** Executes everything that is due. Returns how many payments it actually claimed and ran. */
  async runDue(now = new Date()): Promise<number> {
    let executed = 0;
    for (const payment of this.scheduled.findDue(now, 20)) {
      const trace = new RequestTrace(newId('job'), `Scheduled payment ${payment.id}`);
      if (await tracer.run(trace, () => this.execute(payment))) executed += 1;
    }
    return executed;
  }

  /** Returns false if the payment was no longer pending (cancelled or taken) and nothing ran. */
  private async execute(payment: ScheduledPayment): Promise<boolean> {
    // Claim it first. If the user cancelled a moment ago, the claim fails and nothing is paid.
    payment.markRunning();
    if (!this.scheduled.transition(payment, ScheduledPaymentStatus.PENDING)) {
      tracer.step('Scheduler', `${payment.id} is no longer pending (cancelled or already taken): skipped`, 'warn');
      return false;
    }
    tracer.step('Scheduler', `Executing ${payment.amount.format()} to ${payment.receiverUpiId}, scheduled for ${payment.executeAt.toISOString()}`);
    try {
      const { result } = await this.transfers.transfer({
        idempotencyKey: payment.idempotencyKey(),
        senderId: payment.userId,
        receiverUpiId: payment.receiverUpiId,
        amount: payment.amount,
        sourceId: payment.sourceId ?? undefined,
        note: payment.note,
      });
      if (result.error) payment.markFailed(result.error.message, result.transaction.id);
      else payment.markExecuted(result.transaction.id);
    } catch (error) {
      // Only messages meant for users are stored; anything unexpected is logged, not shown.
      const message = error instanceof DomainError ? error.message : 'The payment could not be started.';
      if (!(error instanceof DomainError)) console.error(`[scheduler] ${payment.id} failed unexpectedly`, error);
      tracer.step('Scheduler', `Could not execute ${payment.id}: ${message}`, 'error');
      payment.markFailed(message, null);
    }
    this.scheduled.transition(payment, ScheduledPaymentStatus.RUNNING);
    return true;
  }
}

/** Polls for due payments. In production this is a cron job or a delayed queue with one leader. */
export class PaymentScheduler {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly service: ScheduledPaymentService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.#running) return; // the previous run is still going; never overlap
    this.#running = true;
    try {
      await this.service.runDue();
    } catch (error) {
      console.error('[scheduler] run failed', error);
    } finally {
      this.#running = false;
    }
  }
}
