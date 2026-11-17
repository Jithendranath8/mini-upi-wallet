import { BusinessRuleError } from '../../domain/errors';
import type { Wallet } from '../../domain/Wallet';
import type { WalletRepository } from '../../repository/interfaces';
import type { ChaosController } from './ChaosController';

/**
 * PATTERN: Decorator.
 *
 * Fault injection for demos and tests, kept entirely OUT of the business code: the payment
 * strategies know nothing about chaos. When "fail the next wallet credit" is armed, the next
 * save that would increase a wallet's balance fails once, exactly as a storage error would.
 * It is wired in only when the `faultInjection` setting is on (see `src/container.ts`).
 */
export class FaultInjectingWalletRepository implements WalletRepository {
  constructor(
    private readonly inner: WalletRepository,
    private readonly chaos: ChaosController,
  ) {}

  insert(wallet: Wallet): void {
    this.inner.insert(wallet);
  }

  findByUserId(userId: string): Wallet | undefined {
    return this.inner.findByUserId(userId);
  }

  findByUserIdForUpdate(userId: string): Wallet | undefined {
    return this.inner.findByUserIdForUpdate(userId);
  }

  save(wallet: Wallet): void {
    if (this.chaos.state.failNextCredit && this.isCredit(wallet) && this.chaos.consumeCreditFailure()) {
      throw new BusinessRuleError('CREDIT_FAILED', 'The receiver wallet could not be credited (injected fault).');
    }
    this.inner.save(wallet);
  }

  findAll(): Wallet[] {
    return this.inner.findAll();
  }

  private isCredit(wallet: Wallet): boolean {
    const stored = this.inner.findByUserIdForUpdate(wallet.userId);
    return stored !== undefined && wallet.balance.isGreaterThan(stored.balance);
  }
}
