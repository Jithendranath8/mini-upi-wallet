# Sequence and activity diagrams

This document shows, step by step, what happens inside the system for each important flow: a payment, a retry, a race, a bank payment with compensation, an outage, a refund, notifications, scheduled payments, reads, recovery after a crash and sign-in. Every diagram follows the real call order in the code (and the request traces the running server records at `GET /api/v1/system/traces/:id`), so it can be checked line by line against the files named below. The class structure behind these flows is in `02-class-diagram.md`; the API contract is in `06-api-design.md`.

## Participants used below

| Alias | Class or component | File |
|---|---|---|
| MW | Express middleware: `securityHeaders`, `sameSiteOnly`, `requestContext`, `loadBalancing`, `addressRateLimiting`, `authentication` (Bearer token or `X-User-Id`, then the per-user rate limit) | `src/api/middleware.ts` |
| PC | `PaymentController` | `src/api/controllers.ts` |
| US | `UserService` | `src/service/UserService.ts` |
| IS | `IdempotencyService` | `src/service/IdempotencyService.ts` |
| TS | `TransferService` | `src/service/TransferService.ts` |
| PR | `PartyResolver`: who and what a payment involves | `src/service/TransactionJournal.ts` |
| TJ | `TransactionJournal`: store a transaction, then announce it | `src/service/TransactionJournal.ts` |
| TR | `SqliteTransactionRepository`: the row and its `transaction_events` rows in one unit of work | `src/repository/sqlite/TransactionRepositories.ts` |
| OR | `OutboxRelay`: unpublished events to the observers, then mark them published | `src/events/Outbox.ts` |
| EP | `TransactionEventPublisher` and its observers (`LifecycleTraceObserver`, `NotificationObserver`, `MetricsObserver`, `CompensationObserver`) | `src/events/TransactionEvents.ts`, `src/service/RefundService.ts` |
| LM | `InMemoryLockManager` (behind `LockManager`) | `src/infrastructure/lock/LockManager.ts` |
| VP | `ValidationPipeline` and its handlers | `src/validation/` |
| WS / ES | `WalletPaymentStrategy` / `ExternalPaymentStrategy` (`BankTransferStrategy`, `CardPaymentStrategy`) | `src/payment/strategies.ts` |
| DB | `PrimaryDatabase` (SQLite, the only writer) | `src/infrastructure/db/Database.ts` |
| Q | `InMemoryMessageQueue` (behind `MessageQueue`) | `src/infrastructure/queue/MessageQueue.ts` |
| RS | `ReplicationStream` and `ReplicaDatabase` | `src/infrastructure/db/Replication.ts` |

## 1. Send money, wallet to wallet (happy path)

```mermaid
sequenceDiagram
  autonumber
  actor C as Client
  participant MW as Middleware
  participant PC as PaymentController
  participant IS as IdempotencyService
  participant TS as TransferService
  participant PR as PartyResolver
  participant TJ as TransactionJournal
  participant TR as TransactionRepository
  participant OR as OutboxRelay
  participant LM as LockManager
  participant VP as ValidationPipeline
  participant WS as WalletPaymentStrategy
  participant DB as PrimaryDatabase
  C->>MW: POST /api/v1/transfers (Authorization Bearer or X-User-Id, Idempotency-Key, body)
  Note over MW: security headers, same-site and Host check, express.json (16 kB), X-Request-Id, load balancer, per-address bucket, identify the caller, per-user bucket
  MW->>PC: transfer(req, res)
  PC->>PC: bodyOf, clientKey, requiredString, amountOf (amountPaise or amount), plainText(note)
  PC->>PC: users.verifyPin(user, body.pin)
  PC->>TS: transfer(command)
  TS->>IS: execute(senderId, key, fingerprint, process)
  IS->>DB: cache miss, tryBegin - INSERT idempotency_keys IN_PROGRESS
  IS->>TS: run process(command)
  TS->>TJ: findByKey - none, so this is a new payment
  TS->>PR: forNewPayment(senderId, receiverUpiId, sourceId), strategyFor(source)
  TS->>TJ: open(txn, parties)
  TJ->>TR: insert - row INITIATED plus its event row (published_at NULL), one unit of work
  TJ->>OR: relay - publish INITIATED to the observers, then mark it published
  TJ->>TJ: readRouter.recordWrite(senderId)
  TS->>LM: withLock("wallet:" + senderId)
  LM-->>TS: lock granted
  TS->>TS: await databaseRoundTrip (simulated 5 ms, lock held)
  TS->>TJ: startProcessing, save - versioned UPDATE plus event row, then relay
  TS->>DB: wallets.findByUserIdForUpdate(sender), bypasses the cache
  TS->>VP: validate(context)
  Note over VP: Account status, Payment source, Available funds, Daily limit, Fraud rules
  TS->>WS: pay(context)
  WS->>DB: runInTransaction - BEGIN IMMEDIATE
  Note over WS,DB: reload txn, both wallets, debit and credit, save both with version check, 2 hash-chained ledger entries, txn.succeed, versioned update with its SUCCESS event row
  DB-->>WS: COMMIT - one replication commit (one LSN)
  WS-->>TS: settled transaction (SUCCESS)
  LM-->>TS: lock released
  TS->>TJ: announce(txn, parties)
  TJ->>OR: relay - SUCCESS to the observers (NotificationObserver enqueues), mark published
  TJ->>TJ: readRouter.recordWrite(senderId)
  TS-->>IS: TransferResult
  IS->>DB: complete - COMPLETED with response_body, cache set (10 minutes)
  IS-->>PC: outcome, replayed false
  PC-->>C: 201 Created, Idempotent-Replayed false, data.transaction
  par after the response
    RS->>RS: apply waiting commits to the replica replicaLagMs (400 ms) later
  and
    Note over DB: queue workers send SMS, push, email and upsert notifications rows
  end
```

What to notice: the payer lock covers exactly the part that must see one consistent balance (fresh wallet read, validation chain, money movement), and the simulated database round trip inside it makes concurrent payments by one payer really queue behind the lock. Observers are never called directly: every state change is first written to `transaction_events` in the same unit of work as the status (that table is both the audit trail and the outbox), and only after the commit does `OutboxRelay.relay` hand the unpublished events to the observers and set `published_at`. A crash between the commit and the relay therefore loses nothing: the events are relayed at the next start (diagram 10).

## 2. Retry with the same Idempotency-Key

### 2a. After the first request finished

```mermaid
sequenceDiagram
  actor C as Client
  participant PC as PaymentController
  participant IS as IdempotencyService
  participant CA as Cache
  participant DB as idempotency_keys
  C->>PC: POST /transfers, same key, same body
  PC->>PC: parse body, verifyPin
  PC->>IS: execute(userId, key, hash, process)
  IS->>CA: get("idem:" + userId + ":" + key)
  alt cached outcome (kept 10 minutes)
    CA-->>IS: requestHash and result
    IS->>IS: assertSameRequest(stored hash, incoming hash)
  else cache expired or evicted
    IS->>DB: tryBegin - INSERT ... ON CONFLICT DO NOTHING
    DB-->>IS: 0 rows changed
    IS->>DB: find(userId, key)
    DB-->>IS: COMPLETED, same request_hash, response_body
  end
  IS-->>PC: stored result, replayed true
  PC-->>C: 200 (or the stored error status), Idempotent-Replayed true
```

What to notice: `process()` never runs again, so no second transaction, debit or notification can happen. The `idempotency_keys` row is the source of truth; the cache is only a fast path. If the key row were missing while a transaction exists (for example after start-up reconciliation released it), `process()` still does not pay twice: its first step, `TransactionJournal.findByKey`, finds the earlier transaction and `answerFromStored` answers from it, or returns 409 `REQUEST_IN_PROGRESS` if that transaction is not finished.

### 2b. While the first request is still in flight

```mermaid
sequenceDiagram
  participant A as Request A
  participant B as Request B
  participant IS as IdempotencyService
  participant DB as idempotency_keys
  participant TS as TransferService
  A->>IS: execute(key K)
  IS->>DB: tryBegin(K)
  DB-->>IS: 1 row, IN_PROGRESS
  IS->>TS: process for A (for example waiting on the bank)
  B->>IS: execute(key K, same body)
  IS->>DB: tryBegin(K)
  DB-->>IS: 0 rows, primary key already taken
  loop every 50 ms, at most 100 polls
    IS->>DB: find(K)
    DB-->>IS: IN_PROGRESS, same request_hash
  end
  TS-->>IS: result for A
  IS->>DB: complete(K, response_body)
  IS-->>A: result, replayed false
  IS->>DB: find(K) on the next poll
  DB-->>IS: COMPLETED
  IS-->>B: stored result, replayed true
  Note over IS,DB: no row at all means A failed before recording anything and released K, so B calls execute again. 100 polls without COMPLETED gives 409 REQUEST_IN_PROGRESS.
```

What to notice: the atomic claim is the `PRIMARY KEY (user_id, idem_key)` of `idempotency_keys`, so exactly one of two simultaneous requests wins. The loser waits up to about five seconds (`idempotencyMaxPolls` times `idempotencyPollIntervalMs`) and then answers with the winner's result.

### 2c. Same key, different body

```mermaid
sequenceDiagram
  actor C as Client
  participant IS as IdempotencyService
  participant DB as idempotency_keys
  C->>IS: execute(key K, hash of the new body)
  alt outcome still cached
    IS->>IS: assertSameRequest(cached hash, new hash) fails
  else only the table has it
    IS->>DB: tryBegin(K) returns false, then find(K)
    DB-->>IS: request_hash of the first body
    IS->>IS: assertSameRequest fails
  end
  IS-->>C: 422 IDEMPOTENCY_KEY_REUSED, nothing recorded
```

What to notice: the hash is `fingerprint()` in `src/service/TransferService.ts`, a SHA-256 of the lower-cased receiver UPI ID, the amount in paise, the source id (or `WALLET`) and the trimmed note. The PIN is not part of it, and `"amountPaise": 200` and `"amount": 2` are the same request. Client keys starting with `scheduled:` are refused (400 `IDEMPOTENCY_KEY_RESERVED`) because that namespace belongs to the scheduler (diagram 8).

## 3. Double-spend race on one wallet

```mermaid
sequenceDiagram
  participant P1 as Payment 1 (key K1)
  participant P2 as Payment 2 (key K2)
  participant LM as LockManager
  participant VP as ValidationPipeline
  participant WS as WalletPaymentStrategy
  participant DB as PrimaryDatabase
  Note over P1,P2: balance 100, each payment is 80, both arrive together
  P1->>DB: claim K1, open INITIATED
  P2->>DB: claim K2, open INITIATED
  P1->>LM: withLock("wallet:alice")
  LM-->>P1: granted immediately
  P2->>LM: withLock("wallet:alice")
  Note over LM: P2 waits in a FIFO queue, timeout lockTimeoutMs (5 s)
  P1->>P1: database round trip, PROCESSING
  P1->>VP: validate with fresh balance 100 - passes
  P1->>WS: pay
  WS->>DB: debit 80, credit 80, ledger, SUCCESS - COMMIT (balance 20)
  P1->>LM: release - ownership passes straight to P2
  LM-->>P2: granted
  P2->>VP: validate with fresh balance 20
  VP-->>P2: InsufficientBalanceError (Available funds handler)
  P2->>DB: txn.fail, journal.save (FAILED, INSUFFICIENT_BALANCE)
  Note over P2: client gets 422 with data.transaction FAILED
```

What to notice: the lock key is the payer (`wallet:<senderId>`), so payments by different people never wait for each other, and the second payment reads the balance only after the first has committed. Behind the lock there are more guards that would each stop an overdraft if the lock were ever bypassed: `Wallet.debit` re-checks the balance inside the unit of work; `SqliteWalletRepository.save` updates `WHERE id = ? AND version = ?` and throws `OptimisticLockError` (409 `CONCURRENT_MODIFICATION`, rolling back) if the row changed; transactions are versioned the same way; and the table has `CHECK (balance_paise >= 0)`. If P1 held the lock longer than five seconds (a slow bank), P2 would be recorded as FAILED with 503 `LOCK_TIMEOUT`.

## 4. Bank or card funded payment with saga compensation

```mermaid
sequenceDiagram
  participant TS as TransferService
  participant ES as ExternalPaymentStrategy
  participant GW as CircuitBreakerGateway
  participant SG as SimulatedGateway
  participant DB as Primary DB and repositories
  participant TJ as TransactionJournal
  participant Q as compensations topic
  Note over TS,ES: still inside the payer lock, after the validation chain
  TS->>ES: pay(context)
  ES->>ES: authorise hook (cards log a simulated 3-D Secure step)
  ES->>GW: charge(reference = txn id, sourceId, amount)
  GW->>SG: breaker admits the call, inner charge
  SG-->>GW: ChargeReceipt (gatewayTransactionId)
  GW-->>ES: receipt, breaker records a success
  ES->>DB: markFundsCaptured, update (funds_captured 1, gateway_ref)
  ES->>DB: runInTransaction - credit step
  alt credit commits
    Note over DB: reload txn, credit receiver wallet, ledger DEBIT EXTERNAL:src and CREDIT WALLET:wal, SUCCESS with its event
    DB-->>ES: COMMIT
    ES-->>TS: SUCCESS
  else credit throws (for example the injected wallet fault)
    DB-->>ES: ROLLBACK, receiver not credited
    ES->>DB: compensate - txn.fail(CREDIT_FAILED), update (FAILED event stored)
    ES->>GW: refund(txn id)
    alt gateway refund succeeds
      GW-->>ES: ok
      ES->>DB: txn.refund, update (REFUNDED event stored)
      ES-->>TS: throws 422 CREDIT_FAILED_REFUNDED
    else gateway refund fails (bank down or circuit open)
      GW-->>ES: GatewayUnavailableError or CircuitOpenError
      ES-->>TS: throws 422 CREDIT_FAILED_REFUND_PENDING, stays FAILED with funds captured
    end
    TS->>TJ: settleFailure - status already final, announce
    TJ->>Q: outbox relays FAILED, CompensationObserver queues the id if still FAILED
    Q->>Q: RefundService.releaseCapturedFunds, 6 attempts, backoff 1 s, 2 s, 4 s, ...
  end
```

What to notice: the charge and the credit cannot share one database transaction because the bank is another system, so the code records `funds_captured` before the credit and undoes the charge if the credit fails (a saga: FAILED, then REFUNDED). The gateway is idempotent on `reference` (our transaction id), and two callers refunding the same charge at once share one in-flight refund. The strategy knows nothing about fault injection: the demo's "fail the next credit" is a decorator, `FaultInjectingWalletRepository`, that makes the next balance-increasing `save` throw once. If the refund cannot reach the gateway, the `compensations` job retries it, `recover()` in `src/container.ts` queues it again after a restart, `POST /api/v1/system/queue/redrive` re-queues it after the retries run out, and either party may release it with `POST /transactions/:id/refund`.

## 5. Bank outage and the circuit breaker

```mermaid
sequenceDiagram
  actor Op as Operator
  participant TS as TransferService
  participant CB as CircuitBreaker
  participant SG as SimulatedGateway
  Op->>SG: PUT /api/v1/system/chaos with bank.down true
  loop payments 1 to 3 (breakerFailureThreshold)
    TS->>CB: execute(charge)
    CB->>SG: charge
    SG-->>CB: GatewayUnavailableError
    CB->>CB: consecutiveFailures plus 1
    CB-->>TS: 503 GATEWAY_UNAVAILABLE, transaction FAILED
  end
  Note over CB: third failure in a row, state OPEN for breakerOpenMs (8 s)
  TS->>CB: execute(charge)
  CB-->>TS: 503 CIRCUIT_OPEN at once, gateway not called
  Note over CB: first call after 8 s turns OPEN into HALF_OPEN
  TS->>CB: execute(charge) - the single trial call
  alt trial succeeds
    CB->>SG: charge
    SG-->>CB: receipt
    CB->>CB: CLOSED, failures reset to 0
  else trial fails
    CB->>CB: OPEN again for 8 s
  end
```

What to notice: only `GatewayUnavailableError` counts as a failure (the `isOutage` predicate in `src/container.ts`); a decline (`PaymentDeclinedError`, 402) means the bank answered and resets the count. While HALF_OPEN, a second concurrent call is rejected with `CIRCUIT_OPEN`, and every state change bumps an epoch so a slow call admitted in an earlier state cannot close or reopen the circuit when it finally returns. Bank and card each have their own breaker, and the same breaker guards `charge`, `refund` and `statusOf`.

## 6. Refund of a successful payment

```mermaid
sequenceDiagram
  actor R as Receiver
  participant PC as PaymentController
  participant RF as RefundService
  participant PR as PartyResolver
  participant LM as LockManager
  participant WS as WalletPaymentStrategy
  participant DB as Primary DB and repositories
  participant TJ as TransactionJournal
  R->>PC: POST /transactions/{id}/refund with pin
  PC->>PC: verifyPin(requester)
  PC->>RF: refund(id, requester)
  RF->>TJ: find(id) - a third party gets 404 TRANSACTION_NOT_FOUND
  RF->>PR: of(transaction), strategyFor(source)
  RF->>LM: withLock on both wallet keys, in sorted order
  RF->>TJ: require(id) again under the locks
  RF->>RF: assertMayRefund - the payer of a SUCCESS payment gets 403 REFUND_NOT_ALLOWED
  RF->>RF: canBeRefunded (SUCCESS, or FAILED with funds captured)
  RF->>WS: reverse(context)
  WS->>DB: runInTransaction - reload, txn.refund, debit receiver, credit sender, ledger, versioned update with REFUNDED event
  DB-->>WS: COMMIT
  WS-->>RF: REFUNDED
  RF->>TJ: announce - outbox relays REFUNDED, recordWrite(senderId)
  RF-->>R: 200 data.transaction REFUNDED, redacted for the requester
  R->>PC: the same refund again
  PC->>RF: refund(id, requester)
  RF->>TJ: require(id) under the locks - status REFUNDED
  RF-->>R: 409 ILLEGAL_STATE_TRANSITION
```

What to notice: only the receiver can give back a successful payment, and the rule is checked on the transaction re-read under the locks, not on an earlier snapshot. Refunds carry no Idempotency-Key because the state machine makes them idempotent: SUCCESS to REFUNDED happens once, and the strategy re-reads the status in the same unit of work that moves the money. Both wallets are locked, always in sorted key order so two refunds cannot deadlock. If the receiver has already spent the money, `Wallet.debit` throws 422 `INSUFFICIENT_BALANCE` and the unit of work rolls back; for bank or card payments the strategy checks first (and dry-runs the debit) and returns 422 `REFUND_NOT_POSSIBLE` before calling the gateway. Note that `announce` pins the payer, not the receiver who asked for the refund, to the primary (diagram 9a).

## 7. Asynchronous notifications

```mermaid
sequenceDiagram
  participant OR as OutboxRelay
  participant NS as NotificationService
  participant Q as MessageQueue
  participant CH as NotificationChannel
  participant DB as notifications table
  actor Op as Operator
  OR->>NS: NotificationObserver.onTransactionEvent(SUCCESS)
  NS->>NS: NotificationComposer drafts, recipientFor per channel
  NS->>Q: publish job, notificationId = "ntf_" + sha1(txn, user, channel, status)
  Q-->>NS: message id, the payment does not wait
  Q->>NS: deliver(message) on the next tick, at most 4 in flight
  NS->>CH: send(job)
  alt provider succeeds
    CH-->>NS: rendered message
    NS->>DB: upsert SENT, attempts n
  else provider fails, attempt 1 or 2
    CH-->>NS: throws
    NS-->>Q: handler rejects
    Q->>Q: retry after 250 ms, then 500 ms (base times 2 to the attempt minus 1)
  else attempt 3 fails
    Q->>Q: move to the dead-letter list
    Q->>NS: onDeadLetter(message)
    NS->>DB: upsert FAILED, attempts 3
  end
  Op->>Q: POST /api/v1/system/queue/redrive
  Q->>NS: deliver again, attempt reset to 1
  NS->>CH: send(job)
  CH-->>NS: rendered message
  NS->>DB: upsert on the same id - row becomes SENT, no duplicate
```

What to notice: delivery is at-least-once twice over (the outbox may relay an event again after a crash, and the queue retries), so the consumer is made idempotent by the deterministic notification id and the `INSERT ... ON CONFLICT (id) DO UPDATE` in `SqliteNotificationRepository.upsert`. That protects the stored record; a redelivered message would still call the (simulated) provider again. Channels are registered in `src/container.ts` (`NotificationChannelFactory.register`), so a new channel is a new class plus one line there.

## 8. Scheduled payment

```mermaid
sequenceDiagram
  actor C as Client
  participant PC as PaymentController
  participant SP as ScheduledPaymentService
  participant PS as PaymentScheduler
  participant TS as TransferService
  participant DB as scheduled_payments
  C->>PC: POST /scheduled-payments (receiver, amountPaise, delaySeconds or executeAt, pin)
  PC->>PC: verifyPin
  PC->>SP: schedule(user, input)
  SP->>SP: time in the future and within 30 days, receiver exists, source is the user's
  SP->>DB: insert PENDING
  PC-->>C: 201 PENDING
  loop every schedulerIntervalMs (1 s)
    PS->>PS: tick, skipped if the previous run is still going
    PS->>SP: runDue(now)
    SP->>DB: findDue(now, 20)
  end
  SP->>SP: markRunning
  SP->>DB: transition - UPDATE ... SET status RUNNING WHERE status = PENDING
  alt 0 rows (cancelled or taken meanwhile)
    SP->>SP: skip, nothing is paid
  else claimed
    SP->>TS: transfer(idempotencyKey "scheduled:" + id, ...)
    Note over TS: the full pipeline of diagram 1
    alt result without error
      SP->>SP: markExecuted(txn id)
    else result with error or transfer threw
      SP->>SP: markFailed(message, txn id or null)
    end
    SP->>DB: transition - EXECUTED or FAILED WHERE status = RUNNING
  end
```

What to notice: scheduling adds no payment logic of its own; it calls the same `TransferService.transfer` as the API, so limits, fraud rules, locking and the ledger apply at execution time. Run and cancel both use the compare-and-set `ScheduledPaymentRepository.transition(payment, expected)`, so exactly one of them wins. If the process dies while a schedule is RUNNING, start-up reconciliation puts it back to PENDING (diagram 10); the re-run uses the same key `scheduled:<id>`, so it replays the stored result instead of paying again. The PIN is checked once, when the schedule is created.

## 9. Read path

### 9a. History from the replica with read-your-writes and pages

```mermaid
sequenceDiagram
  actor C as Client
  participant PC as PaymentController
  participant QS as TransactionQueryService
  participant RR as ReadRouter
  participant REP as ReplicaDatabase
  participant PRI as PrimaryDatabase
  C->>PC: GET /transactions?limit=20 (later pages add before=nextCursor)
  PC->>QS: history(userId, limit, strong, cursor)
  QS->>RR: route(userId, strong)
  alt consistency=strong
    RR-->>QS: primary
  else user wrote at LSN n and replica.appliedLsn is below n
    RR-->>QS: primary (read-your-writes)
  else nothing pending for this user
    RR->>RR: forget the pin
    RR-->>QS: replica
  end
  QS->>REP: findHistory(reader, userId, limit + 1, decoded cursor) - one joined query, keyset
  QS->>QS: keep limit rows, redactFor each, nextCursor = last row if a further row exists
  PC-->>C: 200 data and page.nextCursor, X-Data-Source replica or primary
  Note over QS,PRI: details(): if the replica has no such row yet, the query is repeated on the primary before answering 404
```

What to notice: `TransactionJournal.open`, `save` and `announce` call `readRouter.recordWrite` for the payer (and `pinReads` does the same for a receiver who has just refunded), pinning that user to the primary until the replica's applied LSN reaches the primary's LSN of that write. The other party to a payment is not pinned and reads the replica, which may be a few hundred milliseconds behind. Pages use a keyset cursor (`created_at`, `id` of the last row, base64url-encoded), so new payments never shift or repeat rows between pages. Views are redacted per viewer.

### 9b. Wallet balance with cache-aside

```mermaid
sequenceDiagram
  participant UC as UserController
  participant US as UserService
  participant CW as CachingWalletRepository
  participant CA as Cache
  participant SW as SqliteWalletRepository
  UC->>US: walletOf(userId) for GET /me
  US->>CW: findByUserId(userId) through FaultInjectingWalletRepository
  CW->>CA: get("wallet:" + userId)
  alt hit
    CA-->>CW: WalletSnapshot
    CW-->>US: Wallet.fromSnapshot
  else miss
    CW->>SW: findByUserId on the primary
    SW-->>CW: Wallet
    CW->>CA: set snapshot (cacheTtlMs 30 s)
    CW-->>US: Wallet
  end
  Note over CW,CA: every save() deletes the key, and money paths use findByUserIdForUpdate, which never reads the cache
```

What to notice: two decorators wrap `SqliteWalletRepository` (`FaultInjectingWalletRepository` around `CachingWalletRepository`), and none of the services knows they exist. Balances shown to the user may come from the cache; balances used to decide a payment never do.

## 10. Start-up reconciliation after a crash

```mermaid
sequenceDiagram
  participant CT as createApplication
  participant RC as ReconciliationService
  participant TR as TransactionRepository
  participant GW as CircuitBreakerGateway
  participant TJ as TransactionJournal
  participant OR as OutboxRelay
  participant IK as idempotency_keys
  participant SC as scheduled_payments
  CT->>CT: openDatabases (migrations), recover() restores gateway charges, queues stuck refunds
  CT->>RC: run() - before seeding and before serving requests
  RC->>TR: findUnfinished() - INITIATED or PROCESSING
  loop each unfinished payment
    alt bank or card funded and funds not yet marked captured
      RC->>GW: statusOf(txn id)
      alt CAPTURED
        GW-->>RC: gatewayTransactionId
        RC->>RC: markFundsCaptured
      else NOT_FOUND or REFUNDED
        GW-->>RC: state
      else gateway unreachable
        GW-->>RC: error
        RC->>RC: undecided, left as it is
      end
    end
    RC->>RC: txn.fail(INTERRUPTED, "money will be returned" or "no money was moved")
    RC->>TJ: save - FAILED with its event, then relay
    Note over TJ: CompensationObserver queues the refund when funds were captured
  end
  RC->>OR: relayAll() - events committed but never published
  RC->>IK: releaseAllInProgress() - keys of requests that died
  RC->>SC: requeueRunning() - RUNNING back to PENDING
  RC-->>CT: ReconciliationReport
```

What to notice: money itself is never half-moved by a crash, because every money movement commits atomically; what a crash leaves behind is bookkeeping in a non-final state, and this job closes it. It never guesses about an external charge: it asks the gateway with `statusOf`, and if the gateway cannot be reached it leaves the payment undecided rather than assume. After a key is released, a client's retry is answered from the now-FAILED transaction (`answerFromStored`). With several app nodes this would have to become a periodic job that only touches rows older than a lease time, as the class comment in `src/service/ReconciliationService.ts` says.

## 11. Sign-in and a Bearer-authenticated request

```mermaid
sequenceDiagram
  actor C as Client
  participant UC as UserController
  participant SS as SessionService
  participant US as UserService
  participant MW as authentication middleware
  C->>UC: POST /api/v1/auth/login with upiId and pin
  UC->>SS: login(upiId, pin)
  SS->>US: findByUpiId(upiId)
  alt unknown UPI ID
    SS-->>C: 401 INVALID_CREDENTIALS
  else known
    SS->>US: verifyPin(user, pin)
    alt wrong PIN
      SS-->>C: 401 INVALID_CREDENTIALS, the same answer as an unknown UPI ID
    else 5 wrong PINs in a row
      SS-->>C: 401 PIN_LOCKED for 60 s
    else correct
      SS->>SS: token = userId.expiryMillis.HMAC-SHA256(userId.expiryMillis)
      UC-->>C: 200 token, expiresAt (30 minutes), user
    end
  end
  C->>MW: GET /api/v1/me with Authorization Bearer token
  MW->>SS: verify(token)
  alt malformed or signature mismatch
    SS-->>C: 401 INVALID_TOKEN
  else expired
    SS-->>C: 401 TOKEN_EXPIRED
  else valid
    SS-->>MW: userId
    MW->>US: authenticate(userId) - unknown 401, blocked 403 ACCOUNT_BLOCKED
    MW->>MW: one token from this user's rate-limit bucket
    MW->>UC: me(req, res)
    UC-->>C: 200 profile, wallet, sources
  end
```

What to notice: the token is stateless (no session table), so any app node holding `sessionSecret` can verify it; without a configured secret a random one is used and tokens die with the process. A Bearer token always wins over `X-User-Id`, and the header is honoured only while `allowHeaderIdentity` is true (the default, for the demo UI). Sign-in answers a wrong PIN exactly like an unknown UPI ID (`INVALID_CREDENTIALS`), so it does not reveal which UPI IDs exist; it uses the same PIN counter as payments, so guessing PINs through `/auth/login` is limited too, and a lockout is still reported as `PIN_LOCKED`.

## Activity diagram of the transfer pipeline

```mermaid
flowchart TD
  start(["POST /api/v1/transfers"]) --> site{"Same site and known Host?"}
  site -- no --> e0["403 CROSS_SITE_REQUEST or HOST_NOT_ALLOWED"]
  site -- yes --> json{"Valid JSON under 16 kB?"}
  json -- no --> e1["400 or 413 INVALID_JSON"]
  json -- yes --> lb{"Healthy app node?"}
  lb -- no --> e2["503 NO_HEALTHY_NODES"]
  lb -- yes --> ip{"Token left for this address?"}
  ip -- no --> e3["429 RATE_LIMIT_EXCEEDED"]
  ip -- yes --> au{"Valid Bearer token, or X-User-Id allowed and known?"}
  au -- no --> e4["401 UNAUTHENTICATED, INVALID_TOKEN or TOKEN_EXPIRED"]
  au -- yes --> act{"User active?"}
  act -- no --> e4b["403 ACCOUNT_BLOCKED"]
  act -- yes --> ur{"Token left for this user?"}
  ur -- no --> e3
  ur -- yes --> pa{"Key not reserved, body fields valid?"}
  pa -- no --> e5["400 IDEMPOTENCY_KEY_RESERVED, MISSING_FIELD, INVALID_AMOUNT, ..."]
  pa -- yes --> pin{"PIN not locked and correct?"}
  pin -- no --> e6["401 PIN_LOCKED or INVALID_PIN"]
  pin -- yes --> key{"Idempotency-Key 8 to 128 chars?"}
  key -- no --> e7["400 IDEMPOTENCY_KEY_REQUIRED"]
  key -- yes --> seen{"Key already used?"}
  seen -- "yes, other body" --> e8["422 IDEMPOTENCY_KEY_REUSED"]
  seen -- "yes, completed" --> rep["Replay stored response"]
  seen -- "yes, in flight" --> wait{"Original finishes within 5 s?"}
  wait -- yes --> rep
  wait -- no --> e9["409 REQUEST_IN_PROGRESS"]
  seen -- "no, claimed" --> old{"Transaction already exists for this key?"}
  old -- yes --> rep2["Answer from the stored transaction, 409 if it is unfinished"]
  old -- no --> res{"Receiver and source found, sender active?"}
  res -- no --> e10["403, 404 or 400, key released, nothing recorded"]
  res -- yes --> ins["Open INITIATED with its event, relay"]
  ins --> lock{"Payer lock within 5 s?"}
  lock -- no --> f1["FAILED LOCK_TIMEOUT 503"]
  lock -- yes --> proc["Database round trip, PROCESSING"]
  proc --> val{"Validation chain passes?"}
  val -- no --> f2["FAILED with the rule's code"]
  val -- yes --> kind{"Source type?"}
  kind -- WALLET --> uow{"Unit of work commits?"}
  uow -- no --> f3["FAILED, rolled back"]
  uow -- yes --> ok["SUCCESS"]
  kind -- "BANK_ACCOUNT or CARD" --> chg{"Gateway charge approved?"}
  chg -- no --> f4["FAILED PAYMENT_DECLINED, GATEWAY_UNAVAILABLE or CIRCUIT_OPEN"]
  chg -- yes --> cr{"Credit unit of work commits?"}
  cr -- yes --> ok
  cr -- no --> comp{"Gateway refund succeeds?"}
  comp -- yes --> f5["REFUNDED, 422 CREDIT_FAILED_REFUNDED"]
  comp -- no --> f6["FAILED with funds captured, 422 CREDIT_FAILED_REFUND_PENDING, retried from the queue"]
  ok --> done["Relay events, store result, 201"]
  f1 --> stored["Relay events, store result, error status plus data.transaction"]
  f2 --> stored
  f3 --> stored
  f4 --> stored
  f5 --> stored
  f6 --> stored
```

Every exit above the "Open INITIATED" box is rejected before anything is recorded (for the exits after the claim, the key is released). Every exit below it is a recorded transaction whose result is stored against the key, so a retry with the same key replays it.

## Transaction lifecycle

The transitions and their triggers come from `src/domain/TransactionState.ts`; the detail text in quotes is what the audit trail stores.

```mermaid
stateDiagram-v2
  [*] --> INITIATED : TransactionBuilder.build, "Payment request accepted"
  INITIATED --> PROCESSING : startProcessing after the payer lock, "Picked up for processing"
  INITIATED --> FAILED : fail, for example LOCK_TIMEOUT or INTERRUPTED
  PROCESSING --> SUCCESS : succeed inside the strategy unit of work, "Money moved and ledger written"
  PROCESSING --> FAILED : fail, validation rule, decline, outage, rollback, CREDIT_FAILED or INTERRUPTED
  SUCCESS --> REFUNDED : refund by the receiver via RefundService and strategy.reverse
  FAILED --> REFUNDED : refund of a captured charge, by the saga, the compensations job or either party
  FAILED --> [*]
  REFUNDED --> [*]
```

Any other call, such as `succeed()` on a FAILED transaction or a second `refund()`, reaches the base class `TransactionState.reject` and throws `IllegalStateTransitionError` (409). SUCCESS is not terminal because it can still be refunded; FAILED is terminal unless `fundsCaptured` is true (`FailedState.isTerminal` returns `!canRefund`), in which case the single FAILED to REFUNDED step is still owed. `INTERRUPTED` is the failure code start-up reconciliation gives to payments a crash left unfinished.
