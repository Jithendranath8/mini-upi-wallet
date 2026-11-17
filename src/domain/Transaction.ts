import { PaymentSourceType, TransactionStatus, TransactionType } from './enums';
import { ValidationError } from './errors';
import { Money } from './Money';
import { stateFor, TransactionState } from './TransactionState';

export interface TransactionProps {
  id: string;
  idempotencyKey: string;
  type: TransactionType;
  senderId: string;
  receiverId: string;
  sourceId: string;
  sourceType: PaymentSourceType;
  amount: Money;
  note: string;
  status: TransactionStatus;
  failureCode: string | null;
  failureReason: string | null;
  fundsCaptured: boolean;
  gatewayReference: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Optimistic-lock counter of the stored row. Defaults to 0 for a transaction not stored yet. */
  version?: number;
}

/** One step of the lifecycle, kept so observers can be told exactly what happened. */
export interface StateTransition {
  from: TransactionStatus | null;
  to: TransactionStatus;
  detail: string;
  at: Date;
}

/**
 * A single movement of money and its lifecycle.
 *
 * The status is not a plain field: it is a TransactionState object (State pattern), and every
 * change goes through it. Each transition is queued for the repository, which stores it in
 * `transaction_events` in the SAME database transaction as the new status. That table is both
 * the audit trail and the outbox from which observers are notified after the commit.
 */
export class Transaction {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly type: TransactionType;
  readonly senderId: string;
  readonly receiverId: string;
  readonly sourceId: string;
  readonly sourceType: PaymentSourceType;
  readonly amount: Money;
  readonly note: string;
  readonly createdAt: Date;

  #state: TransactionState;
  #failureCode: string | null;
  #failureReason: string | null;
  #fundsCaptured: boolean;
  #gatewayReference: string | null;
  #updatedAt: Date;
  #version: number;
  #unrecordedTransitions: StateTransition[] = [];

  private constructor(props: TransactionProps) {
    this.id = props.id;
    this.idempotencyKey = props.idempotencyKey;
    this.type = props.type;
    this.senderId = props.senderId;
    this.receiverId = props.receiverId;
    this.sourceId = props.sourceId;
    this.sourceType = props.sourceType;
    this.amount = props.amount;
    this.note = props.note;
    this.createdAt = props.createdAt;
    this.#state = stateFor(props.status);
    this.#failureCode = props.failureCode;
    this.#failureReason = props.failureReason;
    this.#fundsCaptured = props.fundsCaptured;
    this.#gatewayReference = props.gatewayReference;
    this.#updatedAt = props.updatedAt;
    this.#version = props.version ?? 0;
  }

  /** Rebuild a transaction that already exists in storage. */
  static rehydrate(props: TransactionProps): Transaction {
    return new Transaction(props);
  }

  /** Start a brand-new transaction in INITIATED. Use Transaction.builder() from application code. */
  static initiate(
    props: Omit<
      TransactionProps,
      'status' | 'failureCode' | 'failureReason' | 'fundsCaptured' | 'gatewayReference' | 'updatedAt'
    >,
  ): Transaction {
    const txn = new Transaction({
      ...props,
      status: TransactionStatus.INITIATED,
      failureCode: null,
      failureReason: null,
      fundsCaptured: false,
      gatewayReference: null,
      updatedAt: props.createdAt,
    });
    const created: StateTransition = {
      from: null,
      to: TransactionStatus.INITIATED,
      detail: 'Payment request accepted',
      at: props.createdAt,
    };
    txn.#unrecordedTransitions.push(created);
    return txn;
  }

  static builder(): TransactionBuilder {
    return new TransactionBuilder();
  }

  get status(): TransactionStatus {
    return this.#state.status;
  }
  get failureCode(): string | null {
    return this.#failureCode;
  }
  get failureReason(): string | null {
    return this.#failureReason;
  }
  get fundsCaptured(): boolean {
    return this.#fundsCaptured;
  }
  get gatewayReference(): string | null {
    return this.#gatewayReference;
  }
  get updatedAt(): Date {
    return this.#updatedAt;
  }
  get version(): number {
    return this.#version;
  }

  // ---- Lifecycle: every call is delegated to the current state object ----------------

  startProcessing(): void {
    this.#state.startProcessing(this);
  }

  succeed(): void {
    this.#state.succeed(this);
  }

  fail(code: string, reason: string): void {
    this.#state.fail(this, code, reason);
  }

  refund(detail = 'Amount returned to the payer'): void {
    this.#state.refund(this, detail);
  }

  canBeRefunded(): boolean {
    return this.#state.canRefund(this);
  }

  isTerminal(): boolean {
    return this.#state.isTerminal(this);
  }

  /** Money has left the payer's external source (bank/card). Enables FAILED -> REFUNDED. */
  markFundsCaptured(gatewayReference: string): void {
    this.#fundsCaptured = true;
    this.#gatewayReference = gatewayReference;
    this.#updatedAt = new Date();
  }

  /** Transitions not yet written to the audit trail. Read by the repository while saving. */
  unrecordedTransitions(): readonly StateTransition[] {
    return this.#unrecordedTransitions;
  }

  /** Called by the repository after the first INSERT (the stored version starts at 0). */
  markInserted(): void {
    this.#unrecordedTransitions = [];
  }

  /** Called by the repository after a successful versioned UPDATE. */
  markPersisted(): void {
    this.#version += 1;
    this.#unrecordedTransitions = [];
  }

  toProps(): TransactionProps {
    return {
      id: this.id,
      idempotencyKey: this.idempotencyKey,
      type: this.type,
      senderId: this.senderId,
      receiverId: this.receiverId,
      sourceId: this.sourceId,
      sourceType: this.sourceType,
      amount: this.amount,
      note: this.note,
      status: this.status,
      failureCode: this.#failureCode,
      failureReason: this.#failureReason,
      fundsCaptured: this.#fundsCaptured,
      gatewayReference: this.#gatewayReference,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      version: this.#version,
    };
  }

  // ---- Called only by TransactionState implementations -------------------------------

  applyTransition(next: TransactionState, detail: string): void {
    const at = new Date();
    const transition: StateTransition = { from: this.#state.status, to: next.status, detail, at };
    this.#unrecordedTransitions.push(transition);
    this.#state = next;
    this.#updatedAt = at;
  }

  recordFailure(code: string, reason: string): void {
    this.#failureCode = code;
    this.#failureReason = reason;
  }
}

/**
 * PATTERN: Builder.
 *
 * A transaction has many required parts and a few rules that tie them together. The builder
 * gives call sites a readable, order-independent way to assemble one and refuses to build
 * anything incomplete or invalid.
 */
export class TransactionBuilder {
  #id?: string;
  #idempotencyKey?: string;
  #type: TransactionType = TransactionType.P2P;
  #senderId?: string;
  #receiverId?: string;
  #sourceId?: string;
  #sourceType?: PaymentSourceType;
  #amount?: Money;
  #note = '';
  #createdAt: Date = new Date();

  withId(id: string): this {
    this.#id = id;
    return this;
  }

  withIdempotencyKey(key: string): this {
    this.#idempotencyKey = key;
    return this;
  }

  ofType(type: TransactionType): this {
    this.#type = type;
    return this;
  }

  from(senderId: string): this {
    this.#senderId = senderId;
    return this;
  }

  to(receiverId: string): this {
    this.#receiverId = receiverId;
    return this;
  }

  fundedBy(sourceId: string, sourceType: PaymentSourceType): this {
    this.#sourceId = sourceId;
    this.#sourceType = sourceType;
    return this;
  }

  forAmount(amount: Money): this {
    this.#amount = amount;
    return this;
  }

  withNote(note: string | undefined): this {
    this.#note = (note ?? '').trim();
    return this;
  }

  createdAt(at: Date): this {
    this.#createdAt = at;
    return this;
  }

  build(): Transaction {
    const missing = Object.entries({
      id: this.#id,
      idempotencyKey: this.#idempotencyKey,
      senderId: this.#senderId,
      receiverId: this.#receiverId,
      sourceId: this.#sourceId,
      sourceType: this.#sourceType,
      amount: this.#amount,
    })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new ValidationError('INCOMPLETE_TRANSACTION', `Transaction is missing: ${missing.join(', ')}`);
    }
    if (this.#amount!.isZero()) {
      throw new ValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.');
    }
    if (this.#note.length > 80) {
      throw new ValidationError('NOTE_TOO_LONG', 'Note can be at most 80 characters.');
    }
    return Transaction.initiate({
      id: this.#id!,
      idempotencyKey: this.#idempotencyKey!,
      type: this.#type,
      senderId: this.#senderId!,
      receiverId: this.#receiverId!,
      sourceId: this.#sourceId!,
      sourceType: this.#sourceType!,
      amount: this.#amount!,
      note: this.#note,
      createdAt: this.#createdAt,
    });
  }
}
