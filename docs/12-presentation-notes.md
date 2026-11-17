# Presentation notes

This document answers "what must I be able to explain, and defend, before presenting?" For every significant decision it gives what was built, why, what the alternatives were and why they were not chosen. It ends with the numbers to remember and the weaknesses to state before anyone asks.

## The one-minute version

A payment app must never lose a payment and never apply one twice, even when networks fail, users retry and requests arrive together. This project is a small UPI-style wallet that shows how:

- **Retries are safe** because every payment carries an idempotency key.
- **Money cannot be spent twice** because one payment at a time runs per payer, and the database refuses an overdraft even if that fails.
- **Every rupee is traceable** because money only moves through an append-only, double-entry ledger.
- **Failures of other systems do not become our failures**: circuit breaker, compensation, queue with retries.
- **It can grow**: stateless app nodes, a cache, a read replica, rate limits.
- **New payment methods and rules plug in** without editing the payment flow.

## The path of one payment (know this by heart)

`POST /api/v1/transfers`, as implemented in `src/service/TransferService.ts`:

1. Edge: same-site guard, request id, load balancer picks a node, rate limits.
2. The UPI PIN is verified (5 wrong attempts lock PIN entry for 60 seconds).
3. Idempotency: claim the key, or return the stored answer of an earlier attempt.
4. The transaction is recorded as INITIATED.
5. The payer's lock is taken; the transaction moves to PROCESSING.
6. Validation chain, in order: account status, payment source, available funds, daily limit, fraud rules.
7. The payment strategy for the source moves the money. Wallet: debit, credit, two ledger entries, status and event in one database transaction. Bank or card: charge through a circuit breaker, then credit; refund the charge if the credit fails.
8. Events are relayed from the outbox to observers: notifications are queued, metrics counted.
9. The response is sent. In the background, workers deliver SMS, push and email, and the replica catches up.

The Wallet screen's "What just happened" panel shows exactly these steps for a real request. Use it while you talk.

## Decisions, reasons and alternatives

### Correctness of money

| Decision | Why | Alternatives | Why not those |
|---|---|---|---|
| **Idempotency-Key** sent by the client, claimed by inserting a row whose primary key is (user, key) | A retry is recognised exactly, and two simultaneous retries cannot both win the insert | Guess duplicates from "same payer, payee and amount within N seconds"; keep keys only in a cache | Guessing blocks a genuine second payment of the same amount. A cache can evict or lose the key, and then the retry pays twice. Here the cache is only a fast path in front of the table |
| **Per-payer lock** around validation and debit | The balance, daily-limit and velocity checks and the debit all see the same state | Optimistic locking only; a database row lock (`SELECT ... FOR UPDATE`); one queue per account | Optimistic locking protects the wallet row but not the limit and velocity checks, which read other rows. SQLite has no row locks; on PostgreSQL a row lock is the natural replacement. A per-account queue is the same idea with more machinery |
| **Three more guards behind the lock**: `Wallet.debit()` re-read inside the transaction, a `version` column, `CHECK (balance >= 0)` | The lock lives in one process; these hold across processes, which `npm run race` demonstrates | Trust the lock alone | A single guard is a single point of failure, and an in-process lock means nothing to another node |
| **One database transaction** for debit, credit, ledger entries, status and event | Money is never half-moved, and the status cannot disagree with the ledger | Separate writes with clean-up on failure | A crash between separate writes leaves money debited and not credited |
| **Money as integer paise** (`Money` value object) | No floating-point error | Floating-point rupees; a decimal library | 0.1 + 0.2 is not 0.3 in floating point. A decimal library is fine but unnecessary for one currency |
| **Double-entry, append-only, hash-chained ledger**, with the balance also stored on the wallet | The ledger is the proof; the stored balance makes reads instant; the audit proves they agree | Balance column only; derive the balance from the ledger on every read (event sourcing); a blockchain | Balance only has no history. Summing the ledger on every read is slow. A blockchain solves agreement between parties who do not trust each other, which is not this problem; a hash chain gives tamper evidence without it |

### Design patterns

| Decision | Why | Alternatives | Why not those |
|---|---|---|---|
| **Strategy** for payment methods (`PaymentStrategy`: wallet, bank, card) | Each source moves money differently; the transfer flow should not know how | `if (type === ...)` in the service; subclasses of Transaction | Every new method would edit the core flow. The method of payment is not a kind of transaction |
| **Chain of Responsibility** for validation (`ValidationHandler`) | One rule per class, an explicit order (cheap checks first), and the first failure stops the chain | One long `validate()` method; a plain list of validator functions | A long method grows without limit. A plain list is honestly close to equivalent; the chain was chosen because each handler decides whether to continue, and the brief asks for it |
| **State** for the lifecycle (`TransactionState`) | Each state decides which transitions are legal and what they do (failing records a reason; FAILED may be refunded only if funds were captured) | A status enum with `if` checks; a transition table | Scattered `if`s are how illegal transitions slip in. A transition table is a fair alternative for pure transitions but cannot carry per-state behaviour |
| **Observer** (`TransactionEventPublisher`) for notifications, metrics, tracing and refund retries | The payment flow does not know who reacts to it; `CompensationObserver` was added without touching `TransferService` | Call the notification service directly from the transfer service | Every new reaction would edit the payment flow, and a notification bug could break a payment |
| **Transactional outbox** (`OutboxRelay`) | The event is committed with the state change, so a crash cannot lose it | Publish straight after the commit; change-data-capture from the database log | Publishing after the commit loses the event if the process dies in between (the "dual write" problem). Change-data-capture is the production-grade version of the same idea and needs extra infrastructure |
| **Decorator** for caching (`CachingWalletRepository`), the circuit breaker (`CircuitBreakerGateway`) and fault injection | Adds behaviour without the wrapped class or its callers changing; removable by not wrapping | Put caching inside the repository or the service | Mixes concerns and cannot be switched off or tested separately |
| **Factory as a registry** (`PaymentStrategyFactory`, `PaymentSourceFactory`, `NotificationChannelFactory`) | A new type registers itself; no `switch` to edit | A `switch` on type | A `switch` must be edited for every new type, which breaks Open/Closed |
| **Builder** (`TransactionBuilder`) | Many required fields and rules; refuses to build an incomplete transaction | A constructor with ten parameters | Easy to pass arguments in the wrong order, and validation ends up scattered |
| **Singleton** for `AppConfig`, `Tracer`, `MetricsRegistry` | One process-wide instance is the point | Pass them everywhere | Config is in fact passed down from one place. The tracer is used as a global, which is a known weakness (see below) |
| **Repository** interfaces with SQL implementations | Services depend on interfaces; the SQL, indexes and transactions stay visible | An ORM; SQL inside services | An ORM hides exactly what a design review wants to see. SQL in services ties business rules to one database |
| **Constructor injection with one composition root** (`src/container.ts`) | Dependency Inversion without a framework; every wiring decision is in one readable file | A dependency-injection framework; classes creating their own collaborators | A framework adds magic the team would have to explain. Self-created collaborators cannot be swapped or tested |

### Scaling

| Decision | Why | Alternatives | Why not those |
|---|---|---|---|
| **Stateless app nodes behind a load balancer** (round robin) | Any node can serve any request, so capacity grows by adding nodes and a dead node is not noticed | Sticky sessions; least-connections; consistent hashing | Stickiness is only needed when nodes hold state, and they do not. Least-connections helps when request costs differ widely; consistent hashing when a key must always reach the same node |
| **Cache-aside** for wallet balances, with a TTL and invalidation on every write | Balance is read far more often than it changes | Write-through cache; no cache | Write-through couples every write to the cache. Without a cache every balance view hits the database. Money decisions never use the cache |
| **Read replica** for history, with **read-your-writes** by commit number (LSN) | Takes read load off the primary without a user ever seeing their own payment missing | All reads on the primary; "read from the primary for N seconds after a write"; synchronous replication | The primary becomes the bottleneck. A fixed time window is a guess; comparing commit numbers is exact. Synchronous replication makes every write wait for the replica |
| **Queue** for notifications, with retries, exponential backoff and a dead-letter queue | A slow or broken SMS provider cannot slow or fail a payment | Send inside the request; fire-and-forget | Sending inline adds the provider's latency and failures to every payment. Fire-and-forget loses messages silently |
| **Token-bucket rate limiting**, per signed-in user and per client address | Allows short bursts and caps the sustained rate, with constant memory per client | Fixed window; sliding window log; leaky bucket | A fixed window lets a double burst through at the window boundary. A sliding log stores every request. A leaky bucket forbids bursts, which real users produce |
| **Keyset pagination** (`?before=<cursor>`) | Stays fast on deep pages and never skips or repeats rows when new payments arrive | `OFFSET` and `LIMIT` | `OFFSET` scans and discards every earlier row, and shifts when rows are inserted |

### Failure handling

| Decision | Why | Alternatives | Why not those |
|---|---|---|---|
| **Saga with compensation** for bank and card payments: charge, then credit, refund the charge if the credit fails | The bank is another system; one transaction cannot span both | Two-phase commit; authorise first, capture after the credit | Banks do not offer two-phase commit. Authorise-then-capture is a good real-world alternative for cards and would remove most refunds; compensation was chosen because it works for bank transfers as well |
| **Circuit breaker** around each gateway (opens after 3 failures, trial call after 8 seconds) | Stops waiting on a dependency that is down, and gives it room to recover | Timeouts and retries only | Retries against a dead dependency make the outage worse and tie up every request |
| **Start-up reconciliation** (`ReconciliationService`) | A crash can leave a payment PROCESSING, a key IN_PROGRESS or a schedule RUNNING; these are closed before any request is served, and the gateway is asked whether a charge happened | Leave them for manual repair; a periodic background job | Manual repair does not scale. A periodic job with leases is the right design for several nodes; start-up is enough for one |
| **PIN lockout** (5 attempts, 60 seconds; sign-in counted separately) | A 4-digit PIN has 10,000 values | Rate limiting alone; CAPTCHA | A rate limit only slows guessing. Sign-in is counted separately so a stranger cannot lock the owner out of paying |
| **Receiver-only refunds, one refund per payment** | The payer must not be able to pull money back; the state machine allows REFUNDED once | Either party; a separate refund transaction with partial refunds | Letting the payer refund is theft. A separate refund transaction is the better model, but the brief defines Refunded as a lifecycle state, so partial refunds are out of scope |

### Platform choices

| Decision | Why | Alternatives | Why not those |
|---|---|---|---|
| **TypeScript on Node.js** | Interfaces, abstract classes and private fields for the object-oriented design; one language for server and UI; starts with one command | Java with Spring Boot | Equally valid and more traditional for this subject. It needs a build tool and more set-up, and Spring's annotations would hide the wiring that `src/container.ts` shows explicitly |
| **SQLite, built into Node** | A real relational database with transactions, constraints and triggers, and nothing to install | PostgreSQL or MySQL | They are what production would use. They need a server, which works against a demo that must start anywhere |
| **In-process cache, queue, lock and replica behind interfaces** | Shows each mechanism working with no infrastructure; each interface is where Redis, Kafka or PostgreSQL would plug in | Real Redis and Kafka in Docker | More realistic, but a demo that depends on Docker can fail on the day for reasons unrelated to the design |
| **One deployable application, organised in layers** | The core path needs one database transaction; that is simple inside one service | Microservices | Splitting wallet, ledger and payment into services would turn the atomic transfer into a distributed transaction |
| **Signed stateless session tokens** (HMAC) | Any node can verify a token without a session store | Server-side sessions; a JWT library | A session store is shared state every node must reach. A JWT library does the same job with a standard format; the hand-written version is short enough to explain line by line. Trade-off: a token cannot be revoked before it expires, so the lifetime is 30 minutes |
| **Single-table inheritance** for payment sources (`type` column plus JSON details) | One query loads any source; subclasses differ in a few fields | One table per subclass | More joins for no benefit at this size. The cost is weaker constraints on the type-specific fields |

## Numbers to remember

| What | Value | Where it comes from |
|---|---|---|
| Automated tests | 798, all passing | `npm test` |
| Scenario lab | 20 scenarios, all passing | Scenario lab screen |
| Balance reads | about 8,600 per second on one core | `npm run loadtest` |
| Payments | about 276 per second on one core, CPU-bound | `npm run loadtest` |
| Cost of one payment | about 3 ms of CPU, of which 2 ms is hashing the PIN | `11-load-and-concurrency-evidence.md` |
| Multi-process race | 4 processes, 40 attempts, exactly 10 succeed | `npm run race` |
| Rate limit | 30 burst, 15 per second per user | `src/config/AppConfig.ts` |
| Circuit breaker | opens after 3 failures, trial after 8 s | `src/config/AppConfig.ts` |
| Notification retries | 3 attempts, 250 ms then 500 ms, then dead-letter | `src/config/AppConfig.ts` |
| Replica lag | 400 ms by default | `src/config/AppConfig.ts` |
| Fraud rules | blacklisted payee; more than 6 payments a minute; first payment of ₹10,000 or more to a new payee | `src/validation/fraud.ts` |
| Daily limit | ₹50,000 by default | `src/config/AppConfig.ts` |

## Say these before you are asked

Admitting a limit and naming the fix scores better than being caught.

1. **It is a prototype.** The bank, the notification providers, the cache, the queue, the lock, the replica and the load balancer are simulated inside one process, behind interfaces.
2. **The storage interfaces are synchronous**, because SQLite is in-process. A networked database makes them asynchronous, which changes their callers. There is no Redis or PostgreSQL adapter to prove the swap.
3. **Node runs on one thread.** The in-process lock is only contended at an `await`. That is why `npm run race` exists: it shows the database guards hold across separate processes.
4. **PIN hashing blocks the main thread** and is the largest cost per payment. The fix is asynchronous hashing.
5. **The demo UI identifies users with a header.** Signed session tokens exist and can be made mandatory with `ALLOW_HEADER_IDENTITY=false`.
6. **Crash recovery assumes one process.** Several nodes need a periodic job with leases.
7. **The tracer is a global** imported by many files, which bends Dependency Inversion.
8. **A refund overwrites the original status**; there are no partial refunds.
9. **Tests were written after the code**, to pin down behaviour, not test-first.

## Commands for the day

```bash
npm start          # the app, http://localhost:3000, PIN 1234
npm test           # 798 tests
npm run race       # double-spend proof across processes
npm run crash      # kill the server mid-payment and watch it recover
npm run loadtest   # measured throughput and latency
```

`10-demo-guide.md` has the ten-minute running order and likely questions with answers.
