import { LedgerEntryType, PaymentSourceType, TransactionStatus } from '../domain/enums';
import { BusinessRuleError, DomainError, InsufficientBalanceError, NotFoundError } from '../domain/errors';
import type { Transaction } from '../domain/Transaction';
import type { Wallet } from '../domain/Wallet';
import type { UnitOfWork } from '../infrastructure/db/Database';
import { tracer } from '../infrastructure/observability/Tracer';
import type { TransactionRepository, WalletRepository } from '../repository/interfaces';
import type { LedgerService } from '../service/LedgerService';
import type { PaymentGateway } from './gateway/PaymentGateway';
import type { PaymentContext, PaymentStrategy } from './PaymentStrategy';

/** Collaborators every strategy needs. Grouped so constructors stay short. */
export interface SettlementDependencies {
  unitOfWork: UnitOfWork;
  wallets: WalletRepository;
  transactions: TransactionRepository;
  ledger: LedgerService;
}

/** Shared helpers for all strategies. */
abstract class BasePaymentStrategy implements PaymentStrategy {
  abstract readonly sourceType: PaymentSourceType;

  constructor(protected readonly deps: SettlementDependencies) {}

  abstract assertFundsAvailable(context: PaymentContext, senderWallet: Wallet): void;
  abstract pay(context: PaymentContext): Promise<Transaction>;
  abstract reverse(context: PaymentContext): Promise<Transaction>;

  protected walletOf(userId: string): Wallet {
    const wallet = this.deps.wallets.findByUserIdForUpdate(userId);
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `User ${userId} has no wallet.`);
    return wallet;
  }

  /**
   * Re-reads the transaction inside the unit of work. The state check and the money movement
   * then commit together, so a transaction can never be settled or refunded twice.
   */
  protected reload(transactionId: string): Transaction {
    const txn = this.deps.transactions.findById(transactionId);
    if (!txn) throw new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${transactionId} does not exist.`);
    return txn;
  }
}

/**
 * Wallet to wallet. Both balances, both ledger lines and the status change commit in ONE
 * database transaction: there is no moment at which money has left one wallet and not
 * arrived in the other.
 */
export class WalletPaymentStrategy extends BasePaymentStrategy {
  readonly sourceType = PaymentSourceType.WALLET;

  assertFundsAvailable(context: PaymentContext, senderWallet: Wallet): void {
    if (!senderWallet.hasSufficientBalance(context.transaction.amount)) {
      throw new InsufficientBalanceError(senderWallet.balance.paise, context.transaction.amount.paise);
    }
  }

  async pay({ transaction, sender, receiver, source }: PaymentContext): Promise<Transaction> {
    const settled = this.deps.unitOfWork.runInTransaction(() => {
      const txn = this.reload(transaction.id);
      const from = this.walletOf(sender.id);
      const to = this.walletOf(receiver.id);

      from.debit(txn.amount); // throws InsufficientBalanceError -> whole unit of work rolls back
      to.credit(txn.amount);
      this.deps.wallets.save(from);
      this.deps.wallets.save(to);

      this.deps.ledger.record(txn, [
        {
          accountId: source.ledgerAccountId(),
          entryType: LedgerEntryType.DEBIT,
          balanceAfter: from.balance,
          description: `Paid to ${receiver.upiId}`,
        },
        {
          accountId: `WALLET:${to.id}`,
          entryType: LedgerEntryType.CREDIT,
          balanceAfter: to.balance,
          description: `Received from ${sender.upiId}`,
        },
      ]);

      txn.succeed();
      this.deps.transactions.update(txn);
      return txn;
    });
    tracer.step('Database', 'Committed atomically: debit + credit + 2 ledger entries + status SUCCESS', 'ok');
    return settled;
  }

  async reverse({ transaction, sender, receiver, source }: PaymentContext): Promise<Transaction> {
    const settled = this.deps.unitOfWork.runInTransaction(() => {
      const txn = this.reload(transaction.id);
      txn.refund(); // throws IllegalStateTransitionError unless the stored state is refundable
      const from = this.walletOf(receiver.id);
      const to = this.walletOf(sender.id);

      from.debit(txn.amount);
      to.credit(txn.amount);
      this.deps.wallets.save(from);
      this.deps.wallets.save(to);

      this.deps.ledger.record(txn, [
        {
          accountId: `WALLET:${from.id}`,
          entryType: LedgerEntryType.DEBIT,
          balanceAfter: from.balance,
          description: `Refund of ${txn.id} to ${sender.upiId}`,
        },
        {
          accountId: source.ledgerAccountId(),
          entryType: LedgerEntryType.CREDIT,
          balanceAfter: to.balance,
          description: `Refund of ${txn.id} from ${receiver.upiId}`,
        },
      ]);

      this.deps.transactions.update(txn);
      return txn;
    });
    tracer.step('Database', 'Committed atomically: reversing debit + credit + 2 ledger entries + status REFUNDED', 'ok');
    return settled;
  }
}

/**
 * PATTERN: Template Method.
 *
 * Bank and card payments follow the same skeleton, which is fixed here:
 *
 *   1. authorise (hook)            - subclasses may add a step, e.g. 3-D Secure for cards
 *   2. charge the external gateway - money leaves the bank/card
 *   3. credit the receiver's wallet + ledger + SUCCESS, in one database transaction
 *   4. if step 3 fails, compensate - refund the gateway charge (Saga), FAILED -> REFUNDED
 *
 * Steps 2 and 3 cannot share a database transaction because the gateway is another system.
 * That is why step 4 exists.
 */
export abstract class ExternalPaymentStrategy extends BasePaymentStrategy {
  constructor(
    deps: SettlementDependencies,
    protected readonly gateway: PaymentGateway,
  ) {
    super(deps);
  }

  /** Hook: runs before the charge. Default does nothing. */
  protected authorise(_context: PaymentContext): void {}

  /** The bank or card network checks the funds when we charge; nothing to pre-check locally. */
  assertFundsAvailable(): void {}

  async pay(context: PaymentContext): Promise<Transaction> {
    const { transaction, receiver, source } = context;

    this.authorise(context);

    tracer.step('Gateway', `Charging ${transaction.amount.format()} to ${source.describe()} via ${this.gateway.name}`);
    const receipt = await this.gateway.charge({
      reference: transaction.id,
      sourceId: source.id,
      amount: transaction.amount,
    });
    tracer.step('Gateway', `${this.gateway.name} approved the charge (${receipt.gatewayTransactionId})`, 'ok');

    transaction.markFundsCaptured(receipt.gatewayTransactionId);
    this.deps.transactions.update(transaction);

    try {
      const settled = this.deps.unitOfWork.runInTransaction(() => {
        const txn = this.reload(transaction.id);
        const to = this.walletOf(receiver.id);
        to.credit(txn.amount);
        this.deps.wallets.save(to);

        this.deps.ledger.record(txn, [
          {
            accountId: source.ledgerAccountId(),
            entryType: LedgerEntryType.DEBIT,
            balanceAfter: null,
            description: `Charged ${source.describe()} via ${this.gateway.name}`,
          },
          {
            accountId: `WALLET:${to.id}`,
            entryType: LedgerEntryType.CREDIT,
            balanceAfter: to.balance,
            description: `Received from ${context.sender.upiId}`,
          },
        ]);

        txn.succeed();
        this.deps.transactions.update(txn);
        return txn;
      });
      tracer.step('Database', 'Committed atomically: wallet credit + 2 ledger entries + status SUCCESS', 'ok');
      return settled;
    } catch (error) {
      await this.compensate(transaction, error); // throws CREDIT_FAILED_REFUND_PENDING if it cannot finish
      throw new BusinessRuleError(
        'CREDIT_FAILED_REFUNDED',
        'The receiver could not be credited, so the amount was returned to your account.',
        { cause: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' },
      );
    }
  }

  async reverse({ transaction, sender, receiver, source }: PaymentContext): Promise<Transaction> {
    if (transaction.status === TransactionStatus.FAILED) {
      // The charge was captured but the receiver was never credited (an earlier compensation
      // could not reach the gateway). Only the gateway side has to be undone.
      await this.gateway.refund(transaction.id);
      transaction.refund('Captured charge returned to the source');
      this.deps.transactions.update(transaction);
      return transaction;
    }

    // Check before touching the gateway: the receiver must still hold the money.
    const receiverWallet = this.walletOf(receiver.id);
    if (!receiverWallet.hasSufficientBalance(transaction.amount)) {
      throw new BusinessRuleError('REFUND_NOT_POSSIBLE', 'The receiver no longer has enough balance to refund this payment.');
    }
    receiverWallet.debit(transaction.amount); // dry run on a throwaway copy: throws if the wallet is frozen

    tracer.step('Gateway', `Asking ${this.gateway.name} to return ${transaction.amount.format()} to ${source.describe()}`);
    await this.gateway.refund(transaction.id);

    const settled = this.deps.unitOfWork.runInTransaction(() => {
      const txn = this.reload(transaction.id);
      txn.refund();
      const from = this.walletOf(receiver.id);
      from.debit(txn.amount);
      this.deps.wallets.save(from);

      this.deps.ledger.record(txn, [
        {
          accountId: `WALLET:${from.id}`,
          entryType: LedgerEntryType.DEBIT,
          balanceAfter: from.balance,
          description: `Refund of ${txn.id} to ${sender.upiId}`,
        },
        {
          accountId: source.ledgerAccountId(),
          entryType: LedgerEntryType.CREDIT,
          balanceAfter: null,
          description: `Returned to ${source.describe()} via ${this.gateway.name}`,
        },
      ]);

      this.deps.transactions.update(txn);
      return txn;
    });
    tracer.step('Database', 'Committed atomically: wallet debit + 2 ledger entries + status REFUNDED', 'ok');
    return settled;
  }

  /** Saga compensation: the charge succeeded but the credit did not, so undo the charge. */
  private async compensate(transaction: Transaction, cause: unknown): Promise<void> {
    const reason = cause instanceof Error ? cause.message : 'unknown error';
    tracer.step('Saga', `Credit step failed after the charge succeeded (${reason}). Compensating.`, 'error');

    transaction.fail('CREDIT_FAILED', 'The receiver could not be credited after the source was charged.');
    this.deps.transactions.update(transaction);

    try {
      await this.gateway.refund(transaction.id);
    } catch (refundError) {
      // The money is captured and cannot be returned right now. The transaction stays FAILED
      // with funds captured; CompensationObserver queues the refund for retry.
      const why = refundError instanceof Error ? refundError.message : 'gateway error';
      tracer.step('Saga', `${this.gateway.name} could not return the money yet (${why})`, 'error');
      throw new BusinessRuleError(
        'CREDIT_FAILED_REFUND_PENDING',
        'The receiver could not be credited. Your money is on hold and will be returned automatically.',
      );
    }

    transaction.refund('Charge returned to the source automatically');
    this.deps.transactions.update(transaction);
    tracer.step('Saga', `${this.gateway.name} returned the money. Transaction is REFUNDED.`, 'ok');
  }
}

export class BankTransferStrategy extends ExternalPaymentStrategy {
  readonly sourceType = PaymentSourceType.BANK_ACCOUNT;
}

export class CardPaymentStrategy extends ExternalPaymentStrategy {
  readonly sourceType = PaymentSourceType.CARD;

  protected override authorise({ source }: PaymentContext): void {
    tracer.step('Gateway', `3-D Secure check passed for ${source.describe()} (simulated)`, 'ok');
  }
}
