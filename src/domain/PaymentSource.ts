import { PaymentSourceType } from './enums';
import { BusinessRuleError, ValidationError } from './errors';
import { Money } from './Money';

/**
 * Where the money for a payment comes from.
 *
 * Abstraction + inheritance: the rest of the system talks to PaymentSource and never
 * asks "is this a card?". Each subclass answers the polymorphic questions itself
 * (limit, masking, usability, which ledger account it maps to).
 */
export abstract class PaymentSource {
  abstract readonly type: PaymentSourceType;

  constructor(
    readonly id: string,
    readonly userId: string,
    readonly label: string,
    readonly createdAt: Date,
  ) {}

  /** True when the funds live outside our system (a bank or card network must be called). */
  abstract isExternal(): boolean;

  /** Largest single payment this source may fund. */
  abstract perTransactionLimit(): Money;

  /** Safe-to-display identifier. Full account/card numbers are never kept. */
  abstract maskedIdentifier(): string;

  /** Type-specific attributes, persisted as JSON (single-table inheritance). */
  abstract details(): Record<string, string | number>;

  /** Throws if the source cannot be used right now. Default: always usable. */
  assertUsable(_now: Date): void {}

  /** Account id used on the ledger for money leaving this source. */
  ledgerAccountId(): string {
    return `EXTERNAL:${this.id}`;
  }

  describe(): string {
    return `${this.label} ${this.maskedIdentifier()}`.trim();
  }
}

export class WalletSource extends PaymentSource {
  readonly type = PaymentSourceType.WALLET;

  constructor(id: string, userId: string, readonly walletId: string, createdAt: Date) {
    super(id, userId, 'Wallet balance', createdAt);
  }

  isExternal(): boolean {
    return false;
  }

  perTransactionLimit(): Money {
    return Money.fromRupees(100_000);
  }

  maskedIdentifier(): string {
    return '';
  }

  details(): Record<string, string | number> {
    return { walletId: this.walletId };
  }

  override ledgerAccountId(): string {
    return `WALLET:${this.walletId}`;
  }
}

export class BankAccountSource extends PaymentSource {
  readonly type = PaymentSourceType.BANK_ACCOUNT;

  constructor(
    id: string,
    userId: string,
    readonly bankName: string,
    readonly accountLast4: string,
    readonly ifsc: string,
    createdAt: Date,
  ) {
    super(id, userId, bankName, createdAt);
  }

  isExternal(): boolean {
    return true;
  }

  perTransactionLimit(): Money {
    return Money.fromRupees(100_000);
  }

  maskedIdentifier(): string {
    return `XXXX${this.accountLast4}`;
  }

  details(): Record<string, string | number> {
    return { bankName: this.bankName, accountLast4: this.accountLast4, ifsc: this.ifsc };
  }
}

export class CardSource extends PaymentSource {
  readonly type = PaymentSourceType.CARD;

  constructor(
    id: string,
    userId: string,
    readonly network: string,
    readonly last4: string,
    readonly expiryMonth: number,
    readonly expiryYear: number,
    createdAt: Date,
  ) {
    super(id, userId, `${network} card`, createdAt);
  }

  isExternal(): boolean {
    return true;
  }

  perTransactionLimit(): Money {
    return Money.fromRupees(50_000);
  }

  maskedIdentifier(): string {
    return `•••• ${this.last4}`;
  }

  details(): Record<string, string | number> {
    return {
      network: this.network,
      last4: this.last4,
      expiryMonth: this.expiryMonth,
      expiryYear: this.expiryYear,
    };
  }

  isExpired(now: Date): boolean {
    // A card is valid through the last day of its expiry month.
    const firstInvalidMoment = new Date(this.expiryYear, this.expiryMonth, 1);
    return now >= firstInvalidMoment;
  }

  override assertUsable(now: Date): void {
    if (this.isExpired(now)) {
      throw new BusinessRuleError('CARD_EXPIRED', 'This card has expired. Link a new card or pick another source.', {
        sourceId: this.id,
      });
    }
  }
}

export interface PaymentSourceRecord {
  id: string;
  userId: string;
  type: PaymentSourceType;
  details: Record<string, string | number>;
  createdAt: Date;
}

type PaymentSourceCreator = (record: PaymentSourceRecord) => PaymentSource;

/**
 * PATTERN: Factory (as a registry).
 *
 * Turns a stored (type, details) record back into the right PaymentSource subclass. The
 * factory holds no knowledge of the subclasses: each one registers how it is rebuilt (see
 * the bottom of this file). A new source type is a new subclass plus its own `register`
 * call; this class is never edited.
 */
export class PaymentSourceFactory {
  static readonly #creators = new Map<PaymentSourceType, PaymentSourceCreator>();

  static register(type: PaymentSourceType, creator: PaymentSourceCreator): void {
    PaymentSourceFactory.#creators.set(type, creator);
  }

  static create(record: PaymentSourceRecord): PaymentSource {
    const creator = PaymentSourceFactory.#creators.get(record.type);
    if (!creator) {
      throw new ValidationError('UNSUPPORTED_SOURCE_TYPE', `Unsupported payment source type: ${String(record.type)}`);
    }
    return creator(record);
  }

  static supportedTypes(): PaymentSourceType[] {
    return [...PaymentSourceFactory.#creators.keys()];
  }
}

PaymentSourceFactory.register(
  PaymentSourceType.WALLET,
  ({ id, userId, details, createdAt }) => new WalletSource(id, userId, String(details.walletId), createdAt),
);
PaymentSourceFactory.register(
  PaymentSourceType.BANK_ACCOUNT,
  ({ id, userId, details, createdAt }) =>
    new BankAccountSource(id, userId, String(details.bankName), String(details.accountLast4), String(details.ifsc), createdAt),
);
PaymentSourceFactory.register(
  PaymentSourceType.CARD,
  ({ id, userId, details, createdAt }) =>
    new CardSource(
      id,
      userId,
      String(details.network),
      String(details.last4),
      Number(details.expiryMonth),
      Number(details.expiryYear),
      createdAt,
    ),
);
