# Demo guide

This document answers "how do we show this project in ten minutes?" It gives a running order for the evaluation and, for each of the eleven assessment criteria, the document to open, the screen to show and the file that proves it.

## Before you start

```bash
npm install     # once
npm start       # http://localhost:3000
npm test        # the automated suite
npm run race    # four processes fight over one wallet: the double-spend proof
npm run loadtest  # measured throughput and latency, with invariants checked afterwards
npm run crash     # kills the server mid-payment and shows start-up recovery
```

Every seeded user (Alice, Bob, Charlie, Diya Kirana Store, Quick Loan Offers) has the UPI PIN `1234`. To start again from clean data, use "Reset demo data" on the Live system screen.

## A ten-minute running order

| Minute | Screen | Do this | Say this |
|---|---|---|---|
| 0 to 2 | Wallet | As Alice, pay Bob ₹250. Point at "What just happened". | One request, stop by stop: load balancer, rate limiter, PIN, idempotency key, payer lock, the five validation steps, one atomic commit, then notifications and the replica in the background. |
| 2 to 3 | Wallet | Press "Send the same request again". | Same Idempotency-Key, so the stored answer is replayed. No second debit. Open the payment to show the lifecycle and its two ledger entries. |
| 3 to 5 | Scenario lab | Run "Retry storm" and "Double-spend race". | Six copies of one request produce one debit. Five different payments against ₹1,000 produce exactly two successes, and the balance never goes negative. |
| 5 to 6 | Scenario lab | Run "Bank outage and the circuit breaker". | Three failures open the circuit; the fourth call fails instantly without calling the bank; it recovers on its own. |
| 6 to 7 | Scenario lab | Run "Charged at the bank, but the credit fails" and "Notification provider down". | Two systems cannot share a transaction, so the charge is compensated. A broken SMS provider never fails a payment: retry, dead-letter queue, redrive. |
| 7 to 8 | Live system | Stop app-node-2, raise the replica lag, watch the counters. | Stateless nodes, cache hit ratio, replica falling behind and catching up, breaker state. |
| 8 to 9 | Ledger | "Audit the ledger", then "Try to tamper with it". | Append-only, double-entry, hash-chained. The database itself refuses UPDATE, DELETE and REPLACE. |
| 9 to 10 | Design | Open the class diagram and the patterns document. | Each pattern maps to a class; adding a payment method or fraud rule touches no existing class. |

If time is short, "Run every scenario" in the Scenario lab runs all checks in about a minute and prints a pass count.

## Where each assessment criterion is shown

| # | Criterion | Document | Live proof | Code to open |
|---|---|---|---|---|
| 1 | Requirement analysis | `01-requirements.md` | Wallet screen covers the use cases | `src/api/createHttpApp.ts` (every use case is a route) |
| 2 | Class diagram | `02-class-diagram.md` | Design screen | `src/domain/` |
| 3 | Object-oriented design | `03-oop-and-solid.md` | Pay from wallet, bank and card: same flow, different behaviour | `src/domain/PaymentSource.ts`, `src/domain/Wallet.ts` |
| 4 | SOLID principles | `03-oop-and-solid.md` | Live system, "What is plugged in" | `src/container.ts`, `src/repository/interfaces.ts` |
| 5 | Design patterns | `04-design-patterns.md` | The trace names the strategy, each validation handler and each state change | `src/payment/`, `src/validation/`, `src/domain/TransactionState.ts`, `src/events/` |
| 6 | Sequence and activity diagrams | `05-sequence-diagrams.md` | "What just happened" is the sequence diagram, live | `src/service/TransferService.ts` |
| 7 | API and interface design | `06-api-design.md`, `openapi.yaml` | Browser network tab; response headers `X-Served-By`, `X-Data-Source`, `Idempotent-Replayed` | `src/api/`, `src/service/`, `src/repository/` |
| 8 | Database schema | `07-database-schema.md` | Ledger screen; `data/primary.db` opens in any SQLite browser | `src/infrastructure/db/schema.ts` |
| 9 | Error handling and edge cases | `08-error-handling-and-edge-cases.md` | Scenario lab, all groups | `src/domain/errors.ts`, `src/api/middleware.ts` |
| 10 | Working implementation | this guide, `11-load-and-concurrency-evidence.md` | The whole app; `npm test`, `npm run race`, `npm run loadtest` | `src/` mirrors the documents folder by folder |
| 11 | Simple, good UI | | Wallet, Scenario lab, Live system, Ledger, Design | `public/` |

## Questions evaluators tend to ask

**"What happens if the user taps Pay twice?"** Each tap in the app is a new payment with a new key, as it should be. A retry of the same request (network timeout, app resend) carries the same key and is answered from the idempotency store. Show "Send the same request again".

**"Two payments at the same instant?"** They queue behind the payer's lock. The second one validates against the balance the first one left. Behind the lock are three more guards: the domain object, optimistic versions and a database CHECK. Show "Double-spend race".

**"Node is single-threaded. Is your concurrency control real?"** Inside one process, payments interleave only at an `await`, and the payer lock covers that. To show the design does not depend on the single thread, run `npm run race`: four operating-system processes pay from one wallet at once, without the in-process lock, and exactly ten of forty payments succeed. The database guards (one writer at a time, the re-read balance, versions, the CHECK) are what hold. Results are in `11-load-and-concurrency-evidence.md`.

**"How much load does it take?"** Measured, not estimated: about 8,600 balance reads and 276 payments per second on one core, CPU-bound, with two thirds of a payment's cost being the PIN hash. `11-load-and-concurrency-evidence.md` has the table, the bottleneck analysis and what to change first.

**"What if the server crashes halfway through a payment?"** Money cannot be half-moved, because the debit, credit, ledger entries, status and event commit together. What can be left is bookkeeping, and `ReconciliationService` closes it at the next start (run `npm run crash` to watch it): it asks the gateway whether a bank charge happened, fails the payment, queues a refund if money was captured, announces events that were committed but never published, and releases stuck keys and schedules.

**"Why a queue for notifications?"** So a slow or broken provider cannot slow or fail a payment, and so delivery can retry. Show that the payment responds just as fast while the provider is down.

**"Is the replica not stale?"** Yes, by a few hundred milliseconds, and that is acceptable for history. It is never used for money decisions, and a user who has just paid is routed to the primary until the replica has caught up with their write. Show "Read replica lag and read-your-writes".

**"How would you add UPI Lite or a new fraud rule?"** One new class implementing `PaymentStrategy` or `FraudRule`, and one line in `src/container.ts`. Scheduled payments were added exactly this way: `ScheduledPaymentService` calls the existing transfer service and no payment code changed.

**"What is not production-ready?"** The list at the end of `09-architecture-and-scaling.md`: in-process cache, queue and locks; synchronous storage interfaces; a simulated bank; recovery that assumes a single process; no partial refunds.

## Fault injection reference

All controls are on the Live system screen and also available as `PUT /api/v1/system/chaos`.

| Control | Effect | Scenario that uses it |
|---|---|---|
| Bank network is down | Every bank call fails; the breaker opens after three | Bank outage |
| Bank failure rate | A share of bank calls time out | |
| Bank response time | Slows bank-funded payments, which makes lock waits visible | |
| Database round trip | Time a payment holds the payer lock while "talking to the database" | Double-spend race |
| Replica lag | How far history reads trail writes | Read replica lag |
| Notification failure rate | Deliveries fail, retry and dead-letter | Notification provider down |
| Fail the next wallet credit | The next bank or card payment is charged, fails to credit and is refunded | Saga |
| Stop / Start on an app node | The load balancer routes around it | An app server dies |
