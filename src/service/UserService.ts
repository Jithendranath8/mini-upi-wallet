import { NotificationChannelType, UserStatus, WalletStatus } from '../domain/enums';
import { AuthenticationError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors';
import { Money } from '../domain/Money';
import { BankAccountSource, CardSource, type PaymentSource, WalletSource } from '../domain/PaymentSource';
import { PinHasher } from '../domain/PinHasher';
import { User } from '../domain/User';
import { Wallet } from '../domain/Wallet';
import type { Cache } from '../infrastructure/cache/Cache';
import type { UnitOfWork } from '../infrastructure/db/Database';
import { tracer } from '../infrastructure/observability/Tracer';
import type { PaymentSourceRepository, UserRepository, WalletRepository } from '../repository/interfaces';
import { type PartyView, toPartyView } from '../readmodel/views';
import { newId } from '../util/ids';

export interface RegisterUserInput {
  name: string;
  phone: string;
  pin: string;
  email?: string | null;
  /** Left part of the UPI ID. Derived from the name when omitted. */
  upiHandle?: string;
  dailyLimitRupees?: number;
  notificationChannels?: NotificationChannelType[];
  /** Internal (seeding) only: marks the account as reported for fraud. */
  blacklisted?: boolean;
}

export interface LinkBankAccountInput {
  bankName: string;
  accountNumber: string;
  ifsc: string;
}

export interface LinkCardInput {
  network: string;
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
}

const MAX_DAILY_LIMIT_RUPEES = 100_000;

/** Onboarding and account data: users, their wallet, and their linked payment sources. */
export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly wallets: WalletRepository,
    private readonly sources: PaymentSourceRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly cache: Cache,
    private readonly settings: {
      upiHandle: string;
      defaultDailyLimitRupees: number;
      pinMaxAttempts: number;
      pinLockMs: number;
    },
  ) {}

  /** Wrong-PIN counters per user. In production this lives in the shared store, not in one process. */
  readonly #pinFailures = new Map<string, { count: number; lockedUntil: number }>();

  /** Creates the user, their wallet and the wallet payment source together, or nothing at all. */
  register(input: RegisterUserInput): User {
    const name = input.name?.trim() ?? '';
    if (name.length < 2 || name.length > 50) {
      throw new ValidationError('INVALID_NAME', 'Name must be 2 to 50 characters.');
    }
    if (!/^[6-9]\d{9}$/.test(input.phone ?? '')) {
      throw new ValidationError('INVALID_PHONE', 'Phone must be a 10-digit Indian mobile number.');
    }
    if (!/^\d{4,6}$/.test(input.pin ?? '')) {
      throw new ValidationError('INVALID_PIN', 'UPI PIN must be 4 to 6 digits.');
    }
    const email = input.email?.trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ValidationError('INVALID_EMAIL', 'Email address is not valid.');
    }
    const dailyLimitRupees = input.dailyLimitRupees ?? this.settings.defaultDailyLimitRupees;
    if (!(dailyLimitRupees > 0) || dailyLimitRupees > MAX_DAILY_LIMIT_RUPEES) {
      throw new ValidationError('INVALID_DAILY_LIMIT', `Daily limit must be between ₹1 and ₹${MAX_DAILY_LIMIT_RUPEES}.`);
    }
    const handle = (input.upiHandle ?? name.toLowerCase().replace(/[^a-z0-9]/g, '')).toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(handle)) {
      throw new ValidationError('INVALID_UPI_HANDLE', 'UPI handle must be 3-30 characters: letters, digits, dot, dash or underscore.');
    }
    const upiId = `${handle}@${this.settings.upiHandle}`;

    if (this.users.findByUpiId(upiId)) {
      throw new ConflictError('UPI_ID_TAKEN', `${upiId} is already registered. Choose another handle.`);
    }
    if (this.users.findByPhone(input.phone)) {
      throw new ConflictError('PHONE_TAKEN', 'This phone number is already registered.');
    }

    const now = new Date();
    const { hash, salt } = PinHasher.hash(input.pin);
    const user = new User({
      id: newId('usr'),
      name,
      upiId,
      phone: input.phone,
      email,
      pinHash: hash,
      pinSalt: salt,
      status: UserStatus.ACTIVE,
      dailyLimit: Money.fromRupees(dailyLimitRupees),
      notificationChannels: input.notificationChannels ?? [NotificationChannelType.SMS, NotificationChannelType.PUSH],
      blacklisted: input.blacklisted ?? false,
      createdAt: now,
    });
    const wallet = new Wallet(newId('wal'), user.id, Money.zero(), 0, WalletStatus.ACTIVE, now);
    const walletSource = new WalletSource(newId('src'), user.id, wallet.id, now);

    this.unitOfWork.runInTransaction(() => {
      this.users.insert(user);
      this.wallets.insert(wallet);
      this.sources.insert(walletSource);
    });
    return user;
  }

  linkBankAccount(userId: string, input: LinkBankAccountInput): PaymentSource {
    this.require(userId);
    const bankName = input.bankName?.trim() ?? '';
    if (bankName.length < 2 || bankName.length > 40) {
      throw new ValidationError('INVALID_BANK_NAME', 'Bank name must be 2 to 40 characters.');
    }
    if (!/^\d{9,18}$/.test(input.accountNumber ?? '')) {
      throw new ValidationError('INVALID_ACCOUNT_NUMBER', 'Account number must be 9 to 18 digits.');
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(input.ifsc ?? '')) {
      throw new ValidationError('INVALID_IFSC', 'IFSC must look like HDFC0001234.');
    }
    // Only the last four digits are kept; the full number is never stored.
    const source = new BankAccountSource(
      newId('src'),
      userId,
      bankName,
      input.accountNumber.slice(-4),
      input.ifsc,
      new Date(),
    );
    this.sources.insert(source);
    return source;
  }

  linkCard(userId: string, input: LinkCardInput): PaymentSource {
    this.require(userId);
    const network = input.network?.trim() ?? '';
    if (!['Visa', 'Mastercard', 'RuPay'].includes(network)) {
      throw new ValidationError('INVALID_CARD_NETWORK', 'Card network must be Visa, Mastercard or RuPay.');
    }
    if (!/^\d{13,19}$/.test(input.cardNumber ?? '') || !passesLuhnCheck(input.cardNumber)) {
      throw new ValidationError('INVALID_CARD_NUMBER', 'Card number is not valid.');
    }
    if (!Number.isInteger(input.expiryMonth) || input.expiryMonth < 1 || input.expiryMonth > 12) {
      throw new ValidationError('INVALID_EXPIRY', 'Expiry month must be 1 to 12.');
    }
    if (!Number.isInteger(input.expiryYear) || input.expiryYear < 2000 || input.expiryYear > 2100) {
      throw new ValidationError('INVALID_EXPIRY', 'Expiry year must be a four-digit year.');
    }
    const now = new Date();
    const card = new CardSource(
      newId('src'),
      userId,
      network,
      input.cardNumber.slice(-4),
      input.expiryMonth,
      input.expiryYear,
      now,
    );
    card.assertUsable(now); // refuse to link a card that has already expired
    this.sources.insert(card);
    return card;
  }

  require(userId: string): User {
    const user = this.users.findById(userId);
    if (!user) throw new NotFoundError('USER_NOT_FOUND', `No user with id ${userId}.`);
    return user;
  }

  /** Identifies the caller. Stands in for verifying a session token. */
  authenticate(userId: string | undefined): User {
    const user = userId ? this.users.findById(userId) : undefined;
    if (!user) {
      throw new AuthenticationError('UNAUTHENTICATED', 'Sign in first: send a valid session token (or, in demo mode, an X-User-Id header).');
    }
    if (!user.isActive()) {
      throw new ForbiddenError('ACCOUNT_BLOCKED', 'This account is blocked.');
    }
    return user;
  }

  /**
   * Second factor for anything that moves money. A 4-digit PIN has only 10,000 values, so
   * guessing is stopped by counting failures: after `pinMaxAttempts` wrong PINs the account
   * refuses PIN entry for `pinLockMs`, even if the next guess would be right.
   */
  verifyPin(user: User, pin: unknown, purpose: 'payment' | 'sign-in' = 'payment'): void {
    // Sign-in is reachable by anyone who knows a UPI ID, so its failures are counted apart:
    // a stranger guessing at the sign-in page cannot lock the owner out of paying.
    const counter = `${purpose}:${user.id}`;
    const now = Date.now();
    const record = this.#pinFailures.get(counter);
    if (record && record.lockedUntil > now) {
      const seconds = Math.ceil((record.lockedUntil - now) / 1000);
      tracer.step('Auth', `PIN entry is locked for ${seconds} more seconds`, 'error');
      throw new AuthenticationError('PIN_LOCKED', `Too many wrong PIN attempts. Try again in ${seconds} seconds.`, {
        retryAfterSeconds: seconds,
      });
    }
    if (typeof pin !== 'string' || !user.verifyPin(pin)) {
      const count = (record && record.lockedUntil <= now && record.count >= this.settings.pinMaxAttempts ? 0 : record?.count ?? 0) + 1;
      const locked = count >= this.settings.pinMaxAttempts;
      this.#pinFailures.set(counter, { count, lockedUntil: locked ? now + this.settings.pinLockMs : 0 });
      tracer.step('Auth', `UPI PIN did not match (attempt ${count} of ${this.settings.pinMaxAttempts})`, 'error');
      throw new AuthenticationError('INVALID_PIN', 'Incorrect UPI PIN.', {
        attemptsLeft: Math.max(0, this.settings.pinMaxAttempts - count),
      });
    }
    this.#pinFailures.delete(counter);
    tracer.step('Auth', 'UPI PIN verified', 'ok');
  }

  /** Forgets wrong-PIN counters (used when the demo data is reset). */
  clearPinLocks(): void {
    this.#pinFailures.clear();
  }

  findByUpiId(upiId: string): User | undefined {
    return this.users.findByUpiId(upiId.trim().toLowerCase());
  }

  /**
   * "Who is alice@miniupi?" Asked every time someone types a payee, so it is cached
   * (explicit cache-aside). Only public profile fields are cached, never credentials.
   */
  resolveUpiId(upiId: string): PartyView {
    const normalised = upiId.trim().toLowerCase();
    const key = `upi:${normalised}`;
    const cached = this.cache.get<PartyView>(key);
    if (cached) {
      tracer.step('Cache', `HIT ${key}`, 'ok');
      return cached;
    }
    const user = this.users.findByUpiId(normalised);
    if (!user) throw new NotFoundError('UPI_ID_NOT_FOUND', `${normalised} is not registered.`);
    const view = toPartyView(user);
    this.cache.set(key, view);
    tracer.step('Cache', `MISS ${key}: loaded from the primary and cached`, 'warn');
    return view;
  }

  list(): User[] {
    return this.users.findAll();
  }

  sourcesOf(userId: string): PaymentSource[] {
    return this.sources.findByUserId(userId);
  }

  walletOf(userId: string): Wallet {
    const wallet = this.wallets.findByUserId(userId);
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `User ${userId} has no wallet.`);
    return wallet;
  }
}

/** Standard checksum used by all payment cards; catches typos before we ever call a network. */
function passesLuhnCheck(cardNumber: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = cardNumber.length - 1; i >= 0; i -= 1) {
    let digit = Number(cardNumber[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
