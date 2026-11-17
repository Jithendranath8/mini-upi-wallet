import { TransactionType } from '../domain/enums';
import { BusinessRuleError, DailyLimitExceededError, ForbiddenError, FraudSuspectedError } from '../domain/errors';
import type { TransferHistoryReader } from '../repository/interfaces';
import type { FraudEngine } from './fraud';
import { type ValidationContext, ValidationHandler } from './ValidationHandler';

/** Both parties must be allowed to transact, and you cannot pay yourself from your own wallet. */
export class PartyStatusHandler extends ValidationHandler {
  readonly name = 'Account status';

  protected check({ sender, receiver, source }: ValidationContext): void {
    if (!sender.isActive()) {
      throw new ForbiddenError('SENDER_BLOCKED', 'Your account is blocked and cannot send money.');
    }
    if (!receiver.isActive()) {
      throw new BusinessRuleError('RECEIVER_BLOCKED', 'The receiver cannot accept payments right now.');
    }
    if (sender.id === receiver.id && !source.isExternal()) {
      throw new BusinessRuleError('SELF_TRANSFER', 'You cannot pay yourself from your own wallet.');
    }
  }
}

/** The chosen source must be usable (e.g. card not expired) and within its own per-payment limit. */
export class PaymentSourceHandler extends ValidationHandler {
  readonly name = 'Payment source';

  protected check({ source, transaction, now }: ValidationContext): void {
    source.assertUsable(now);
    const limit = source.perTransactionLimit();
    if (transaction.amount.isGreaterThan(limit)) {
      throw new BusinessRuleError(
        'SOURCE_LIMIT_EXCEEDED',
        `${source.describe()} allows at most ${limit.format()} per payment.`,
        { limitPaise: limit.paise, requestedPaise: transaction.amount.paise },
      );
    }
  }
}

/** Delegates to the payment strategy: only it knows what "enough funds" means for its source. */
export class SufficientFundsHandler extends ValidationHandler {
  readonly name = 'Available funds';

  protected check(context: ValidationContext): void {
    context.strategy.assertFundsAvailable(context, context.senderWallet);
  }
}

/** Money sent to other people today, plus this payment, must stay within the user's daily limit. */
export class DailyLimitHandler extends ValidationHandler {
  readonly name = 'Daily limit';

  constructor(private readonly history: TransferHistoryReader) {
    super();
  }

  protected check({ sender, transaction, now }: ValidationContext): void {
    if (transaction.type !== TransactionType.P2P) return; // loading your own wallet is not a transfer
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const spent = this.history.sumOutgoingSince(sender.id, startOfDay, transaction.id);
    if (spent.plus(transaction.amount).isGreaterThan(sender.dailyLimit)) {
      throw new DailyLimitExceededError(sender.dailyLimit.paise, spent.paise, transaction.amount.paise);
    }
  }
}

/** Runs every fraud rule; the first one that objects blocks the payment. */
export class FraudCheckHandler extends ValidationHandler {
  readonly name = 'Fraud rules';

  constructor(private readonly engine: FraudEngine) {
    super();
  }

  protected check(context: ValidationContext): void {
    const suspicious = this.engine.assess(context).find((verdict) => verdict.suspicious);
    if (suspicious) throw new FraudSuspectedError(suspicious.rule, suspicious.reason);
  }
}
