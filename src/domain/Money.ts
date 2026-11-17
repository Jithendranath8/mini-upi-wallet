import { ValidationError } from './errors';

/**
 * Value object for an amount of rupees.
 * Stored as an integer number of paise so arithmetic never touches floating point.
 * Immutable: every operation returns a new Money.
 */
export class Money {
  private constructor(readonly paise: number) {}

  static ofPaise(paise: number): Money {
    if (!Number.isSafeInteger(paise) || paise < 0) {
      throw new ValidationError('INVALID_AMOUNT', 'Amount must be a non-negative whole number of paise.', { paise });
    }
    return new Money(paise);
  }

  static fromRupees(rupees: number): Money {
    if (typeof rupees !== 'number' || !Number.isFinite(rupees) || rupees < 0) {
      throw new ValidationError('INVALID_AMOUNT', 'Amount must be a non-negative number.', { rupees });
    }
    // 10.005 or 10.000000001 must be rejected, not silently rounded to a different amount.
    if (Number(rupees.toFixed(2)) !== rupees) {
      throw new ValidationError('INVALID_AMOUNT', 'Amount can have at most 2 decimal places.', { rupees });
    }
    return Money.ofPaise(Math.round(rupees * 100));
  }

  static zero(): Money {
    return new Money(0);
  }

  plus(other: Money): Money {
    return Money.ofPaise(this.paise + other.paise);
  }

  /** Throws if the result would be negative - Money can never represent a debt. */
  minus(other: Money): Money {
    return Money.ofPaise(this.paise - other.paise);
  }

  isGreaterThan(other: Money): boolean {
    return this.paise > other.paise;
  }

  isAtLeast(other: Money): boolean {
    return this.paise >= other.paise;
  }

  isZero(): boolean {
    return this.paise === 0;
  }

  equals(other: Money): boolean {
    return this.paise === other.paise;
  }

  toRupees(): number {
    return this.paise / 100;
  }

  format(): string {
    return `₹${this.toRupees().toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
