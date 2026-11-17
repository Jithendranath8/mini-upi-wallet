import { WalletStatus } from './enums';
import { BusinessRuleError, InsufficientBalanceError } from './errors';
import { Money } from './Money';

export interface WalletSnapshot {
  id: string;
  userId: string;
  balancePaise: number;
  version: number;
  status: WalletStatus;
  updatedAt: string;
}

/**
 * The stored-value account of a user.
 *
 * Encapsulation: the balance is private and can only change through debit() and credit(),
 * which enforce the invariants (never negative, never on a frozen wallet).
 * `version` supports optimistic locking in the repository.
 */
export class Wallet {
  #balance: Money;
  #version: number;
  #updatedAt: Date;

  constructor(
    readonly id: string,
    readonly userId: string,
    balance: Money,
    version: number,
    readonly status: WalletStatus,
    updatedAt: Date,
  ) {
    this.#balance = balance;
    this.#version = version;
    this.#updatedAt = updatedAt;
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get updatedAt(): Date {
    return this.#updatedAt;
  }

  hasSufficientBalance(amount: Money): boolean {
    return this.#balance.isAtLeast(amount);
  }

  debit(amount: Money): void {
    this.assertUsable();
    if (!this.hasSufficientBalance(amount)) {
      throw new InsufficientBalanceError(this.#balance.paise, amount.paise);
    }
    this.#balance = this.#balance.minus(amount);
    this.#updatedAt = new Date();
  }

  credit(amount: Money): void {
    this.assertUsable();
    this.#balance = this.#balance.plus(amount);
    this.#updatedAt = new Date();
  }

  /** Called by the repository after a successful versioned write. */
  markPersisted(): void {
    this.#version += 1;
  }

  toSnapshot(): WalletSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      balancePaise: this.#balance.paise,
      version: this.#version,
      status: this.status,
      updatedAt: this.#updatedAt.toISOString(),
    };
  }

  static fromSnapshot(s: WalletSnapshot): Wallet {
    return new Wallet(s.id, s.userId, Money.ofPaise(s.balancePaise), s.version, s.status, new Date(s.updatedAt));
  }

  private assertUsable(): void {
    if (this.status !== WalletStatus.ACTIVE) {
      throw new BusinessRuleError('WALLET_FROZEN', 'This wallet is frozen and cannot move money.', {
        walletId: this.id,
      });
    }
  }
}
