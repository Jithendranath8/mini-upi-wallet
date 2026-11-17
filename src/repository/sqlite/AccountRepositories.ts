import { NotificationChannelType, PaymentSourceType, UserStatus, WalletStatus } from '../../domain/enums';
import { OptimisticLockError } from '../../domain/errors';
import { Money } from '../../domain/Money';
import { PaymentSource, PaymentSourceFactory, WalletSource } from '../../domain/PaymentSource';
import { User } from '../../domain/User';
import { Wallet } from '../../domain/Wallet';
import type { SqlWriter } from '../../infrastructure/db/Database';
import type { PaymentSourceRepository, UserRepository, WalletRepository } from '../interfaces';

interface UserRow {
  id: string;
  name: string;
  upi_id: string;
  phone: string;
  email: string | null;
  pin_hash: string;
  pin_salt: string;
  status: string;
  daily_limit_paise: number;
  notification_channels: string;
  is_blacklisted: number;
  created_at: string;
}

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: SqlWriter) {}

  insert(user: User): void {
    const p = user.toProps();
    this.db.run(
      `INSERT INTO users (id, name, upi_id, phone, email, pin_hash, pin_salt, status, daily_limit_paise,
                          notification_channels, is_blacklisted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.name,
      p.upiId,
      p.phone,
      p.email,
      p.pinHash,
      p.pinSalt,
      p.status,
      p.dailyLimit.paise,
      JSON.stringify(p.notificationChannels),
      p.blacklisted ? 1 : 0,
      p.createdAt.toISOString(),
    );
  }

  findById(id: string): User | undefined {
    return this.map(this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id));
  }

  findByUpiId(upiId: string): User | undefined {
    return this.map(this.db.get<UserRow>('SELECT * FROM users WHERE upi_id = ?', upiId));
  }

  findByPhone(phone: string): User | undefined {
    return this.map(this.db.get<UserRow>('SELECT * FROM users WHERE phone = ?', phone));
  }

  findAll(): User[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY created_at, id').map((row) => this.map(row)!);
  }

  private map(row: UserRow | undefined): User | undefined {
    if (!row) return undefined;
    return new User({
      id: row.id,
      name: row.name,
      upiId: row.upi_id,
      phone: row.phone,
      email: row.email,
      pinHash: row.pin_hash,
      pinSalt: row.pin_salt,
      status: row.status as UserStatus,
      dailyLimit: Money.ofPaise(row.daily_limit_paise),
      notificationChannels: JSON.parse(row.notification_channels) as NotificationChannelType[],
      blacklisted: row.is_blacklisted === 1,
      createdAt: new Date(row.created_at),
    });
  }
}

interface WalletRow {
  id: string;
  user_id: string;
  balance_paise: number;
  version: number;
  status: string;
  updated_at: string;
}

export class SqliteWalletRepository implements WalletRepository {
  constructor(private readonly db: SqlWriter) {}

  insert(wallet: Wallet): void {
    this.db.run(
      'INSERT INTO wallets (id, user_id, balance_paise, version, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      wallet.id,
      wallet.userId,
      wallet.balance.paise,
      wallet.version,
      wallet.status,
      wallet.updatedAt.toISOString(),
    );
  }

  findByUserId(userId: string): Wallet | undefined {
    return this.map(this.db.get<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', userId));
  }

  findByUserIdForUpdate(userId: string): Wallet | undefined {
    return this.findByUserId(userId);
  }

  /**
   * Optimistic locking: the UPDATE only matches if the row still has the version we read.
   * Zero rows changed means another writer got there first.
   */
  save(wallet: Wallet): void {
    const { changes } = this.db.run(
      `UPDATE wallets
          SET balance_paise = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`,
      wallet.balance.paise,
      wallet.updatedAt.toISOString(),
      wallet.id,
      wallet.version,
    );
    if (changes !== 1) throw new OptimisticLockError('Wallet', wallet.id);
    wallet.markPersisted();
  }

  findAll(): Wallet[] {
    return this.db.all<WalletRow>('SELECT * FROM wallets ORDER BY id').map((row) => this.map(row)!);
  }

  private map(row: WalletRow | undefined): Wallet | undefined {
    if (!row) return undefined;
    return new Wallet(
      row.id,
      row.user_id,
      Money.ofPaise(row.balance_paise),
      row.version,
      row.status as WalletStatus,
      new Date(row.updated_at),
    );
  }
}

export interface PaymentSourceRow {
  id: string;
  user_id: string;
  type: string;
  details: string;
  created_at: string;
}

export function mapPaymentSource(row: PaymentSourceRow): PaymentSource {
  return PaymentSourceFactory.create({
    id: row.id,
    userId: row.user_id,
    type: row.type as PaymentSourceType,
    details: JSON.parse(row.details) as Record<string, string | number>,
    createdAt: new Date(row.created_at),
  });
}

export class SqlitePaymentSourceRepository implements PaymentSourceRepository {
  constructor(private readonly db: SqlWriter) {}

  insert(source: PaymentSource): void {
    this.db.run(
      'INSERT INTO payment_sources (id, user_id, type, details, created_at) VALUES (?, ?, ?, ?, ?)',
      source.id,
      source.userId,
      source.type,
      JSON.stringify(source.details()),
      source.createdAt.toISOString(),
    );
  }

  findById(id: string): PaymentSource | undefined {
    const row = this.db.get<PaymentSourceRow>('SELECT * FROM payment_sources WHERE id = ?', id);
    return row ? mapPaymentSource(row) : undefined;
  }

  findByUserId(userId: string): PaymentSource[] {
    return this.db
      .all<PaymentSourceRow>('SELECT * FROM payment_sources WHERE user_id = ? ORDER BY created_at, rowid', userId)
      .map(mapPaymentSource);
  }

  findWalletSource(userId: string): WalletSource | undefined {
    const row = this.db.get<PaymentSourceRow>(
      'SELECT * FROM payment_sources WHERE user_id = ? AND type = ? LIMIT 1',
      userId,
      PaymentSourceType.WALLET,
    );
    return row ? (mapPaymentSource(row) as WalletSource) : undefined;
  }
}
