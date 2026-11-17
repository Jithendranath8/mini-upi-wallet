import { PaymentSourceType } from '../domain/enums';
import { ValidationError } from '../domain/errors';
import type { PaymentSource } from '../domain/PaymentSource';
import type { Transaction } from '../domain/Transaction';
import type { User } from '../domain/User';
import type { Wallet } from '../domain/Wallet';

/** Everything a strategy needs to know about one payment. */
export interface PaymentContext {
  transaction: Transaction;
  sender: User;
  receiver: User;
  source: PaymentSource;
}

/**
 * PATTERN: Strategy.
 *
 * "How does the money move?" depends on where it comes from. Each payment method is one
 * implementation of this interface; TransferService only ever talks to the interface.
 * A new method (say UPI Lite or a credit line) is a new class registered with the factory.
 * No existing class changes (Open/Closed).
 */
export interface PaymentStrategy {
  readonly sourceType: PaymentSourceType;

  /** Pre-check used by the validation chain. Throws if the payer clearly cannot afford this. */
  assertFundsAvailable(context: PaymentContext, senderWallet: Wallet): void;

  /**
   * Moves the money, writes the ledger and marks the transaction SUCCESS, atomically.
   * Returns the settled transaction. Throws a DomainError if the payment cannot complete.
   */
  pay(context: PaymentContext): Promise<Transaction>;

  /** Sends the money back and marks the transaction REFUNDED. Returns the settled transaction. */
  reverse(context: PaymentContext): Promise<Transaction>;
}

/**
 * PATTERN: Factory (registry flavour). Maps a payment source type to the strategy that
 * handles it. Callers ask for "the strategy for this source" and never use `new` or `switch`.
 */
export class PaymentStrategyFactory {
  readonly #strategies = new Map<PaymentSourceType, PaymentStrategy>();

  register(strategy: PaymentStrategy): this {
    this.#strategies.set(strategy.sourceType, strategy);
    return this;
  }

  for(sourceType: PaymentSourceType): PaymentStrategy {
    const strategy = this.#strategies.get(sourceType);
    if (!strategy) {
      throw new ValidationError('UNSUPPORTED_PAYMENT_METHOD', `Payments from ${sourceType} are not supported.`);
    }
    return strategy;
  }

  supportedTypes(): PaymentSourceType[] {
    return [...this.#strategies.keys()];
  }
}
