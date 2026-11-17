import { createHash } from 'node:crypto';
import { TransactionStatus, TransactionType } from '../domain/enums';
import { DomainError, ErrorCategory, ForbiddenError, NotFoundError, RequestInProgressError } from '../domain/errors';
import type { Money } from '../domain/Money';
import { Transaction } from '../domain/Transaction';
import type { TransactionParties } from '../events/Outbox';
import type { LockManager } from '../infrastructure/lock/LockManager';
import { tracer } from '../infrastructure/observability/Tracer';
import { toPartyView, toTransactionView, type TransactionView } from '../readmodel/views';
import type { WalletRepository } from '../repository/interfaces';
import { newId } from '../util/ids';
import type { ValidationPipeline } from '../validation/ValidationHandler';
import type { IdempotencyService, IdempotentOutcome } from './IdempotencyService';
import type { PartyResolver, TransactionJournal } from './TransactionJournal';

export interface TransferCommand {
  /** Client-generated; the same value on every retry of this payment. */
  idempotencyKey: string;
  senderId: string;
  receiverUpiId: string;
  amount: Money;
  /** Defaults to the sender's wallet. */
  sourceId?: string;
  note?: string;
}

export interface TransferFailure {
  code: string;
  message: string;
  /** The kind of failure; the API layer turns it into a status code. */
  category: ErrorCategory;
  details?: Record<string, unknown>;
}

/** The stored, replayable outcome of a transfer: the transaction and, if it failed, why. */
export interface TransferResult {
  transaction: TransactionView;
  error?: TransferFailure;
}

/**
 * Orchestrates one payment end to end (a Facade over the subsystems below).
 *
 *   idempotency -> create INITIATED -> lock payer -> PROCESSING -> validation chain
 *   -> payment strategy (atomic money movement + ledger) -> SUCCESS / FAILED -> events
 *
 * It owns the ORDER of the steps and nothing else:
 *   who is involved        -> PartyResolver
 *   storing and announcing -> TransactionJournal (repository + outbox)
 *   retries                -> IdempotencyService
 *   one payer at a time    -> LockManager
 *   the rules              -> ValidationPipeline
 *   moving the money       -> PaymentStrategy, chosen by the source
 */
export class TransferService {
  constructor(
    private readonly parties: PartyResolver,
    private readonly journal: TransactionJournal,
    private readonly wallets: WalletRepository,
    private readonly idempotency: IdempotencyService,
    private readonly locks: LockManager,
    private readonly validation: ValidationPipeline,
    /** One network round trip to the database (simulated; a real database is never in-process). */
    private readonly databaseRoundTrip: () => Promise<void>,
  ) {}

  transfer(command: TransferCommand): Promise<IdempotentOutcome<TransferResult>> {
    return this.idempotency.execute(command.senderId, command.idempotencyKey, fingerprint(command), () =>
      this.process(command),
    );
  }

  private async process(command: TransferCommand): Promise<TransferResult> {
    // 0. Second line of defence. If a transaction already exists for this (sender, key) but
    //    the idempotency record was lost, answer from the transaction instead of paying again.
    const earlier = this.journal.findByKey(command.senderId, command.idempotencyKey);
    if (earlier) return this.answerFromStored(earlier);

    // 1. Resolve everyone involved. Failures here throw: nothing has been recorded yet,
    //    so the idempotency key is released and the client may fix the request and retry.
    const parties = this.parties.forNewPayment(command.senderId, command.receiverUpiId, command.sourceId);
    const { sender, receiver, source } = parties;
    if (!sender.isActive()) {
      throw new ForbiddenError('SENDER_BLOCKED', 'Your account is blocked and cannot send money.');
    }
    const strategy = this.parties.strategyFor(source);
    tracer.step('Strategy', `${source.type} source selected: ${strategy.constructor.name}`);

    // 2. Record the intent. From here on every outcome is stored against the idempotency key.
    let txn = Transaction.builder()
      .withId(newId('txn'))
      .withIdempotencyKey(command.idempotencyKey)
      .ofType(sender.id === receiver.id ? TransactionType.TOPUP : TransactionType.P2P)
      .from(sender.id)
      .to(receiver.id)
      .fundedBy(source.id, source.type)
      .forAmount(command.amount)
      .withNote(command.note)
      .build();
    this.journal.open(txn, parties);

    try {
      // 3. One payment at a time per payer: the checks below and the debit that follows
      //    see the same balance. This is what stops a double spend.
      txn = await this.locks.withLock(`wallet:${sender.id}`, async () => {
        // Talking to a real database takes time, and other requests arrive meanwhile.
        // Holding the payer's lock across that gap is exactly what makes the checks below safe.
        await this.databaseRoundTrip();
        txn.startProcessing();
        this.journal.save(txn, parties);

        // 4. Validation chain: account status -> source -> funds -> daily limit -> fraud.
        this.validation.validate({
          transaction: txn,
          sender,
          receiver,
          source,
          strategy,
          senderWallet: this.requireWallet(sender.id),
          now: new Date(),
        });

        // 5. Move the money. The strategy commits balances, ledger, SUCCESS and the
        //    state-change event atomically.
        return strategy.pay({ transaction: txn, sender, receiver, source });
      });
    } catch (error) {
      return this.settleFailure(txn, error, parties);
    }

    // 6. Relay the committed events to the observers (notifications, metrics, tracing).
    this.journal.announce(txn, parties);
    return { transaction: toTransactionView(txn, toPartyView(sender), toPartyView(receiver), source) };
  }

  /** Turns any failure after step 2 into a recorded FAILED (or already REFUNDED) transaction. */
  private settleFailure(txn: Transaction, error: unknown, parties: TransactionParties): TransferResult {
    const failure = toFailure(error);
    if (!(error instanceof DomainError)) {
      console.error(`[transfer ${txn.id}] unexpected failure`, error);
    }
    const stillOpen = txn.status === TransactionStatus.INITIATED || txn.status === TransactionStatus.PROCESSING;
    if (stillOpen) {
      txn.fail(failure.code, failure.message);
      this.journal.save(txn, parties);
    } else {
      this.journal.announce(txn, parties); // the strategy already settled it (e.g. REFUNDED by the saga)
    }
    return {
      transaction: toTransactionView(txn, toPartyView(parties.sender), toPartyView(parties.receiver), parties.source),
      error: failure,
    };
  }

  private answerFromStored(txn: Transaction): TransferResult {
    tracer.step('Idempotency', `Transaction ${txn.id} already exists for this key: answering from it`, 'warn');
    const { sender, receiver, source } = this.parties.of(txn);
    const view = toTransactionView(txn, toPartyView(sender), toPartyView(receiver), source);
    if (txn.status === TransactionStatus.SUCCESS) return { transaction: view };
    if (txn.status === TransactionStatus.INITIATED || txn.status === TransactionStatus.PROCESSING) {
      throw new RequestInProgressError(txn.idempotencyKey); // not finished: there is no answer to replay yet
    }
    return {
      transaction: view,
      error: {
        code: txn.failureCode ?? 'PAYMENT_NOT_COMPLETED',
        message: txn.failureReason ?? `This payment is ${txn.status}.`,
        category: ErrorCategory.RULE_VIOLATION,
      },
    };
  }

  private requireWallet(userId: string) {
    const wallet = this.wallets.findByUserIdForUpdate(userId);
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `User ${userId} has no wallet.`);
    return wallet;
  }
}

function toFailure(error: unknown): TransferFailure {
  if (error instanceof DomainError) {
    return { code: error.code, message: error.message, category: error.category, details: error.details };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong on our side. The payment was not completed.',
    category: ErrorCategory.INTERNAL,
  };
}

/** Hash of the meaningful request fields. Used to detect an idempotency key reused for a different request. */
function fingerprint(command: TransferCommand): string {
  const canonical = JSON.stringify([
    command.receiverUpiId.trim().toLowerCase(),
    command.amount.paise,
    command.sourceId ?? 'WALLET',
    (command.note ?? '').trim(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
