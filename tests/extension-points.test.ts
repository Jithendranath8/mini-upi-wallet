import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { statusFor } from '../src/api/httpStatus';
import { NotificationChannelType, PaymentSourceType, WalletStatus } from '../src/domain/enums';
import {
  AuthenticationError,
  BusinessRuleError,
  CircuitOpenError,
  ConflictError,
  DailyLimitExceededError,
  DomainError,
  ErrorCategory,
  ForbiddenError,
  FraudSuspectedError,
  GatewayUnavailableError,
  IdempotencyKeyReuseError,
  IllegalStateTransitionError,
  InsufficientBalanceError,
  LockTimeoutError,
  NotFoundError,
  OptimisticLockError,
  PaymentDeclinedError,
  RateLimitExceededError,
  RequestInProgressError,
  ServiceUnavailableError,
  ValidationError,
} from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import {
  BankAccountSource,
  CardSource,
  PaymentSource,
  PaymentSourceFactory,
  WalletSource,
} from '../src/domain/PaymentSource';
import type { User } from '../src/domain/User';
import { Wallet } from '../src/domain/Wallet';
import { ChaosController } from '../src/infrastructure/chaos/ChaosController';
import { FaultInjectingWalletRepository } from '../src/infrastructure/chaos/FaultInjectingWalletRepository';
import { CircuitBreaker } from '../src/infrastructure/resilience/CircuitBreaker';
import {
  EmailChannel,
  type NotificationChannel,
  NotificationChannelFactory,
  type OutboundMessage,
  PushChannel,
  SmsChannel,
} from '../src/notification/channels';
import { CircuitBreakerGateway, SimulatedGateway } from '../src/payment/gateway/PaymentGateway';
import type { WalletRepository } from '../src/repository/interfaces';

// ---------------------------------------------------------------------------------------------
describe('error categories: the domain says what kind of failure, never which HTTP status', () => {
  const examples: Array<[DomainError, ErrorCategory]> = [
    [new ValidationError('X', 'x'), ErrorCategory.INVALID_INPUT],
    [new AuthenticationError('X', 'x'), ErrorCategory.UNAUTHENTICATED],
    [new ForbiddenError('X', 'x'), ErrorCategory.FORBIDDEN],
    [new NotFoundError('X', 'x'), ErrorCategory.NOT_FOUND],
    [new ConflictError('X', 'x'), ErrorCategory.CONFLICT],
    [new BusinessRuleError('X', 'x'), ErrorCategory.RULE_VIOLATION],
    [new RateLimitExceededError(1_000), ErrorCategory.RATE_LIMITED],
    [new ServiceUnavailableError('X', 'x'), ErrorCategory.UNAVAILABLE],
    [new InsufficientBalanceError(1, 2), ErrorCategory.RULE_VIOLATION],
    [new DailyLimitExceededError(1, 2, 3), ErrorCategory.RULE_VIOLATION],
    [new FraudSuspectedError('rule', 'reason'), ErrorCategory.FORBIDDEN],
    [new IllegalStateTransitionError('SUCCESS', 'PROCESSING'), ErrorCategory.CONFLICT],
    [new OptimisticLockError('Wallet', 'wal_1'), ErrorCategory.CONFLICT],
    [new IdempotencyKeyReuseError('key'), ErrorCategory.RULE_VIOLATION],
    [new RequestInProgressError('key'), ErrorCategory.CONFLICT],
    [new LockTimeoutError('wallet:1', 10), ErrorCategory.UNAVAILABLE],
    [new PaymentDeclinedError('Bank network', 'insufficient funds'), ErrorCategory.DECLINED],
    [new GatewayUnavailableError('Bank network', 'down'), ErrorCategory.UNAVAILABLE],
    [new CircuitOpenError('Bank network', 5_000), ErrorCategory.UNAVAILABLE],
  ];

  for (const [error, category] of examples) {
    test(`${error.constructor.name} is ${category}`, () => {
      assert.equal(error.category, category);
      assert.equal(error.name, error.constructor.name);
      assert.ok(error instanceof DomainError);
      assert.ok(error instanceof Error);
      assert.equal('httpStatus' in error, false, 'no HTTP knowledge in the domain');
    });
  }

  test('no subclass contradicts its parent: fraud is a ForbiddenError, a decline is its own kind', () => {
    const fraud = new FraudSuspectedError('Blacklisted payee', 'reported for fraud');
    assert.ok(fraud instanceof ForbiddenError);
    assert.equal(fraud instanceof BusinessRuleError, false);
    assert.equal(fraud.code, 'FRAUD_SUSPECTED');
    assert.deepEqual(fraud.details, { rule: 'Blacklisted payee' });

    const declined = new PaymentDeclinedError('Card network', 'insufficient funds');
    assert.equal(declined instanceof BusinessRuleError, false);
    assert.equal(declined.code, 'PAYMENT_DECLINED');
    assert.deepEqual(declined.details, { gateway: 'Card network' });
  });

  test('the examples above cover every category a DomainError can have', () => {
    const covered = new Set(examples.map(([, category]) => category));
    for (const category of Object.values(ErrorCategory)) {
      if (category === ErrorCategory.INTERNAL) continue; // by definition not a DomainError
      assert.ok(covered.has(category), `no example for ${category}`);
    }
  });
});

describe('statusFor: the one table that turns a category into an HTTP status', () => {
  const expected: Record<ErrorCategory, number> = {
    [ErrorCategory.INVALID_INPUT]: 400,
    [ErrorCategory.UNAUTHENTICATED]: 401,
    [ErrorCategory.DECLINED]: 402,
    [ErrorCategory.FORBIDDEN]: 403,
    [ErrorCategory.NOT_FOUND]: 404,
    [ErrorCategory.CONFLICT]: 409,
    [ErrorCategory.RULE_VIOLATION]: 422,
    [ErrorCategory.RATE_LIMITED]: 429,
    [ErrorCategory.INTERNAL]: 500,
    [ErrorCategory.UNAVAILABLE]: 503,
  };

  for (const category of Object.values(ErrorCategory)) {
    test(`${category} -> ${expected[category]}`, () => {
      assert.equal(statusFor(category), expected[category]);
    });
  }

  test('every category has its own status, all of them error statuses', () => {
    const statuses = Object.values(ErrorCategory).map(statusFor);
    assert.equal(new Set(statuses).size, statuses.length);
    for (const status of statuses) assert.ok(status >= 400 && status <= 599);
    assert.equal(Object.keys(expected).length, Object.values(ErrorCategory).length, 'this test knows every category');
  });

  test('client mistakes are 4xx, our own and our dependencies\' faults are 5xx', () => {
    for (const category of [ErrorCategory.INTERNAL, ErrorCategory.UNAVAILABLE]) assert.ok(statusFor(category) >= 500);
    for (const category of Object.values(ErrorCategory)) {
      if (category !== ErrorCategory.INTERNAL && category !== ErrorCategory.UNAVAILABLE) assert.ok(statusFor(category) < 500, category);
    }
  });

  test('a category it has never heard of is treated as an internal error', () => {
    assert.equal(statusFor('SOMETHING_NEW' as ErrorCategory), 500);
    assert.equal(statusFor(undefined as unknown as ErrorCategory), 500);
  });
});

// ---------------------------------------------------------------------------------------------
describe('FaultInjectingWalletRepository', () => {
  /** A minimal in-memory wallet store that remembers what was saved. */
  class StoredWallets implements WalletRepository {
    readonly balances = new Map<string, number>();
    readonly saved: Array<[string, number]> = [];

    insert(wallet: Wallet): void {
      this.balances.set(wallet.userId, wallet.balance.paise);
    }
    findByUserId(userId: string): Wallet | undefined {
      const paise = this.balances.get(userId);
      return paise === undefined ? undefined : walletOf(userId, paise);
    }
    findByUserIdForUpdate(userId: string): Wallet | undefined {
      return this.findByUserId(userId);
    }
    save(wallet: Wallet): void {
      this.balances.set(wallet.userId, wallet.balance.paise);
      this.saved.push([wallet.userId, wallet.balance.paise]);
    }
    findAll(): Wallet[] {
      return [...this.balances.keys()].map((userId) => this.findByUserId(userId)!);
    }
  }

  const walletOf = (userId: string, paise: number) =>
    new Wallet(`wal_${userId}`, userId, Money.ofPaise(paise), 0, WalletStatus.ACTIVE, new Date());

  const setUp = () => {
    const inner = new StoredWallets();
    const chaos = new ChaosController({ gatewayLatencyMs: 0, replicaLagMs: 0 });
    const wallets = new FaultInjectingWalletRepository(inner, chaos);
    wallets.insert(walletOf('alice', 10_000));
    wallets.insert(walletOf('bob', 0));
    const credit = (userId: string, paise: number) => {
      const wallet = wallets.findByUserIdForUpdate(userId)!;
      wallet.credit(Money.ofPaise(paise));
      wallets.save(wallet);
    };
    const debit = (userId: string, paise: number) => {
      const wallet = wallets.findByUserIdForUpdate(userId)!;
      wallet.debit(Money.ofPaise(paise));
      wallets.save(wallet);
    };
    return { inner, chaos, wallets, credit, debit };
  };

  const creditFailed = (error: unknown) => {
    assert.ok(error instanceof BusinessRuleError);
    assert.equal(error.code, 'CREDIT_FAILED');
    assert.equal(error.category, ErrorCategory.RULE_VIOLATION);
    return true;
  };

  test('while the fault is not armed it is a transparent wrapper', () => {
    const { inner, wallets, credit, debit } = setUp();
    credit('bob', 500);
    debit('alice', 500);
    assert.deepEqual(inner.saved, [
      ['bob', 500],
      ['alice', 9_500],
    ]);
    assert.equal(wallets.findByUserId('bob')!.balance.paise, 500);
    assert.equal(wallets.findByUserId('nobody'), undefined);
    assert.deepEqual(
      wallets.findAll().map((wallet) => wallet.userId),
      ['alice', 'bob'],
    );
  });

  test('once armed, the next credit fails exactly once and is not stored', () => {
    const { inner, chaos, credit } = setUp();
    chaos.update({ failNextCredit: true });

    assert.throws(() => credit('bob', 500), creditFailed);
    assert.equal(inner.balances.get('bob'), 0, 'the failed credit never reached the store');
    assert.deepEqual(inner.saved, []);
    assert.equal(chaos.state.failNextCredit, false, 'the fault disarmed itself');

    credit('bob', 500);
    credit('bob', 250);
    assert.equal(inner.balances.get('bob'), 750, 'every later credit goes through');
  });

  test('a debit never trips the fault and leaves it armed for the next credit', () => {
    const { inner, chaos, credit, debit } = setUp();
    chaos.update({ failNextCredit: true });

    debit('alice', 4_000);
    debit('alice', 1_000);
    assert.equal(inner.balances.get('alice'), 5_000);
    assert.equal(chaos.state.failNextCredit, true);

    assert.throws(() => credit('bob', 5_000), creditFailed);
    assert.equal(chaos.state.failNextCredit, false);
  });

  test('saving a wallet whose balance did not change is not a credit', () => {
    const { chaos, wallets } = setUp();
    chaos.update({ failNextCredit: true });
    wallets.save(wallets.findByUserIdForUpdate('alice')!);
    assert.equal(chaos.state.failNextCredit, true);
  });

  test('in a wallet-to-wallet payment it is the credit that fails, after the debit was saved', () => {
    const { inner, chaos, credit, debit } = setUp();
    chaos.update({ failNextCredit: true });
    debit('alice', 3_000);
    assert.throws(() => credit('bob', 3_000), creditFailed);
    // The decorator only refuses the save; undoing the debit is the unit of work's job.
    assert.deepEqual(inner.saved, [['alice', 7_000]]);
  });

  test('arming twice still fails only one credit', () => {
    const { chaos, credit } = setUp();
    chaos.update({ failNextCredit: true });
    chaos.update({ failNextCredit: true });
    assert.throws(() => credit('bob', 1), creditFailed);
    assert.doesNotThrow(() => credit('bob', 1));
  });
});

// ---------------------------------------------------------------------------------------------
describe('PaymentSourceFactory is a registry', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');

  /** A made-up payment method the application has never heard of. */
  class GiftCardSource extends PaymentSource {
    readonly type = 'GIFT_CARD' as PaymentSourceType;

    constructor(id: string, userId: string, readonly code: string, created: Date) {
      super(id, userId, 'Gift card', created);
    }
    isExternal(): boolean {
      return true;
    }
    perTransactionLimit(): Money {
      return Money.fromRupees(2_000);
    }
    maskedIdentifier(): string {
      return `GC-${this.code.slice(-3)}`;
    }
    details(): Record<string, string | number> {
      return { code: this.code };
    }
  }

  test('the three built-in types are registered', () => {
    for (const type of [PaymentSourceType.WALLET, PaymentSourceType.BANK_ACCOUNT, PaymentSourceType.CARD]) {
      assert.ok(PaymentSourceFactory.supportedTypes().includes(type), type);
    }
    assert.ok(PaymentSourceFactory.create({ id: 's', userId: 'u', type: PaymentSourceType.WALLET, details: { walletId: 'w' }, createdAt }) instanceof WalletSource);
    assert.ok(
      PaymentSourceFactory.create({
        id: 's',
        userId: 'u',
        type: PaymentSourceType.BANK_ACCOUNT,
        details: { bankName: 'HDFC Bank', accountLast4: '6789', ifsc: 'HDFC0001234' },
        createdAt,
      }) instanceof BankAccountSource,
    );
    assert.ok(
      PaymentSourceFactory.create({
        id: 's',
        userId: 'u',
        type: PaymentSourceType.CARD,
        details: { network: 'Visa', last4: '1111', expiryMonth: 12, expiryYear: 2030 },
        createdAt,
      }) instanceof CardSource,
    );
  });

  test('an unknown type throws UNSUPPORTED_SOURCE_TYPE', () => {
    assert.throws(
      () => PaymentSourceFactory.create({ id: 's', userId: 'u', type: 'CRYPTO' as PaymentSourceType, details: {}, createdAt }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'UNSUPPORTED_SOURCE_TYPE');
        assert.match(error.message, /CRYPTO/);
        return true;
      },
    );
  });

  test('a new type is one register() call: the factory then rebuilds it from a stored record, untouched itself', () => {
    const type = 'GIFT_CARD' as PaymentSourceType;
    const record = { id: 'src_gc', userId: 'usr_1', type, details: { code: 'ABC-123-XYZ' }, createdAt };
    assert.throws(() => PaymentSourceFactory.create(record), ValidationError, 'unknown until registered');

    PaymentSourceFactory.register(type, ({ id, userId, details, createdAt: at }) => new GiftCardSource(id, userId, String(details.code), at));

    const source = PaymentSourceFactory.create(record);
    assert.ok(source instanceof GiftCardSource);
    assert.equal(source.describe(), 'Gift card GC-XYZ');
    assert.equal(source.ledgerAccountId(), 'EXTERNAL:src_gc');
    assert.equal(source.perTransactionLimit().paise, 200_000);
    assert.deepEqual(source.details(), record.details);
    assert.ok(PaymentSourceFactory.supportedTypes().includes(type));

    // The built-in types are unaffected.
    assert.ok(PaymentSourceFactory.create({ id: 's', userId: 'u', type: PaymentSourceType.WALLET, details: { walletId: 'w' }, createdAt }) instanceof WalletSource);
  });

  test('registering a type again replaces how it is rebuilt', () => {
    const type = 'VOUCHER' as PaymentSourceType;
    PaymentSourceFactory.register(type, ({ id, userId, createdAt: at }) => new GiftCardSource(id, userId, 'first', at));
    PaymentSourceFactory.register(type, ({ id, userId, createdAt: at }) => new GiftCardSource(id, userId, 'second', at));
    const source = PaymentSourceFactory.create({ id: 's', userId: 'u', type, details: {}, createdAt }) as GiftCardSource;
    assert.equal(source.code, 'second');
    assert.equal(PaymentSourceFactory.supportedTypes().filter((t) => t === type).length, 1);
  });
});

describe('NotificationChannelFactory is a registry', () => {
  const chaos = new ChaosController({ gatewayLatencyMs: 0, replicaLagMs: 0 });

  /** A made-up channel the application has never heard of. */
  class WhatsAppChannel implements NotificationChannel {
    readonly type = 'WHATSAPP' as NotificationChannelType;
    readonly sent: OutboundMessage[] = [];

    recipientFor(user: User): string {
      return `wa:${user.phone}`;
    }
    async send(message: OutboundMessage): Promise<string> {
      this.sent.push(message);
      return `WhatsApp to ${message.recipient}: ${message.body}`;
    }
  }

  test('an empty factory knows no channel', () => {
    const factory = new NotificationChannelFactory();
    assert.deepEqual(factory.supportedTypes(), []);
    assert.throws(
      () => factory.create(NotificationChannelType.SMS),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, 'UNSUPPORTED_CHANNEL');
        return true;
      },
    );
  });

  test('registered channels are handed back by type; register() chains', () => {
    const sms = new SmsChannel(chaos, 0);
    const push = new PushChannel(chaos, 0);
    const email = new EmailChannel(chaos, 0);
    const factory = new NotificationChannelFactory().register(sms).register(push).register(email);

    assert.equal(factory.create(NotificationChannelType.SMS), sms);
    assert.equal(factory.create(NotificationChannelType.PUSH), push);
    assert.equal(factory.create(NotificationChannelType.EMAIL), email);
    assert.deepEqual(factory.supportedTypes(), ['SMS', 'PUSH', 'EMAIL']);
  });

  test('a new channel is one register() call and works like the built-in ones', async () => {
    const whatsApp = new WhatsAppChannel();
    const factory = new NotificationChannelFactory().register(new SmsChannel(chaos, 0));
    assert.throws(() => factory.create(whatsApp.type), ValidationError, 'unknown until registered');

    factory.register(whatsApp);

    const channel = factory.create('WHATSAPP' as NotificationChannelType);
    assert.equal(channel, whatsApp);
    assert.deepEqual(factory.supportedTypes(), ['SMS', 'WHATSAPP']);
    const delivered = await channel.send({
      notificationId: 'ntf_1',
      userId: 'usr_1',
      transactionId: 'txn_1',
      channel: whatsApp.type,
      recipient: 'wa:9876543210',
      title: 'Money received',
      body: 'Alice sent you ₹10.00.',
    });
    assert.equal(delivered, 'WhatsApp to wa:9876543210: Alice sent you ₹10.00.');
    assert.equal(whatsApp.sent.length, 1);
  });

  test('registering a type again replaces the channel; factories do not share registrations', () => {
    const first = new SmsChannel(chaos, 0);
    const second = new SmsChannel(chaos, 0);
    const factory = new NotificationChannelFactory().register(first).register(second);
    assert.equal(factory.create(NotificationChannelType.SMS), second);
    assert.deepEqual(factory.supportedTypes(), ['SMS']);
    assert.deepEqual(new NotificationChannelFactory().supportedTypes(), []);
  });

  test('the built-in channels address and word their messages differently', async () => {
    const user = { phone: '9876543210', name: 'Asha Rao', email: 'asha@example.com' } as User;
    const message: OutboundMessage = {
      notificationId: 'ntf_1',
      userId: 'usr_1',
      transactionId: 'txn_1',
      channel: NotificationChannelType.SMS,
      recipient: 'x',
      title: 'Payment sent',
      body: 'Paid ₹10.00 to Bob.',
    };
    const [sms, push, email] = [new SmsChannel(chaos, 0), new PushChannel(chaos, 0), new EmailChannel(chaos, 0)];

    assert.equal(sms.recipientFor(user), '+91 ******3210', 'the phone number is masked');
    assert.equal(push.recipientFor(user), 'device of Asha Rao');
    assert.equal(email.recipientFor(user), 'asha@example.com');
    assert.equal(email.recipientFor({ ...user, email: null } as User), null, 'no address, no email');

    assert.equal(await sms.send({ ...message, recipient: '+91 ******3210' }), 'SMS to +91 ******3210: Paid ₹10.00 to Bob.');
    assert.equal(await push.send({ ...message, recipient: 'device of Asha Rao' }), 'Push to device of Asha Rao: Payment sent | Paid ₹10.00 to Bob.');
    assert.equal(
      await email.send({ ...message, recipient: 'asha@example.com' }),
      'Email to a***@example.com, subject "Payment sent": Paid ₹10.00 to Bob.',
      'the address is masked in what gets logged',
    );
    assert.ok((await sms.send({ ...message, body: 'x'.repeat(500) })).length <= 160, 'an SMS is cut to 160 characters');
  });

  test('a channel throws when its provider fails, so the queue can retry', async () => {
    const failing = new ChaosController({ gatewayLatencyMs: 0, replicaLagMs: 0 });
    failing.update({ notificationFailureRate: 1 });
    await assert.rejects(
      new SmsChannel(failing, 0).send({
        notificationId: 'n',
        userId: 'u',
        transactionId: 't',
        channel: NotificationChannelType.SMS,
        recipient: 'r',
        title: 't',
        body: 'b',
      }),
      /SMS provider timed out/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('PaymentGateway.statusOf: "what happened to the charge with this reference?"', () => {
  const healthy = { latencyMs: 0, failureRate: 0, down: false };
  const charge = { reference: 'txn_1', sourceId: 'src_1', amount: Money.fromRupees(300) };

  test('NOT_FOUND for a reference the gateway never saw', async () => {
    const gateway = new SimulatedGateway('Bank network', () => healthy, Money.fromRupees(1_000));
    assert.deepEqual(await gateway.statusOf('txn_never_charged'), { state: 'NOT_FOUND' });
  });

  test('CAPTURED after a charge, REFUNDED after its refund, each with the gateway transaction id', async () => {
    const gateway = new SimulatedGateway('Bank network', () => healthy, Money.fromRupees(1_000));
    const receipt = await gateway.charge(charge);
    assert.deepEqual(await gateway.statusOf('txn_1'), { state: 'CAPTURED', gatewayTransactionId: receipt.gatewayTransactionId });
    await gateway.refund('txn_1');
    assert.deepEqual(await gateway.statusOf('txn_1'), { state: 'REFUNDED', gatewayTransactionId: receipt.gatewayTransactionId });
  });

  test('a declined charge leaves nothing behind: NOT_FOUND', async () => {
    const gateway = new SimulatedGateway('Bank network', () => healthy, Money.fromRupees(100));
    await assert.rejects(gateway.charge(charge), PaymentDeclinedError);
    assert.deepEqual(await gateway.statusOf('txn_1'), { state: 'NOT_FOUND' });
  });

  test('asking moves no money and can be repeated', async () => {
    const gateway = new SimulatedGateway('Bank network', () => healthy, Money.fromRupees(1_000));
    await gateway.charge(charge);
    for (let i = 0; i < 3; i += 1) await gateway.statusOf('txn_1');
    assert.equal(gateway.balanceOf('src_1').paise, 70_000);
  });

  test('when the network is down the question fails with GatewayUnavailableError instead of a guess', async () => {
    const faults = { ...healthy };
    const gateway = new SimulatedGateway('Bank network', () => faults, Money.fromRupees(1_000));
    await gateway.charge(charge);
    faults.down = true;
    await assert.rejects(gateway.statusOf('txn_1'), GatewayUnavailableError);
  });

  test('a restored charge (after a restart) is known to the gateway again', async () => {
    const gateway = new SimulatedGateway('Bank network', () => healthy, Money.fromRupees(1_000));
    gateway.restore([{ ...charge, gatewayTransactionId: 'BANKNETWORK-000009', refunded: false }]);
    assert.deepEqual(await gateway.statusOf('txn_1'), { state: 'CAPTURED', gatewayTransactionId: 'BANKNETWORK-000009' });
  });

  test('through the circuit breaker: same answers, and outages count towards opening the circuit', async () => {
    const faults = { ...healthy };
    const inner = new SimulatedGateway('Bank network', () => faults, Money.fromRupees(1_000));
    const gateway = new CircuitBreakerGateway(
      inner,
      new CircuitBreaker('Bank network', 2, 60_000, (error) => error instanceof GatewayUnavailableError),
    );
    await gateway.charge(charge);
    assert.equal((await gateway.statusOf('txn_1')).state, 'CAPTURED');

    faults.down = true;
    await assert.rejects(gateway.statusOf('txn_1'), GatewayUnavailableError);
    await assert.rejects(gateway.statusOf('txn_1'), GatewayUnavailableError);
    assert.equal(gateway.breakerStats().state, 'OPEN');
    faults.down = false;
    await assert.rejects(gateway.statusOf('txn_1'), CircuitOpenError);
  });
});
