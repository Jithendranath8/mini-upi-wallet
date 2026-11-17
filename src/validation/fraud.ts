import type { Money } from '../domain/Money';
import type { TransferHistoryReader } from '../repository/interfaces';
import type { ValidationContext } from './ValidationHandler';

export interface FraudVerdict {
  rule: string;
  suspicious: boolean;
  reason: string;
}

/**
 * PATTERN: Strategy. One fraud heuristic per class, all behind the same interface.
 * The engine runs whatever rules it was given; adding a rule never touches existing rules,
 * the engine, or the validation chain (Open/Closed).
 */
export interface FraudRule {
  readonly name: string;
  evaluate(context: ValidationContext): FraudVerdict;
}

export class FraudEngine {
  readonly #rules: FraudRule[];

  constructor(rules: FraudRule[]) {
    this.#rules = [...rules];
  }

  addRule(rule: FraudRule): void {
    this.#rules.push(rule);
  }

  assess(context: ValidationContext): FraudVerdict[] {
    return this.#rules.map((rule) => rule.evaluate(context));
  }

  ruleNames(): string[] {
    return this.#rules.map((rule) => rule.name);
  }
}

const clear = (rule: string): FraudVerdict => ({ rule, suspicious: false, reason: '' });

/** Never pay an account that has been reported for fraud. */
export class BlacklistedPayeeRule implements FraudRule {
  readonly name = 'Blacklisted payee';

  evaluate({ receiver }: ValidationContext): FraudVerdict {
    if (!receiver.blacklisted) return clear(this.name);
    return {
      rule: this.name,
      suspicious: true,
      reason: `${receiver.upiId} has been reported for fraud. This payment was blocked to protect you.`,
    };
  }
}

/** Many payments in a short time is the signature of a compromised account or a script. */
export class VelocityRule implements FraudRule {
  readonly name = 'Payment velocity';

  constructor(
    private readonly history: TransferHistoryReader,
    private readonly maxPerMinute: number,
  ) {}

  evaluate({ sender, transaction, now }: ValidationContext): FraudVerdict {
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const recent = this.history.countInitiatedSince(sender.id, oneMinuteAgo, transaction.id);
    if (recent < this.maxPerMinute) return clear(this.name);
    return {
      rule: this.name,
      suspicious: true,
      reason: `Too many payments in a short time (${recent} in the last minute). Wait a minute and try again.`,
    };
  }
}

/** A large first-ever payment to someone new is the classic scam pattern. */
export class HighValueNewPayeeRule implements FraudRule {
  readonly name = 'High value to new payee';

  constructor(
    private readonly history: TransferHistoryReader,
    private readonly threshold: Money,
  ) {}

  evaluate({ sender, receiver, transaction }: ValidationContext): FraudVerdict {
    const isLarge = transaction.amount.isAtLeast(this.threshold);
    if (!isLarge || sender.id === receiver.id || this.history.hasSuccessfulTransfer(sender.id, receiver.id)) {
      return clear(this.name);
    }
    return {
      rule: this.name,
      suspicious: true,
      reason: `First payment to ${receiver.upiId} must be below ${this.threshold.format()}. Send a smaller amount first.`,
    };
  }
}
