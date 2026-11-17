import type { Express } from 'express';
import { createHttpApp } from './api/createHttpApp';
import type { AppConfig, AppSettings } from './config/AppConfig';
import { GatewayUnavailableError } from './domain/errors';
import { Money } from './domain/Money';
import { setTimeout as sleep } from 'node:timers/promises';
import { PaymentSourceType, TransactionStatus } from './domain/enums';
import { LifecycleTraceObserver, MetricsObserver, TransactionEventPublisher } from './events/TransactionEvents';
import { InMemoryCache } from './infrastructure/cache/Cache';
import { ChaosController } from './infrastructure/chaos/ChaosController';
import { openDatabases } from './infrastructure/db/Database';
import { ReadRouter, ReplicationStream } from './infrastructure/db/Replication';
import { LoadBalancer, RoundRobinStrategy } from './infrastructure/loadbalancer/LoadBalancer';
import { InMemoryLockManager } from './infrastructure/lock/LockManager';
import { MetricsRegistry } from './infrastructure/observability/MetricsRegistry';
import { tracer } from './infrastructure/observability/Tracer';
import { InMemoryMessageQueue } from './infrastructure/queue/MessageQueue';
import { TokenBucketRateLimiter } from './infrastructure/ratelimit/RateLimiter';
import { CircuitBreaker } from './infrastructure/resilience/CircuitBreaker';
import { OutboxRelay } from './events/Outbox';
import { FaultInjectingWalletRepository } from './infrastructure/chaos/FaultInjectingWalletRepository';
import { EmailChannel, NotificationChannelFactory, PushChannel, SmsChannel } from './notification/channels';
import { ReconciliationService } from './service/ReconciliationService';
import { SessionService } from './service/SessionService';
import { PartyResolver, TransactionJournal } from './service/TransactionJournal';
import { NotificationComposer, NotificationObserver, NotificationService } from './notification/NotificationService';
import { CircuitBreakerGateway, SimulatedGateway } from './payment/gateway/PaymentGateway';
import { PaymentStrategyFactory } from './payment/PaymentStrategy';
import { BankTransferStrategy, CardPaymentStrategy, WalletPaymentStrategy } from './payment/strategies';
import { CachingWalletRepository } from './repository/CachingWalletRepository';
import {
  SqlitePaymentSourceRepository,
  SqliteUserRepository,
  SqliteWalletRepository,
} from './repository/sqlite/AccountRepositories';
import {
  SqliteIdempotencyRepository,
  SqliteLedgerRepository,
  SqliteNotificationRepository,
  SqliteScheduledPaymentRepository,
} from './repository/sqlite/SupportRepositories';
import {
  SqliteTransactionEventRepository,
  SqliteTransactionQueryRepository,
  SqliteTransactionRepository,
} from './repository/sqlite/TransactionRepositories';
import { DemoSeeder } from './service/DemoSeeder';
import { IdempotencyService } from './service/IdempotencyService';
import { LedgerService } from './service/LedgerService';
import { COMPENSATIONS_TOPIC, CompensationObserver, RefundService } from './service/RefundService';
import { PaymentScheduler, ScheduledPaymentService } from './service/ScheduledPaymentService';
import { SystemService } from './service/SystemService';
import { TransactionQueryService } from './service/TransactionQueryService';
import { TransferService } from './service/TransferService';
import { UserService } from './service/UserService';
import { BlacklistedPayeeRule, FraudEngine, HighValueNewPayeeRule, VelocityRule } from './validation/fraud';
import {
  DailyLimitHandler,
  FraudCheckHandler,
  PartyStatusHandler,
  PaymentSourceHandler,
  SufficientFundsHandler,
} from './validation/handlers';
import { ValidationPipeline } from './validation/ValidationHandler';

/** Everything the outside world (HTTP layer, tests, main) may touch. */
export interface Application {
  settings: Readonly<AppSettings>;
  http: Express;
  users: UserService;
  sessions: SessionService;
  transfers: TransferService;
  refunds: RefundService;
  queries: TransactionQueryService;
  scheduled: ScheduledPaymentService;
  notifications: NotificationService;
  ledger: LedgerService;
  system: SystemService;
  readRouter: ReadRouter;
  chaos: ChaosController;
  /** Waits until queued notifications are delivered and the replica has caught up. */
  settle(): Promise<void>;
  /** Wipes all data and loads the demo data again. */
  resetDemo(): Promise<void>;
  startBackgroundJobs(): void;
  shutdown(): void;
}

/**
 * COMPOSITION ROOT. The place where concrete classes are chosen and wired together
 * (the HTTP layer builds its own controllers).
 *
 * Every class below receives its collaborators through its constructor and depends on
 * interfaces (Dependency Inversion). To run on Redis, Kafka and PostgreSQL instead of the
 * in-process stand-ins, this is the only file that changes.
 */
export async function createApplication(config: AppConfig): Promise<Application> {
  const settings = config.settings;

  // ---- Infrastructure ----------------------------------------------------------------
  const chaos = new ChaosController({
    gatewayLatencyMs: settings.gatewayLatencyMs,
    replicaLagMs: settings.replicaLagMs,
    databaseLatencyMs: settings.databaseLatencyMs,
  });
  const metrics = MetricsRegistry.getInstance();
  const { primary, replica } = openDatabases(settings.dataDir);
  const replication = new ReplicationStream(primary, replica, chaos);
  const readRouter = new ReadRouter(primary, replica);
  const cache = new InMemoryCache(settings.cacheTtlMs, settings.cacheMaxEntries);
  const queue = new InMemoryMessageQueue({
    concurrency: settings.queueConcurrency,
    maxAttempts: settings.queueMaxAttempts,
    backoffBaseMs: settings.queueBackoffBaseMs,
  });
  const locks = new InMemoryLockManager(settings.lockTimeoutMs);
  const rateLimiter = new TokenBucketRateLimiter(settings.rateLimitCapacity, settings.rateLimitRefillPerSecond);
  const addressRateLimiter = new TokenBucketRateLimiter(settings.ipRateLimitCapacity, settings.ipRateLimitRefillPerSecond);
  const loadBalancer = new LoadBalancer(settings.appNodeCount, new RoundRobinStrategy());

  // ---- Repositories (the wallet repository is decorated with a cache) ------------------
  const userRepository = new SqliteUserRepository(primary);
  // Decorators around the SQLite repository: always a cache; fault injection only when the
  // demo switch is on, so a production configuration never carries it.
  const cachedWallets = new CachingWalletRepository(new SqliteWalletRepository(primary), cache);
  const walletRepository = settings.faultInjection ? new FaultInjectingWalletRepository(cachedWallets, chaos) : cachedWallets;
  const sourceRepository = new SqlitePaymentSourceRepository(primary);
  const eventRepository = new SqliteTransactionEventRepository(primary);
  // Saves a transaction and its audit-trail rows in one unit of work.
  const transactionRepository = new SqliteTransactionRepository(primary, eventRepository);
  const transactionQueries = new SqliteTransactionQueryRepository();
  const ledgerRepository = new SqliteLedgerRepository(primary);
  const idempotencyRepository = new SqliteIdempotencyRepository(primary);
  const notificationRepository = new SqliteNotificationRepository(primary);
  const scheduledRepository = new SqliteScheduledPaymentRepository(primary);

  // ---- External gateways, each wrapped in a circuit breaker (Decorator) ------------------
  const isOutage = (error: unknown) => error instanceof GatewayUnavailableError;
  const openingBalance = Money.fromRupees(200_000);
  const bankSimulator = new SimulatedGateway('Bank network', () => chaos.gateway('bank'), openingBalance);
  const cardSimulator = new SimulatedGateway('Card network', () => chaos.gateway('card'), openingBalance);
  const bankGateway = new CircuitBreakerGateway(
    bankSimulator,
    new CircuitBreaker('Bank network', settings.breakerFailureThreshold, settings.breakerOpenMs, isOutage),
  );
  const cardGateway = new CircuitBreakerGateway(
    cardSimulator,
    new CircuitBreaker('Card network', settings.breakerFailureThreshold, settings.breakerOpenMs, isOutage),
  );

  // ---- Domain services -----------------------------------------------------------------
  const ledger = new LedgerService(ledgerRepository, walletRepository);
  const users = new UserService(userRepository, walletRepository, sourceRepository, primary, cache, settings);
  const idempotency = new IdempotencyService(idempotencyRepository, cache, {
    pollIntervalMs: settings.idempotencyPollIntervalMs,
    maxPolls: settings.idempotencyMaxPolls,
    cacheTtlMs: settings.idempotencyCacheTtlMs,
  });

  // Payment strategies (Strategy + Factory). A new payment method is one more register() call.
  const settlement = { unitOfWork: primary, wallets: walletRepository, transactions: transactionRepository, ledger };
  const strategies = new PaymentStrategyFactory()
    .register(new WalletPaymentStrategy(settlement))
    .register(new BankTransferStrategy(settlement, bankGateway))
    .register(new CardPaymentStrategy(settlement, cardGateway));

  // Validation pipeline (Chain of Responsibility). Order matters: cheapest checks first.
  const fraud = new FraudEngine([
    new BlacklistedPayeeRule(),
    new VelocityRule(transactionRepository, settings.fraudMaxTransfersPerMinute),
    new HighValueNewPayeeRule(transactionRepository, Money.fromRupees(settings.fraudNewPayeeThresholdRupees)),
  ]);
  const validation = new ValidationPipeline([
    new PartyStatusHandler(),
    new PaymentSourceHandler(),
    new SufficientFundsHandler(),
    new DailyLimitHandler(transactionRepository),
    new FraudCheckHandler(fraud),
  ]);

  // Observers (Observer). A new reaction to payments is one more subscribe() call.
  const notifications = new NotificationService(
    queue,
    // A new channel (say WhatsApp) is one more register() call.
    new NotificationChannelFactory()
      .register(new SmsChannel(chaos, settings.notificationLatencyMs))
      .register(new PushChannel(chaos, settings.notificationLatencyMs))
      .register(new EmailChannel(chaos, settings.notificationLatencyMs)),
    notificationRepository,
    new NotificationComposer(),
  );
  const events = new TransactionEventPublisher();
  events.subscribe(new LifecycleTraceObserver());
  events.subscribe(new NotificationObserver(notifications));
  events.subscribe(new MetricsObserver(metrics));
  events.subscribe(new CompensationObserver(queue));
  notifications.startWorkers();

  const databaseRoundTrip = async (): Promise<void> => {
    const ms = chaos.state.databaseLatencyMs;
    if (ms > 0) await sleep(ms);
  };

  // Outbox: state-change events are stored with the status, then relayed to the observers.
  const parties = new PartyResolver(users, sourceRepository, strategies);
  const outbox = new OutboxRelay(eventRepository, events, (transactionId) => {
    const transaction = transactionRepository.findById(transactionId);
    return transaction ? { transaction, parties: parties.of(transaction) } : undefined;
  });
  const journal = new TransactionJournal(transactionRepository, outbox, readRouter);

  const transfers = new TransferService(parties, journal, walletRepository, idempotency, locks, validation, databaseRoundTrip);
  const refunds = new RefundService(parties, journal, locks);
  const sessions = new SessionService(users, settings.sessionTtlMs, settings.sessionSecret || undefined);
  const reconciliation = new ReconciliationService(
    transactionRepository,
    parties,
    journal,
    outbox,
    idempotencyRepository,
    scheduledRepository,
    (source) =>
      source.type === PaymentSourceType.BANK_ACCOUNT ? bankGateway : source.type === PaymentSourceType.CARD ? cardGateway : undefined,
  );
  // Stuck compensations are retried from the queue: 1 s, 2 s, 4 s ... until the gateway answers.
  queue.subscribe<{ transactionId: string }>(
    COMPENSATIONS_TOPIC,
    (message) => refunds.releaseCapturedFunds(message.payload.transactionId),
    { maxAttempts: 6, backoffBaseMs: 1_000, concurrency: 1 },
  );
  const queries = new TransactionQueryService(transactionQueries, eventRepository, ledger, readRouter, sourceRepository);
  const scheduled = new ScheduledPaymentService(scheduledRepository, users, sourceRepository, transfers);
  const scheduler = new PaymentScheduler(scheduled, settings.schedulerIntervalMs);
  const seeder = new DemoSeeder(users, transfers, chaos);

  const system = new SystemService({
    loadBalancer,
    rateLimiter,
    addressRateLimiter,
    cache,
    queue,
    primary,
    replica,
    replication,
    readRouter,
    locks,
    idempotency,
    gateways: [bankGateway, cardGateway],
    chaos,
    metrics,
    transactions: transactionRepository,
    validation,
    fraud,
    strategies,
    events,
  });

  /**
   * Start-up recovery. The simulated gateways and the queue live in memory, so after a restart:
   *  - the gateways are told again about every charge we have on record, and
   *  - any payment left FAILED with captured funds gets its refund queued again.
   */
  const recover = (): void => {
    for (const txn of transactionRepository.findCaptured()) {
      const simulator = txn.sourceType === PaymentSourceType.CARD ? cardSimulator : bankSimulator;
      simulator.restore([
        {
          reference: txn.id,
          sourceId: txn.sourceId,
          amount: txn.amount,
          gatewayTransactionId: txn.gatewayReference ?? txn.id,
          refunded: txn.status === TransactionStatus.REFUNDED,
        },
      ]);
      if (txn.status === TransactionStatus.FAILED) queue.publish(COMPENSATIONS_TOPIC, { transactionId: txn.id });
    }
  };

  const settle = async (): Promise<void> => {
    await queue.drain();
    replication.flush();
  };

  const seed = async (): Promise<void> => {
    if (settings.seedDemoData && (await seeder.seedIfEmpty())) await settle();
  };

  const resetDemo = async (): Promise<void> => {
    queue.clear();
    replication.discardPending();
    primary.rebuild();
    replica.bootstrapFrom(primary);
    cache.clear();
    readRouter.clear();
    rateLimiter.reset();
    addressRateLimiter.reset();
    users.clearPinLocks();
    loadBalancer.healAll();
    bankSimulator.reset();
    cardSimulator.reset();
    system.resetBreakers();
    chaos.reset();
    metrics.reset();
    tracer.clear();
    await seed();
  };

  const application: Application = {
    settings,
    http: undefined as unknown as Express,
    users,
    sessions,
    transfers,
    refunds,
    queries,
    scheduled,
    notifications,
    ledger,
    system,
    readRouter,
    chaos,
    settle,
    resetDemo,
    startBackgroundJobs: () => scheduler.start(),
    shutdown: () => {
      scheduler.stop();
      replication.flush();
      primary.close();
      replica.close();
    },
  };
  application.http = createHttpApp(application, { loadBalancer, rateLimiter, addressRateLimiter, primary });

  recover();
  await reconciliation.run(); // close whatever a previous run left half-done, before serving anything
  await seed();
  return application;
}
