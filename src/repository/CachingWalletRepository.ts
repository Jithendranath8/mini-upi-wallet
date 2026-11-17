import { Wallet, type WalletSnapshot } from '../domain/Wallet';
import type { Cache } from '../infrastructure/cache/Cache';
import { tracer } from '../infrastructure/observability/Tracer';
import type { WalletRepository } from './interfaces';

/**
 * PATTERN: Decorator.
 *
 * Wraps any WalletRepository and adds cache-aside behaviour without the wrapped class or its
 * callers knowing. It is a WalletRepository itself, so it can be dropped in anywhere one is
 * expected (Liskov), and caching can be removed by simply not wrapping.
 *
 *   read   -> cache hit? return it : load from the database, then populate the cache
 *   write  -> write to the database, then invalidate the cached copy
 *
 * Balance-changing code paths use findByUserIdForUpdate(), which always bypasses the cache:
 * money decisions are never made on cached data.
 */
export class CachingWalletRepository implements WalletRepository {
  constructor(
    private readonly inner: WalletRepository,
    private readonly cache: Cache,
  ) {}

  static keyFor(userId: string): string {
    return `wallet:${userId}`;
  }

  insert(wallet: Wallet): void {
    this.inner.insert(wallet);
  }

  findByUserId(userId: string): Wallet | undefined {
    const key = CachingWalletRepository.keyFor(userId);
    const cached = this.cache.get<WalletSnapshot>(key);
    if (cached) {
      tracer.step('Cache', `HIT ${key}: balance served without touching the database`, 'ok');
      return Wallet.fromSnapshot(cached);
    }
    const wallet = this.inner.findByUserId(userId);
    if (wallet) {
      this.cache.set(key, wallet.toSnapshot());
      tracer.step('Cache', `MISS ${key}: loaded from the primary and cached`, 'warn');
    }
    return wallet;
  }

  findByUserIdForUpdate(userId: string): Wallet | undefined {
    return this.inner.findByUserIdForUpdate(userId);
  }

  save(wallet: Wallet): void {
    this.inner.save(wallet);
    const key = CachingWalletRepository.keyFor(wallet.userId);
    this.cache.delete(key);
    tracer.step('Cache', `Invalidated ${key} after the balance changed`);
  }

  findAll(): Wallet[] {
    return this.inner.findAll();
  }
}
