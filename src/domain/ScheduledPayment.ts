import { ScheduledPaymentStatus } from './enums';
import { ConflictError } from './errors';
import { Money } from './Money';

export interface ScheduledPaymentProps {
  id: string;
  userId: string;
  receiverUpiId: string;
  sourceId: string | null;
  amount: Money;
  note: string;
  executeAt: Date;
  status: ScheduledPaymentStatus;
  transactionId: string | null;
  failureReason: string | null;
  createdAt: Date;
}

/** A payment the user authorised now, to be executed later by the scheduler. */
export class ScheduledPayment {
  readonly id: string;
  readonly userId: string;
  readonly receiverUpiId: string;
  readonly sourceId: string | null;
  readonly amount: Money;
  readonly note: string;
  readonly executeAt: Date;
  readonly createdAt: Date;
  #status: ScheduledPaymentStatus;
  #transactionId: string | null;
  #failureReason: string | null;

  constructor(props: ScheduledPaymentProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.receiverUpiId = props.receiverUpiId;
    this.sourceId = props.sourceId;
    this.amount = props.amount;
    this.note = props.note;
    this.executeAt = props.executeAt;
    this.createdAt = props.createdAt;
    this.#status = props.status;
    this.#transactionId = props.transactionId;
    this.#failureReason = props.failureReason;
  }

  get status(): ScheduledPaymentStatus {
    return this.#status;
  }
  get transactionId(): string | null {
    return this.#transactionId;
  }
  get failureReason(): string | null {
    return this.#failureReason;
  }

  isDue(now: Date): boolean {
    return this.#status === ScheduledPaymentStatus.PENDING && this.executeAt <= now;
  }

  /** The scheduler has claimed this payment and is about to execute it. */
  markRunning(): void {
    this.assertPending('start');
    this.#status = ScheduledPaymentStatus.RUNNING;
  }

  markExecuted(transactionId: string): void {
    this.assertRunning('complete');
    this.#status = ScheduledPaymentStatus.EXECUTED;
    this.#transactionId = transactionId;
  }

  markFailed(reason: string, transactionId: string | null): void {
    this.assertRunning('fail');
    this.#status = ScheduledPaymentStatus.FAILED;
    this.#failureReason = reason;
    this.#transactionId = transactionId;
  }

  cancel(): void {
    this.assertPending('cancel');
    this.#status = ScheduledPaymentStatus.CANCELLED;
  }

  /** The key the scheduler pays with. Stable per schedule, so a re-run can never pay twice. */
  idempotencyKey(): string {
    return `scheduled:${this.id}`;
  }

  toProps(): ScheduledPaymentProps {
    return {
      id: this.id,
      userId: this.userId,
      receiverUpiId: this.receiverUpiId,
      sourceId: this.sourceId,
      amount: this.amount,
      note: this.note,
      executeAt: this.executeAt,
      status: this.#status,
      transactionId: this.#transactionId,
      failureReason: this.#failureReason,
      createdAt: this.createdAt,
    };
  }

  private assertPending(action: string): void {
    if (this.#status !== ScheduledPaymentStatus.PENDING) {
      throw new ConflictError(
        'SCHEDULE_NOT_PENDING',
        `Cannot ${action} a scheduled payment that is already ${this.#status}.`,
        { id: this.id, status: this.#status },
      );
    }
  }

  private assertRunning(action: string): void {
    if (this.#status !== ScheduledPaymentStatus.RUNNING) {
      throw new ConflictError(
        'SCHEDULE_NOT_RUNNING',
        `Cannot ${action} a scheduled payment that is ${this.#status}.`,
        { id: this.id, status: this.#status },
      );
    }
  }
}
