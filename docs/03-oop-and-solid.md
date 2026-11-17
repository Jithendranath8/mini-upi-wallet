# Object-oriented design and SOLID

This document answers two questions: where the four pillars of object-oriented design appear in the code, and how each SOLID principle is applied. Every example names a real class and file, and the code excerpts are copied from `src/`. It ends with one recorded design decision and the places where the prototype still bends a principle.

## The four pillars

### Abstraction

Callers work with what a thing does, not how it does it.

1. **`PaymentGateway`** (`src/payment/gateway/PaymentGateway.ts`) is the whole contract with a bank or card network. Strategies and start-up recovery charge, refund and ask about a charge through it, and never see the simulator, its balances or its fault settings.

   ```ts
   export interface PaymentGateway {
     readonly name: string;
     charge(request: ChargeRequest): Promise<ChargeReceipt>;
     refund(reference: string): Promise<void>;
     /**
      * "What happened to the charge with this reference?" The only safe way to resolve a call
      * whose outcome we never saw (a timeout, or a crash on our side).
      */
     statusOf(reference: string): Promise<ChargeStatus>;
   }
   ```

2. **`PaymentSource`** (`src/domain/PaymentSource.ts`) is an abstract class. The rest of the system asks a source questions and never checks which kind it is:

   ```ts
     /** True when the funds live outside our system (a bank or card network must be called). */
     abstract isExternal(): boolean;

     /** Largest single payment this source may fund. */
     abstract perTransactionLimit(): Money;

     /** Safe-to-display identifier. Full account/card numbers are never kept. */
     abstract maskedIdentifier(): string;
   ```

3. **Ports and categories.** `WalletRepository` in `src/repository/interfaces.ts` says "find, find for update, save" and hides SQL. `LockManager`, `Cache` and `MessageQueue` hide whether the lock, cache or queue is in-process or distributed. A `DomainError` says what kind of failure happened (`ErrorCategory`), not how to present it; `src/api/httpStatus.ts` decides that.

### Encapsulation

State that carries an invariant is private, and it changes only through methods that enforce the invariant. TypeScript `#` fields are private at run time, not just at compile time.

1. **`Wallet`** (`src/domain/Wallet.ts`) keeps `#balance` and `#version` private. The balance can change only through `debit()` and `credit()`, which refuse a frozen wallet and an overdraft:

   ```ts
     debit(amount: Money): void {
       this.assertUsable();
       if (!this.hasSufficientBalance(amount)) {
         throw new InsufficientBalanceError(this.#balance.paise, amount.paise);
       }
       this.#balance = this.#balance.minus(amount);
       this.#updatedAt = new Date();
     }
   ```

2. **`User`** (`src/domain/User.ts`) stores `#pinHash` and `#pinSalt`. Callers can ask whether a PIN is right but cannot read the hash; only `toProps()`, used by the persistence layer, returns it, and none of the views in `src/readmodel/views.ts` include it.

   ```ts
     verifyPin(pin: string): boolean {
       return PinHasher.verify(pin, this.#pinHash, this.#pinSalt);
     }
   ```

3. **`Transaction`** (`src/domain/Transaction.ts`) hides its status as a private `#state` object, plus `#version` and the queue of `#unrecordedTransitions`; the status changes only through `startProcessing()`, `succeed()`, `fail()` and `refund()`. **`Money`** has a private constructor, so every amount is created through `ofPaise()`, `fromRupees()` or `zero()` and passes their checks. **`LedgerEntry`** calls `Object.freeze(this)` in its constructor. **`SessionService`** keeps its signing secret in a private `#secret`.

### Inheritance

Inheritance is used where subclasses share state or behaviour, never just to reuse a helper.

1. **Payment sources.** `WalletSource`, `BankAccountSource` and `CardSource` extend `PaymentSource` and inherit `describe()`, `ledgerAccountId()` and a default `assertUsable()` that accepts. `CardSource` overrides only the rule that differs:

   ```ts
     override assertUsable(now: Date): void {
       if (this.isExpired(now)) {
         throw new BusinessRuleError('CARD_EXPIRED', 'This card has expired. Link a new card or pick another source.', {
           sourceId: this.id,
         });
       }
     }
   ```

2. **Error hierarchy** (`src/domain/errors.ts`). `DomainError` holds the shared `code`, `details` and `name`, and leaves `category` abstract. Nine direct subclasses each fix one category: `ValidationError` (`INVALID_INPUT`), `AuthenticationError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `BusinessRuleError` (`RULE_VIOLATION`), `RateLimitExceededError`, `ServiceUnavailableError` (`UNAVAILABLE`) and `PaymentDeclinedError` (`DECLINED`). Specific errors such as `InsufficientBalanceError`, `FraudSuspectedError` (a `ForbiddenError`) and `LockTimeoutError` extend those and keep their parent's category.

   ```ts
   export abstract class DomainError extends Error {
     abstract readonly category: ErrorCategory;

     constructor(
       readonly code: string,
       message: string,
       readonly details?: Record<string, unknown>,
     ) {
       super(message);
       this.name = new.target.name;
     }
   }
   ```

3. **Payment strategies** (`src/payment/strategies.ts`). `BasePaymentStrategy` supplies `walletOf()` and `reload()`; `ExternalPaymentStrategy` adds the bank and card skeleton; `CardPaymentStrategy` adds one step:

   ```ts
   export class CardPaymentStrategy extends ExternalPaymentStrategy {
     readonly sourceType = PaymentSourceType.CARD;

     protected override authorise({ source }: PaymentContext): void {
       tracer.step('Gateway', `3-D Secure check passed for ${source.describe()} (simulated)`, 'ok');
     }
   }
   ```

### Polymorphism

One call site, many behaviours, chosen at run time by the object's class.

1. **Sources.** `PaymentSourceHandler` (`src/validation/handlers.ts`) checks any source the same way; a card may throw `CARD_EXPIRED`, and the limit is ₹1,00,000 or ₹50,000 depending on the subclass:

   ```ts
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
   ```

2. **Strategies.** `TransferService` asks `this.parties.strategyFor(source)` and then calls `strategy.pay(...)`; `RefundService` calls `strategy.reverse(...)`. Neither has a branch per payment method.

3. **Observers and errors.** `TransactionEventPublisher.publish` calls `observer.onTransactionEvent(event)` on whatever is subscribed. `errorHandler` in `src/api/middleware.ts` answers `res.status(statusFor(error.category))` for any `DomainError`, whatever its subclass.

## Interfaces and abstract classes

The rule in this code base: an **abstract class** where implementations share state or a fixed algorithm; an **interface** where only the contract is shared, where implementations live in unrelated modules, or where a decorator must be able to wrap any implementation.

| Name | Kind | File | Implementations | Why this kind |
|---|---|---|---|---|
| `PaymentStrategy` | Interface | `src/payment/PaymentStrategy.ts` | `WalletPaymentStrategy`, `BankTransferStrategy`, `CardPaymentStrategy` (through `BasePaymentStrategy`) | The factory and services need only the contract; shared code sits in an abstract base behind it. |
| `PaymentGateway` | Interface | `src/payment/gateway/PaymentGateway.ts` | `SimulatedGateway`, `CircuitBreakerGateway` | Port to an external system; the decorator must wrap any implementation. |
| `FraudRule` | Interface | `src/validation/fraud.ts` | `BlacklistedPayeeRule`, `VelocityRule`, `HighValueNewPayeeRule` | Rules share no code or state. |
| `NotificationChannel` | Interface | `src/notification/channels.ts` | `SmsChannel`, `PushChannel`, `EmailChannel` (through `SimulatedChannel`) | A real provider adapter would share nothing with the simulated base. |
| `TransactionObserver` | Interface | `src/events/TransactionEvents.ts` | `LifecycleTraceObserver`, `MetricsObserver` (same file), `NotificationObserver` (`src/notification/NotificationService.ts`), `CompensationObserver` (`src/service/RefundService.ts`) | Observers are unrelated classes in different modules. |
| `LoadBalancingStrategy` | Interface | `src/infrastructure/loadbalancer/LoadBalancer.ts` | `RoundRobinStrategy` | One method, nothing to share. |
| `Cache`, `MessageQueue`, `LockManager`, `RateLimiter` | Interfaces | `src/infrastructure/cache/`, `queue/`, `lock/`, `ratelimit/` | `InMemoryCache`, `InMemoryMessageQueue`, `InMemoryLockManager`, `TokenBucketRateLimiter` | Ports: a Redis or Kafka adapter would share no code with the in-memory one. |
| `SqlReader`, `SqlWriter`, `UnitOfWork` | Interfaces | `src/infrastructure/db/Database.ts` | `SqliteNode` (reader), `PrimaryDatabase` (all three), `ReplicaDatabase` (reader) | Capabilities, not a type tree: the replica must have only one of them. |
| Eleven repository ports | Interfaces | `src/repository/interfaces.ts` | One `Sqlite*Repository` each (`TransferHistoryReader` through `SqliteTransactionRepository`); `WalletRepository` also has `CachingWalletRepository` and `FaultInjectingWalletRepository` | Boundary between services and storage; the decorators need an interface to implement. |
| `PaymentSource` | Abstract class | `src/domain/PaymentSource.ts` | `WalletSource`, `BankAccountSource`, `CardSource` | Shared fields (`id`, `userId`, `label`, `createdAt`) and default methods. |
| `TransactionState` | Abstract class | `src/domain/TransactionState.ts` | Five state classes | Default "reject" for every transition and the `reject()` helper. |
| `ValidationHandler` | Abstract class | `src/validation/ValidationHandler.ts` | Five handlers | Holds the `#next` link and the `handle()` template method. |
| `BasePaymentStrategy` | Abstract class | `src/payment/strategies.ts` | `WalletPaymentStrategy`, `ExternalPaymentStrategy` | Shared `SettlementDependencies` and helpers. |
| `ExternalPaymentStrategy` | Abstract class | `src/payment/strategies.ts` | `BankTransferStrategy`, `CardPaymentStrategy` | Template method `pay()` with the saga step. |
| `SimulatedChannel` | Abstract class | `src/notification/channels.ts` | `SmsChannel`, `PushChannel`, `EmailChannel` | Template method `send()`: latency, fault injection, then `render()`. |
| `SqliteNode` | Abstract class | `src/infrastructure/db/Database.ts` | `PrimaryDatabase`, `ReplicaDatabase` | Connection, migrations, statement cache and read methods. |
| `DomainError` | Abstract class | `src/domain/errors.ts` | Nine direct subclasses and their children | Shared `code` and `details`; abstract `category`. |

Data-only interfaces such as `PaymentContext`, `ValidationContext`, `TransactionEvent`, `TransactionParties`, `StateTransition`, `OutboxEvent`, `Notification`, `OutboundMessage`, `ChargeStatus` and the DTOs in `src/readmodel/views.ts` describe shapes, not behaviour, so they have no implementations to list.

## SOLID

### Single Responsibility

| Where | What it buys | What the violation would look like |
|---|---|---|
| `TransferService` (`src/service/TransferService.ts`) owns only the order of the steps. Its seven constructor parameters each serve one step: `PartyResolver` (who is involved, and which strategy moves the money), `TransactionJournal` (storing and announcing), the wallet repository (the fresh balance for validation), `IdempotencyService`, `LockManager`, `ValidationPipeline`, and the `databaseRoundTrip` function. | A change to lookups, storage, rules or notifications does not touch the payment flow. | One `transfer()` method with SQL, gateway calls, fraud checks and SMS sending inline. |
| `PartyResolver` and `TransactionJournal` (`src/service/TransactionJournal.ts`). | The lookup rules ("a foreign source is not found") and the store-then-announce sequence exist once, used by transfers, refunds, the outbox and recovery. | Each service repeating its own lookups and its own "update, publish, record the write" sequence. |
| `NotificationComposer` (who hears what), `NotificationService` (queueing, retries, storage), `NotificationChannel` (talking to a provider), all in `src/notification/`. | Changing a message's wording cannot break delivery or retries. | One notifier class that formats text, calls the provider and retries in a loop. |
| `src/domain/errors.ts` says what went wrong (`category`); `src/api/httpStatus.ts` says how HTTP shows it. | The domain can be reused by a non-HTTP client (the scheduler, start-up recovery) without carrying status codes. | Each error class carrying an `httpStatus` number. |
| `src/api/requests.ts` parses untrusted JSON, controllers shape HTTP, services hold the rules. | Services take typed input, so the scheduler can call `TransferService` with no HTTP request at all. | Services reading `req.body` and setting status codes. |

### Open/Closed

| Where | What it buys | What the violation would look like |
|---|---|---|
| `PaymentStrategyFactory.register()`: a payment method is a new `PaymentStrategy` registered in `src/container.ts`. | `TransferService` and `RefundService` never change for a new way to move money. | `switch (source.type)` in both services. |
| `PaymentSourceFactory.register(type, creator)` (`src/domain/PaymentSource.ts`) and `NotificationChannelFactory.register(channel)` (`src/notification/channels.ts`). | A new source type or channel registers itself; neither factory is edited. | A `switch` on the type inside the factory, edited for every new kind. |
| `ValidationPipeline`: a check is a new `ValidationHandler` subclass placed in the list in `src/container.ts`. | The order of checks is configuration, not code. | A growing `if` ladder inside `TransferService.process`. |
| `FraudEngine`: a rule is a new `FraudRule` in the array in `src/container.ts`. | Rules are added without touching other rules, the engine or the chain. | One `isFraud()` method edited for every new heuristic. |
| `TransactionEventPublisher.subscribe()`: a reaction is a new `TransactionObserver`. | Tracing, notifications, metrics and the retry of stuck refunds react to payments without the payment flow knowing them. | `TransferService` calling the notifier, the tracer, the metrics counter and the refund retry directly. |

**Proof by feature: scheduled payments.** `ScheduledPaymentService` (`src/service/ScheduledPaymentService.ts`) decides only when to pay; to pay, it calls the public `TransferService.transfer()` with the idempotency key `scheduled:<id>`. The feature consists of new code only: the `ScheduledPayment` entity and its status enumeration, a repository port and its SQLite implementation, the `scheduled_payments` table, a view mapper, three routes with their controller methods, and wiring in `src/container.ts`. No file of the payment flow mentions it: `TransferService`, the strategies, the validation chain, the ledger and the observers contain no reference to scheduled payments. A scheduled payment still gets validation, fraud rules, locking, the ledger and notifications, and a re-run of the scheduler cannot pay twice.

**Second proof: automatic retry of stuck refunds.** When a bank or card was charged, the credit failed and the saga's refund could not reach the gateway either, the money must still go back. `CompensationObserver` (`src/service/RefundService.ts`) handles this by subscribing: on a `FAILED` event whose transaction is still `FAILED` with funds captured, it puts a job on the `compensations` queue topic, and the subscriber wired in `src/container.ts` calls `RefundService.releaseCapturedFunds` (6 attempts, backoff from 1 s). `TransferService` does not know the observer exists. Start-up recovery reuses the same path: `ReconciliationService` closes an interrupted, captured payment as `FAILED`, and the observer queues its refund.

### Liskov Substitution

| Where | What it buys | What the violation would look like |
|---|---|---|
| `CachingWalletRepository` (`src/repository/CachingWalletRepository.ts`) stands in for `SqliteWalletRepository`. It keeps the contract written on `WalletRepository`: `findByUserId` "may be served from a cache", `findByUserIdForUpdate` always reads the database, `save` writes first and then invalidates. | Caching is added or removed in one line of `src/container.ts`; no caller changes. | Serving `findByUserIdForUpdate` from the cache, so a payment could be validated against a stale balance. |
| `WalletSource`, `BankAccountSource`, `CardSource` for `PaymentSource`. `CardSource.assertUsable` throws only in the way the base documents ("Throws if the source cannot be used right now"). | `PaymentSourceHandler`, `toSourceView` and `PartyResolver` handle every source with the same code. | A subclass whose limit could be missing, forcing callers to test `instanceof CardSource`. |
| The five `TransactionState` subclasses. Each answers every method; an illegal call reaches the base `reject()` and throws the same `IllegalStateTransitionError`. | `Transaction` delegates without knowing which state it holds. | A state that silently ignored an illegal `refund()`, so a caller would believe money had moved back. |
| `CircuitBreakerGateway` for `SimulatedGateway`. It adds `CircuitOpenError`, a `ServiceUnavailableError` like the `GatewayUnavailableError` the raw gateway throws. | Strategies and recovery handle both the same way. | A wrapper that returned a fake receipt while open. |
| Error subclasses keep their parent's category: `FraudSuspectedError` is a `ForbiddenError` and is shown as one; `PaymentDeclinedError` is its own `DECLINED` branch. | Code that handles "any `ForbiddenError`" or "any `BusinessRuleError`" is right for every subclass. | A subclass of `BusinessRuleError` that is presented with a different status from its parent. |

### Interface Segregation

| Where | What it buys | What the violation would look like |
|---|---|---|
| `TransferHistoryReader` (`src/repository/interfaces.ts`): three read methods. `DailyLimitHandler`, `VelocityRule` and `HighValueNewPayeeRule` depend on it instead of on `TransactionRepository`, which extends it. | A fraud rule cannot insert or update a transaction, and a test needs to fake only three methods. | Handing the rules the full repository with `insert` and `update`. |
| `SqlReader` versus `SqlWriter` (`src/infrastructure/db/Database.ts`). `ReplicaDatabase` implements only `SqlReader`; read-side repository methods accept a `SqlReader`. | Writing to the replica is a compile error, so replication cannot be bypassed. | One `Database` interface with `run()` on the replica too. |
| `UnitOfWork` on its own. `UserService` and the strategies (through `SettlementDependencies`) receive it only to group writes atomically; `SqliteTransactionRepository` asks for `SqlWriter & UnitOfWork`, exactly the two capabilities it uses to save a row with its events. | Atomicity is visible in the type of the dependency. | Passing the whole database object to every class that needs a transaction. |
| `createHttpApp` in `src/api/createHttpApp.ts` receives the `Application` interface (services, `readRouter`, `chaos`) and `EdgeComponents` (`loadBalancer`, `rateLimiter`, `addressRateLimiter`, `primary`), nothing more. | The web edge cannot reach the queue, the cache, the locks or the repositories. | Passing every infrastructure object to the HTTP layer. |

### Dependency Inversion

| Where | What it buys | What the violation would look like |
|---|---|---|
| Constructor injection everywhere, with `src/container.ts` as the composition root: services, repositories and their decorators, gateways, strategies, channels, handlers, fraud rules and observers are all created there. The exceptions are small: `createHttpApp` builds the controllers, and `openDatabases` (called by the container) builds the two database nodes. | Swapping the in-process cache, queue and SQLite for Redis, Kafka and PostgreSQL needs new adapter classes and changes to this one file, as its header comment states. | `new SqliteWalletRepository()` or `new InMemoryCache()` inside services. |
| Services depend on repository ports; repositories depend on `SqlWriter`; strategies on `PaymentGateway`; `IdempotencyService` on `Cache`; `TransferService` and `RefundService` on `LockManager`. Variable behaviour arrives as injected functions: `databaseRoundTrip` for `TransferService`, `gatewayFor` for `ReconciliationService`, `load` for `OutboxRelay`. | High-level policy does not import low-level detail or `ChaosController`; tests can pass fakes or a no-op function. | `TransferService` importing `node:sqlite` or reading `ChaosController` itself. |
| The domain does not depend on the web layer: `src/domain/errors.ts` exports categories, and only `src/api/httpStatus.ts` imports them to choose a status. | The dependency points from the API to the domain, never back. | Domain errors importing HTTP constants. |
| `AppConfig.getInstance()` is called once, in `src/main.ts`, and the settings are passed down. `MetricsRegistry.getInstance()` is called once, in `src/container.ts`, and injected into `MetricsObserver` and `SystemService`. | No business class reads the environment or a global counter. | Services calling `process.env` or `getInstance()` themselves. |

## Design decision: a refund changes the original transaction

A refund moves the original transaction from `SUCCESS` (or `FAILED` with captured funds) to `REFUNDED`; it does not create a second transaction. `RefundService.reverse` calls `strategy.reverse`, which calls `txn.refund()` and writes two reversing ledger lines under the original transaction id, all in one unit of work.

- **Why.** The project brief defines one lifecycle, `INITIATED -> PROCESSING -> SUCCESS or FAILED -> REFUNDED`. Making `REFUNDED` a state of the payment implements exactly that, and the state machine then guarantees a payment is refunded at most once without any extra key.
- **Cost.** There are no partial refunds and no second refund: the refund amount is always the transaction amount (`LedgerLine` has no amount of its own; `LedgerService.record` posts `transaction.amount`).
- **The alternative.** A refund would be its own transaction, of a new `TransactionType` such as `REFUND`, with its own id, idempotency key and lifecycle, an amount up to what is still refundable, and a link column to the original payment. Its ledger lines would carry the refund's own id. The original would stay `SUCCESS` (or show a derived "partly refunded" total), and the refundable remainder would have to be checked under the lock on every refund. That allows several partial refunds, at the price of a schema change, a new type, and a lifecycle that differs from the brief's.

## Where the prototype bends a principle

1. **Several dependencies are concrete classes, not ports.** `TransferService` receives `PartyResolver`, `TransactionJournal`, `IdempotencyService` and `ValidationPipeline` as classes (its `WalletRepository` and `LockManager` are interfaces); `RefundService` and `ReconciliationService` receive `PartyResolver` and `TransactionJournal`; `PartyResolver` receives `UserService` and `PaymentStrategyFactory`; `ScheduledPaymentService` receives `TransferService`. Because TypeScript checks types structurally, a test can still pass any object with the same public methods, so substitution works without a named interface. The container's header comment ("depends on interfaces") is true for the repositories and infrastructure ports only.
2. **The tracer is a global.** `tracer` (`src/infrastructure/observability/Tracer.ts`) is imported directly by 21 files instead of being injected. It is a cross-cutting, write-only recorder, so the hidden dependency is accepted, but it is still one.
3. **Some methods are public only by convention.** `Transaction.applyTransition()` and `recordFailure()` are marked "Called only by TransactionState implementations"; `Transaction.unrecordedTransitions()`, `markInserted()`, `markPersisted()` and `Wallet.markPersisted()` are for the repositories; `User.toProps()` returns the PIN hash for persistence. TypeScript has no package-private visibility.
4. **The ports are synchronous.** Repositories, `Cache.get` and `SqlReader` return values directly, because SQLite and the cache run in this process. A networked PostgreSQL or Redis adapter would need `Promise`-returning signatures, and every caller would change with them. The ports hide the technology but not its latency model.
5. **Closed lists remain outside the factories.** The factories are registries, but a new payment source type still needs a value in `PaymentSourceType` and in two `CHECK` constraints (`payment_sources.type`, `transactions.source_type`), and a new notification channel a value in `NotificationChannelType` and in the `CHECK` on `notifications.channel` (`src/infrastructure/db/schema.ts`).
6. **The fault-injection decorator is a deliberate LSP exception.** `src/container.ts` wraps the wallet repository in `FaultInjectingWalletRepository` only when the `faultInjection` setting is on (the default for the demo; `FAULT_INJECTION=false` leaves it out). When `failNextCredit` is armed, its `save` throws `CREDIT_FAILED` once for the next save that increases any balance, which the `WalletRepository` contract does not mention; that is the point of the class.
7. **Observers must tolerate repeats, and not all of them do.** `OutboxRelay` delivers at least once, and its comment says observers "are written to tolerate a repeat". `NotificationObserver` does (deterministic notification ids) and a repeated `CompensationObserver` job is harmless, but `MetricsObserver` would count an event twice and `LifecycleTraceObserver` would trace it twice after a crash between publishing and marking.
8. **Other small bends.** `SystemService` takes a wide bag (`SystemComponents`, 19 members); as the operator's view of every component, that is its job, but it is the opposite of a segregated interface. `UserService` keeps wrong-PIN counters (separate ones for payments and sign-in) in a private `#pinFailures` map, so the lockout holds per process, not across app nodes. `CompensationObserver` is defined in `src/service/RefundService.ts` rather than next to the other observers.
