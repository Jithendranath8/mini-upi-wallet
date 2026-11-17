import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { NotificationChannelType } from '../src/domain/enums';
import {
  AuthenticationError,
  BusinessRuleError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../src/domain/errors';
import { BankAccountSource, CardSource, WalletSource } from '../src/domain/PaymentSource';
import type { LinkCardInput, RegisterUserInput } from '../src/service/UserService';
import {
  balanceOf,
  closeApp,
  createTestApp,
  freezeClock,
  fund,
  linkBank,
  linkCard,
  pay,
  PIN,
  primaryOf,
  registerUser,
  writerOf,
} from './helpers';

const fails = (type: new (...args: never[]) => DomainError, code: string) => (error: unknown) => {
  assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
};

describe('UserService: registration', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  const valid = (overrides: Partial<RegisterUserInput> = {}): RegisterUserInput => ({
    name: 'Asha Rao',
    upiHandle: `asha${Math.random().toString(36).slice(2, 10)}`,
    phone: `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
    pin: PIN,
    ...overrides,
  });

  test('creates the user together with an empty wallet and a wallet payment source', () => {
    const user = app.users.register(valid({ upiHandle: 'asha.rao', email: 'asha@example.com' }));

    assert.match(user.id, /^usr_[0-9a-f]{16}$/);
    assert.equal(user.upiId, 'asha.rao@miniupi');
    assert.equal(user.name, 'Asha Rao');
    assert.equal(user.email, 'asha@example.com');
    assert.equal(user.isActive(), true);
    assert.equal(user.blacklisted, false);
    assert.equal(user.dailyLimit.paise, 50_000 * 100, 'the configured default daily limit');
    assert.deepEqual([...user.notificationChannels], [NotificationChannelType.SMS, NotificationChannelType.PUSH]);

    const wallet = app.users.walletOf(user.id);
    assert.equal(wallet.userId, user.id);
    assert.equal(wallet.balance.paise, 0);
    assert.equal(wallet.version, 0);

    const sources = app.users.sourcesOf(user.id);
    assert.equal(sources.length, 1);
    assert.ok(sources[0] instanceof WalletSource);
    assert.equal((sources[0] as WalletSource).walletId, wallet.id);
  });

  test('the PIN is stored only as a salted hash and can be verified', () => {
    const user = app.users.register(valid({ pin: '482913' }));
    assert.equal(user.verifyPin('482913'), true);
    assert.equal(user.verifyPin('482914'), false);
    const row = primaryOf(app).get<{ pin_hash: string; pin_salt: string }>('SELECT pin_hash, pin_salt FROM users WHERE id = ?', user.id)!;
    assert.notEqual(row.pin_hash, '482913');
    assert.match(row.pin_hash, /^[0-9a-f]{64}$/);
    assert.ok(row.pin_salt.length >= 16);
  });

  test('derives the UPI handle from the name when none is given', () => {
    const user = app.users.register(valid({ name: 'Zubin Q. Mehta-Iyer', upiHandle: undefined }));
    assert.equal(user.upiId, 'zubinqmehtaiyer@miniupi');
  });

  test('normalises the handle to lower case and trims the name', () => {
    const user = app.users.register(valid({ name: '  Padded Name  ', upiHandle: 'MiXeD.Case_1' }));
    assert.equal(user.upiId, 'mixed.case_1@miniupi');
    assert.equal(user.name, 'Padded Name');
  });

  test('accepts a custom daily limit within range and custom channels', () => {
    const user = app.users.register(
      valid({ dailyLimitRupees: 100_000, notificationChannels: [NotificationChannelType.EMAIL], email: 'x@y.in' }),
    );
    assert.equal(user.dailyLimit.paise, 10_000_000);
    assert.deepEqual([...user.notificationChannels], ['EMAIL']);
    assert.equal(app.users.register(valid({ dailyLimitRupees: 1 })).dailyLimit.paise, 100);
  });

  const invalid: Array<[string, Partial<RegisterUserInput>, string]> = [
    ['a one-letter name', { name: 'A' }, 'INVALID_NAME'],
    ['an empty name', { name: '   ' }, 'INVALID_NAME'],
    ['a 51-character name', { name: 'n'.repeat(51) }, 'INVALID_NAME'],
    ['a missing name', { name: undefined as unknown as string }, 'INVALID_NAME'],
    ['a 9-digit phone', { phone: '987654321' }, 'INVALID_PHONE'],
    ['an 11-digit phone', { phone: '98765432101' }, 'INVALID_PHONE'],
    ['a phone starting with 5', { phone: '5876543210' }, 'INVALID_PHONE'],
    ['a phone with letters', { phone: '98765abcde' }, 'INVALID_PHONE'],
    ['a missing phone', { phone: undefined as unknown as string }, 'INVALID_PHONE'],
    ['a 3-digit PIN', { pin: '123' }, 'INVALID_PIN'],
    ['a 7-digit PIN', { pin: '1234567' }, 'INVALID_PIN'],
    ['a PIN with letters', { pin: '12ab' }, 'INVALID_PIN'],
    ['a missing PIN', { pin: undefined as unknown as string }, 'INVALID_PIN'],
    ['a malformed email', { email: 'not-an-email' }, 'INVALID_EMAIL'],
    ['an email with spaces', { email: 'a b@c.d' }, 'INVALID_EMAIL'],
    ['a zero daily limit', { dailyLimitRupees: 0 }, 'INVALID_DAILY_LIMIT'],
    ['a negative daily limit', { dailyLimitRupees: -5 }, 'INVALID_DAILY_LIMIT'],
    ['a daily limit above the cap', { dailyLimitRupees: 100_001 }, 'INVALID_DAILY_LIMIT'],
    ['a NaN daily limit', { dailyLimitRupees: Number.NaN }, 'INVALID_DAILY_LIMIT'],
    ['a 2-character handle', { upiHandle: 'ab' }, 'INVALID_UPI_HANDLE'],
    ['a 31-character handle', { upiHandle: 'h'.repeat(31) }, 'INVALID_UPI_HANDLE'],
    ['a handle with an @', { upiHandle: 'evil@bank' }, 'INVALID_UPI_HANDLE'],
    ['a handle with a space', { upiHandle: 'two words' }, 'INVALID_UPI_HANDLE'],
    ['a handle with SQL in it', { upiHandle: "x'; DROP--" }, 'INVALID_UPI_HANDLE'],
    ['a name that yields no usable handle', { name: '李小龙', upiHandle: undefined }, 'INVALID_UPI_HANDLE'],
  ];
  for (const [label, overrides, code] of invalid) {
    test(`rejects ${label} with ${code}`, () => {
      const before = app.users.list().length;
      assert.throws(() => app.users.register(valid(overrides)), fails(ValidationError, code));
      assert.equal(app.users.list().length, before, 'nothing was created');
    });
  }

  test('accepts the boundary values: 2 and 50 character names, 4 and 6 digit PINs, 3 and 30 character handles', () => {
    assert.equal(app.users.register(valid({ name: 'Al' })).name, 'Al');
    assert.equal(app.users.register(valid({ name: 'n'.repeat(50), upiHandle: `fifty${Date.now()}` })).name.length, 50);
    assert.equal(app.users.register(valid({ pin: '0000' })).verifyPin('0000'), true);
    assert.equal(app.users.register(valid({ pin: '999999' })).verifyPin('999999'), true);
    assert.equal(app.users.register(valid({ upiHandle: 'a-b' })).upiId, 'a-b@miniupi');
    assert.equal(app.users.register(valid({ upiHandle: 'z'.repeat(30) })).upiId, `${'z'.repeat(30)}@miniupi`);
  });

  test('a blank email is treated as no email', () => {
    assert.equal(app.users.register(valid({ email: '   ' })).email, null);
    assert.equal(app.users.register(valid({ email: null })).email, null);
  });

  test('a UPI ID can be registered only once, whatever its case', () => {
    app.users.register(valid({ upiHandle: 'taken.handle' }));
    assert.throws(() => app.users.register(valid({ upiHandle: 'taken.handle' })), fails(ConflictError, 'UPI_ID_TAKEN'));
    assert.throws(() => app.users.register(valid({ upiHandle: 'TAKEN.Handle' })), fails(ConflictError, 'UPI_ID_TAKEN'));
  });

  test('a phone number can be registered only once', () => {
    app.users.register(valid({ phone: '7000000001' }));
    assert.throws(() => app.users.register(valid({ phone: '7000000001' })), fails(ConflictError, 'PHONE_TAKEN'));
  });

  test('list returns every registered user, oldest first', () => {
    const first = app.users.register(valid());
    const second = app.users.register(valid());
    const ids = app.users.list().map((user) => user.id);
    assert.ok(ids.indexOf(first.id) >= 0);
    assert.ok(ids.indexOf(first.id) < ids.indexOf(second.id));
  });
});

describe('UserService: payment sources', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  test('linking a bank account keeps only the last four digits', () => {
    const user = registerUser(app);
    const source = app.users.linkBankAccount(user.id, { bankName: '  HDFC Bank ', accountNumber: '50100123456789', ifsc: 'HDFC0001234' });

    assert.ok(source instanceof BankAccountSource);
    assert.equal(source.userId, user.id);
    assert.equal(source.describe(), 'HDFC Bank XXXX6789');
    const stored = primaryOf(app).get<{ details: string }>('SELECT details FROM payment_sources WHERE id = ?', source.id)!;
    assert.equal(stored.details.includes('50100123456789'), false, 'the full account number is never stored');
    assert.deepEqual(JSON.parse(stored.details), { bankName: 'HDFC Bank', accountLast4: '6789', ifsc: 'HDFC0001234' });
    assert.deepEqual(
      app.users.sourcesOf(user.id).map((s) => s.type).sort(),
      ['BANK_ACCOUNT', 'WALLET'],
    );
  });

  const badBanks: Array<[string, { bankName: string; accountNumber: string; ifsc: string }, string]> = [
    ['a one-letter bank name', { bankName: 'H', accountNumber: '123456789', ifsc: 'HDFC0001234' }, 'INVALID_BANK_NAME'],
    ['a 41-character bank name', { bankName: 'B'.repeat(41), accountNumber: '123456789', ifsc: 'HDFC0001234' }, 'INVALID_BANK_NAME'],
    ['an 8-digit account number', { bankName: 'HDFC', accountNumber: '12345678', ifsc: 'HDFC0001234' }, 'INVALID_ACCOUNT_NUMBER'],
    ['a 19-digit account number', { bankName: 'HDFC', accountNumber: '1'.repeat(19), ifsc: 'HDFC0001234' }, 'INVALID_ACCOUNT_NUMBER'],
    ['an account number with letters', { bankName: 'HDFC', accountNumber: '12345678X', ifsc: 'HDFC0001234' }, 'INVALID_ACCOUNT_NUMBER'],
    ['a lower-case IFSC', { bankName: 'HDFC', accountNumber: '123456789', ifsc: 'hdfc0001234' }, 'INVALID_IFSC'],
    ['an IFSC without the zero', { bankName: 'HDFC', accountNumber: '123456789', ifsc: 'HDFC1001234' }, 'INVALID_IFSC'],
    ['a short IFSC', { bankName: 'HDFC', accountNumber: '123456789', ifsc: 'HDFC000123' }, 'INVALID_IFSC'],
  ];
  for (const [label, input, code] of badBanks) {
    test(`rejects ${label} with ${code}`, () => {
      const user = registerUser(app);
      assert.throws(() => app.users.linkBankAccount(user.id, input), fails(ValidationError, code));
      assert.equal(app.users.sourcesOf(user.id).length, 1);
    });
  }

  test('linking a card keeps only the last four digits and the expiry', () => {
    const user = registerUser(app);
    const year = new Date().getFullYear() + 2;
    const source = app.users.linkCard(user.id, { network: 'Mastercard', cardNumber: '5555555555554444', expiryMonth: 3, expiryYear: year });

    assert.ok(source instanceof CardSource);
    assert.equal(source.describe(), 'Mastercard card •••• 4444');
    const stored = primaryOf(app).get<{ details: string }>('SELECT details FROM payment_sources WHERE id = ?', source.id)!;
    assert.equal(stored.details.includes('5555555555554444'), false, 'the full card number is never stored');
    assert.deepEqual(JSON.parse(stored.details), { network: 'Mastercard', last4: '4444', expiryMonth: 3, expiryYear: year });
  });

  const nextYear = new Date().getFullYear() + 1;
  const card = (overrides: Partial<LinkCardInput>): LinkCardInput => ({
    network: 'Visa',
    cardNumber: '4111111111111111',
    expiryMonth: 12,
    expiryYear: nextYear,
    ...overrides,
  });
  const badCards: Array<[string, LinkCardInput, string]> = [
    ['an unknown network', card({ network: 'Amex' }), 'INVALID_CARD_NETWORK'],
    ['a number that fails the Luhn check', card({ cardNumber: '4111111111111112' }), 'INVALID_CARD_NUMBER'],
    ['a 12-digit number', card({ cardNumber: '411111111111' }), 'INVALID_CARD_NUMBER'],
    ['a number with spaces', card({ cardNumber: '4111 1111 1111 1111' }), 'INVALID_CARD_NUMBER'],
    ['month 0', card({ expiryMonth: 0 }), 'INVALID_EXPIRY'],
    ['month 13', card({ expiryMonth: 13 }), 'INVALID_EXPIRY'],
    ['a fractional month', card({ expiryMonth: 1.5 }), 'INVALID_EXPIRY'],
    ['a two-digit year', card({ expiryYear: 30 }), 'INVALID_EXPIRY'],
    ['a year beyond 2100', card({ expiryYear: 2101 }), 'INVALID_EXPIRY'],
  ];
  for (const [label, input, code] of badCards) {
    test(`rejects a card with ${label} (${code})`, () => {
      const user = registerUser(app);
      assert.throws(() => app.users.linkCard(user.id, input), fails(ValidationError, code));
      assert.equal(app.users.sourcesOf(user.id).length, 1);
    });
  }

  test('refuses to link a card that has already expired', () => {
    const user = registerUser(app);
    assert.throws(
      () => app.users.linkCard(user.id, card({ expiryMonth: 1, expiryYear: new Date().getFullYear() - 1 })),
      fails(BusinessRuleError, 'CARD_EXPIRED'),
    );
    assert.equal(app.users.sourcesOf(user.id).length, 1);
  });

  test('a card expiring this month can still be linked', () => {
    const user = registerUser(app);
    const now = new Date();
    const source = app.users.linkCard(user.id, card({ expiryMonth: now.getMonth() + 1, expiryYear: now.getFullYear() }));
    assert.ok(source instanceof CardSource);
  });

  test('sources cannot be linked to a user that does not exist', () => {
    assert.throws(
      () => app.users.linkBankAccount('usr_missing', { bankName: 'HDFC', accountNumber: '123456789', ifsc: 'HDFC0001234' }),
      fails(NotFoundError, 'USER_NOT_FOUND'),
    );
    assert.throws(() => app.users.linkCard('usr_missing', card({})), fails(NotFoundError, 'USER_NOT_FOUND'));
  });

  test('each user sees only their own sources', () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    linkBank(app, alice);
    linkCard(app, alice);
    assert.equal(app.users.sourcesOf(alice.id).length, 3);
    assert.equal(app.users.sourcesOf(bob.id).length, 1);
    for (const source of app.users.sourcesOf(alice.id)) assert.equal(source.userId, alice.id);
  });

  test('sources are listed in the order they were linked, even when linked in the same millisecond', (t) => {
    freezeClock(t); // every source below gets the identical created_at
    const user = registerUser(app);
    const card = linkCard(app, user);
    const firstBank = linkBank(app, user);
    const secondBank = linkBank(app, user);

    const listed = app.users.sourcesOf(user.id);
    assert.deepEqual(
      listed.map((source) => source.type),
      ['WALLET', 'CARD', 'BANK_ACCOUNT', 'BANK_ACCOUNT'],
    );
    assert.deepEqual(
      listed.slice(1).map((source) => source.id),
      [card.id, firstBank.id, secondBank.id],
    );
  });
});

describe('UserService: lookups, authentication and the cache', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp();
  });

  after(() => closeApp(app));

  test('require and walletOf throw NotFoundError for an unknown user', () => {
    assert.throws(() => app.users.require('usr_missing'), fails(NotFoundError, 'USER_NOT_FOUND'));
    assert.throws(() => app.users.walletOf('usr_missing'), fails(NotFoundError, 'WALLET_NOT_FOUND'));
  });

  test('authenticate identifies a known user and rejects everything else', () => {
    const user = registerUser(app);
    assert.equal(app.users.authenticate(user.id).id, user.id);
    for (const id of [undefined, '', 'usr_missing', user.upiId]) {
      assert.throws(() => app.users.authenticate(id), fails(AuthenticationError, 'UNAUTHENTICATED'));
    }
  });

  test('verifyPin accepts the right PIN and rejects wrong, missing or non-string PINs', () => {
    for (const pin of ['0000', '', undefined, null, 1234, ['1234'], { pin: PIN }]) {
      const user = registerUser(app); // a fresh user each time, so the lockout counter never interferes
      assert.doesNotThrow(() => app.users.verifyPin(user, PIN));
      assert.throws(() => app.users.verifyPin(user, pin), fails(AuthenticationError, 'INVALID_PIN'), `PIN ${JSON.stringify(pin)}`);
    }
  });

  test('authenticate refuses a blocked account with 403 ACCOUNT_BLOCKED', () => {
    const user = registerUser(app);
    writerOf(app).run(`UPDATE users SET status = 'BLOCKED' WHERE id = ?`, user.id);
    assert.throws(() => app.users.authenticate(user.id), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.equal(error.code, 'ACCOUNT_BLOCKED');
      assert.equal(error.category, 'FORBIDDEN');
      return true;
    });
  });

  test('findByUpiId ignores case and surrounding whitespace', () => {
    const user = registerUser(app);
    assert.equal(app.users.findByUpiId(`  ${user.upiId.toUpperCase()}  `)?.id, user.id);
    assert.equal(app.users.findByUpiId('nobody@miniupi'), undefined);
    assert.equal(app.users.findByUpiId(''), undefined);
  });

  test('resolveUpiId returns public profile fields only and is served from the cache the second time', () => {
    const user = registerUser(app);
    const before = app.system.snapshot().cache;

    const first = app.users.resolveUpiId(user.upiId);
    const second = app.users.resolveUpiId(` ${user.upiId.toUpperCase()} `);

    assert.deepEqual(first, { id: user.id, name: user.name, upiId: user.upiId });
    assert.deepEqual(second, first);
    const stats = app.system.snapshot().cache;
    assert.equal(stats.misses - before.misses, 1);
    assert.equal(stats.hits - before.hits, 1);
  });

  test('resolveUpiId throws NotFoundError for an unregistered UPI ID', () => {
    assert.throws(() => app.users.resolveUpiId('ghost@miniupi'), fails(NotFoundError, 'UPI_ID_NOT_FOUND'));
  });

  test('the wallet balance is cached for reads and invalidated by every balance change', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 500);

    const before = app.system.snapshot().cache;
    assert.equal(balanceOf(app, alice), 50_000); // miss: loads and caches
    assert.equal(balanceOf(app, alice), 50_000); // hit
    assert.equal(balanceOf(app, alice), 50_000); // hit
    const warmed = app.system.snapshot().cache;
    assert.equal(warmed.misses - before.misses, 1);
    assert.equal(warmed.hits - before.hits, 2);

    await pay(app, alice, bob, 120);
    assert.equal(balanceOf(app, alice), 38_000, 'the stale cached balance was invalidated by the payment');
    assert.equal(balanceOf(app, bob), 12_000);
    assert.ok(app.system.snapshot().cache.invalidations > warmed.invalidations);
  });

  test('a refused payment leaves the cached balance correct', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 100);
    assert.equal(balanceOf(app, alice), 10_000);
    const { result } = await pay(app, alice, bob, 500);
    assert.equal(result.transaction.status, 'FAILED');
    assert.equal(balanceOf(app, alice), 10_000);
    assert.equal(balanceOf(app, bob), 0);
  });
});

describe('UserService: PIN lockout', () => {
  let app: Application;

  before(async () => {
    app = await createTestApp({ pinMaxAttempts: 3, pinLockMs: 60_000 });
  });

  after(() => closeApp(app));

  const pinError = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
    assert.ok(error instanceof AuthenticationError, `expected AuthenticationError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.category, 'UNAUTHENTICATED');
    if (details) assert.deepEqual(error.details, details);
    return true;
  };

  test('each wrong PIN reports how many attempts are left', () => {
    const user = registerUser(app);
    assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN', { attemptsLeft: 2 }));
    assert.throws(() => app.users.verifyPin(user, '0001'), pinError('INVALID_PIN', { attemptsLeft: 1 }));
    assert.throws(() => app.users.verifyPin(user, '0002'), pinError('INVALID_PIN', { attemptsLeft: 0 }));
  });

  test('after pinMaxAttempts wrong PINs even the right PIN is refused with PIN_LOCKED', (t) => {
    const advance = freezeClock(t);
    const user = registerUser(app);
    for (let i = 0; i < 3; i += 1) assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN'));

    assert.throws(() => app.users.verifyPin(user, PIN), pinError('PIN_LOCKED', { retryAfterSeconds: 60 }));
    assert.throws(() => app.users.verifyPin(user, '0000'), pinError('PIN_LOCKED'));
    advance(59_001);
    assert.throws(() => app.users.verifyPin(user, PIN), pinError('PIN_LOCKED', { retryAfterSeconds: 1 }), 'still locked a second before the end');
  });

  test('the lock expires after pinLockMs and the right PIN works again', (t) => {
    const advance = freezeClock(t);
    const user = registerUser(app);
    for (let i = 0; i < 3; i += 1) assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN'));
    assert.throws(() => app.users.verifyPin(user, PIN), pinError('PIN_LOCKED'));

    advance(60_000);
    assert.doesNotThrow(() => app.users.verifyPin(user, PIN));
  });

  test('once a lock has expired the count starts again from one', (t) => {
    const advance = freezeClock(t);
    const user = registerUser(app);
    for (let i = 0; i < 3; i += 1) assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN'));
    advance(60_000);
    assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN', { attemptsLeft: 2 }));
    assert.doesNotThrow(() => app.users.verifyPin(user, PIN), 'one wrong PIN after the lock does not lock again');
  });

  test('a correct PIN resets the counter', () => {
    const user = registerUser(app);
    assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN', { attemptsLeft: 2 }));
    assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN', { attemptsLeft: 1 }));
    app.users.verifyPin(user, PIN);
    assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN', { attemptsLeft: 2 }));
    assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN', { attemptsLeft: 1 }));
    assert.doesNotThrow(() => app.users.verifyPin(user, PIN));
  });

  test("one user's wrong PINs never lock anyone else", () => {
    const attacker = registerUser(app);
    const bystander = registerUser(app);
    for (let i = 0; i < 3; i += 1) assert.throws(() => app.users.verifyPin(attacker, '0000'), pinError('INVALID_PIN'));
    assert.doesNotThrow(() => app.users.verifyPin(bystander, PIN));
  });

  test('clearPinLocks lifts every lock', () => {
    const user = registerUser(app);
    for (let i = 0; i < 3; i += 1) assert.throws(() => app.users.verifyPin(user, '0000'), pinError('INVALID_PIN'));
    app.users.clearPinLocks();
    assert.doesNotThrow(() => app.users.verifyPin(user, PIN));
  });
});
