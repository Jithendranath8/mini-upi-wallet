import { TransactionStatus } from './enums';
import { IllegalStateTransitionError } from './errors';
import type { Transaction } from './Transaction';

/**
 * PATTERN: State.
 *
 * The lifecycle  INITIATED -> PROCESSING -> SUCCESS | FAILED -> REFUNDED  lives here, one class
 * per state. Each state decides which transitions are legal; anything it does not override is
 * rejected by the base class. Transaction never contains an `if (status === ...)` ladder.
 */
export abstract class TransactionState {
  abstract readonly status: TransactionStatus;

  startProcessing(_txn: Transaction): void {
    this.reject(TransactionStatus.PROCESSING);
  }

  succeed(_txn: Transaction): void {
    this.reject(TransactionStatus.SUCCESS);
  }

  fail(_txn: Transaction, _code: string, _reason: string): void {
    this.reject(TransactionStatus.FAILED);
  }

  refund(_txn: Transaction, _detail: string): void {
    this.reject(TransactionStatus.REFUNDED);
  }

  canRefund(_txn: Transaction): boolean {
    return false;
  }

  /** True when no further transition is possible from here. */
  isTerminal(_txn: Transaction): boolean {
    return false;
  }

  protected reject(target: TransactionStatus): never {
    throw new IllegalStateTransitionError(this.status, target);
  }
}

class InitiatedState extends TransactionState {
  readonly status = TransactionStatus.INITIATED;

  override startProcessing(txn: Transaction): void {
    txn.applyTransition(STATES.PROCESSING, 'Picked up for processing');
  }

  /** e.g. the sender's lock could not be acquired before processing ever began. */
  override fail(txn: Transaction, code: string, reason: string): void {
    txn.recordFailure(code, reason);
    txn.applyTransition(STATES.FAILED, reason);
  }
}

class ProcessingState extends TransactionState {
  readonly status = TransactionStatus.PROCESSING;

  override succeed(txn: Transaction): void {
    txn.applyTransition(STATES.SUCCESS, 'Money moved and ledger written');
  }

  override fail(txn: Transaction, code: string, reason: string): void {
    txn.recordFailure(code, reason);
    txn.applyTransition(STATES.FAILED, reason);
  }
}

class SuccessState extends TransactionState {
  readonly status = TransactionStatus.SUCCESS;

  override canRefund(): boolean {
    return true;
  }

  override refund(txn: Transaction, detail: string): void {
    txn.applyTransition(STATES.REFUNDED, detail);
  }
}

class FailedState extends TransactionState {
  readonly status = TransactionStatus.FAILED;

  /** A failed payment is refundable only if money had already left the payer's source. */
  override canRefund(txn: Transaction): boolean {
    return txn.fundsCaptured;
  }

  override refund(txn: Transaction, detail: string): void {
    if (!this.canRefund(txn)) this.reject(TransactionStatus.REFUNDED);
    txn.applyTransition(STATES.REFUNDED, detail);
  }

  /** Final, unless captured funds still have to be returned (FAILED -> REFUNDED). */
  override isTerminal(txn: Transaction): boolean {
    return !this.canRefund(txn);
  }
}

class RefundedState extends TransactionState {
  readonly status = TransactionStatus.REFUNDED;

  override isTerminal(): boolean {
    return true;
  }
}

/** States hold no data of their own, so one shared instance per status is enough. */
const STATES: Record<TransactionStatus, TransactionState> = {
  [TransactionStatus.INITIATED]: new InitiatedState(),
  [TransactionStatus.PROCESSING]: new ProcessingState(),
  [TransactionStatus.SUCCESS]: new SuccessState(),
  [TransactionStatus.FAILED]: new FailedState(),
  [TransactionStatus.REFUNDED]: new RefundedState(),
};

export function stateFor(status: TransactionStatus): TransactionState {
  return STATES[status];
}
