# Load and concurrency evidence

This document answers "does it actually hold up, and how do you know?" It reports measured throughput and latency from a load test, a double-spend race run across separate operating-system processes, and what both say about where the system would have to change to carry real traffic. Every number here can be reproduced with one command.

## How to reproduce

```bash
npm run loadtest          # about 40 seconds; prints the table below
npm run loadtest -- 10    # 10 seconds per scenario instead of 5
npm run race              # the multi-process double-spend race
npm run crash             # kills the server in the middle of a payment and shows the recovery
npm test                  # the automated suite, including concurrency tests
```

Both scripts are in `scripts/` and exit with a non-zero code if any invariant fails.

## Load test

### Set-up

- `scripts/loadtest.ts` starts the server in its own process, on a real port, with a file-backed database and replica. A second process generates the load over HTTP.
- 200 users, each with ₹50,000 loaded through the normal top-up path.
- Limits that exist to stop abuse are raised (rate limits, the payment-velocity fraud rule, PIN lockout), so the test measures capacity and not the limiter. Everything else is the normal code path: PIN verification, idempotency, payer lock, validation chain, atomic commit, ledger, outbox, notifications, replication.
- Bank and notification latency are zero. The database round trip is zero except where a scenario sets it.
- Machine: Apple M2, 8 cores, Node 22. Client and server share the machine. 5 seconds per scenario.

### Results

| Scenario | Concurrent clients | Requests per second | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| Read balance (served from the cache) | 50 | 8,627 | 5.3 | 9.9 | 14 |
| Read history (served from the replica) | 50 | 6,444 | 7.1 | 13 | 16 |
| Pay, 200 different payers | 50 | 276 | 165 | 296 | 337 |
| Pay, 200 payers, 5 ms database round trip | 50 | 276 | 168 | 308 | 359 |
| Pay, one payer only, 5 ms database round trip | 50 | 146 | 335 | 364 | 434 |
| Retry storm: every payment sent 3 times at once | 16 | 345 (115 payments) | 130 | 213 | 269 |

No request returned a 5xx in any scenario.

### Invariants checked after the load

About 4,200 payments were executed during the run. Afterwards the script verifies:

| Invariant | Result |
|---|---|
| No money created or lost: the 200 wallets still total ₹1,00,00,000 | Pass |
| No wallet went negative | Pass |
| Every accepted payment was executed exactly once (SUCCESS rows equal accepted payments) | Pass: 4,221 and 4,221 |
| Retry storms never paid twice: 595 payments sent three times produced 1,190 replays and 595 debits | Pass |
| Ledger hash chain intact over 8,842 entries | Pass |
| Debits equal credits for every transaction; every wallet equals the sum of its ledger entries | Pass |

### What the numbers mean

**Reads are cheap; payments are CPU-bound on one core.** A separate measurement of one payment's cost, with no HTTP in the way:

| Step | Cost |
|---|---|
| Verifying the UPI PIN (scrypt) | 1.98 ms |
| Everything else in a wallet payment on a file database (12 commits, 19 writes) | 0.96 ms |
| The same on an in-memory database | 0.40 ms |

That is about 3 ms of CPU per payment, so one single-threaded process cannot exceed roughly 330 payments per second. The measured 276 is that ceiling minus HTTP overhead. Two thirds of it is the PIN hash.

**Latency under load is queueing, not slowness.** With 50 clients and 276 payments per second, each request waits for about 50 / 276 = 180 ms. The p50 of 165 ms is exactly that queue. One payment on an idle server takes about 3 ms.

**Waiting on the database does not cost throughput when payers differ.** Adding a 5 ms round trip left the many-payer throughput unchanged (276 before and after): the wait is not CPU, so other payers' requests run during it. This is the property that lets a real, networked database be used without the app tier stalling.

**One payer is deliberately serialised.** With every payment coming from the same wallet, throughput dropped to 146 per second and the lock recorded several hundred waits. That is the payer lock doing its job: one payment at a time per payer. It costs nothing for normal users, who do not pay 146 times a second.

**A finding from the test itself.** When a scenario needed more connections than were already open, a few requests took 3 to 4 seconds. Reusing existing connections removed the tail completely (p99 269 ms). The cause is the server's single thread being busy with synchronous hashing while new connections wait to be accepted. It is one more reason the PIN hash should leave the main thread.

### From these numbers to the target

`09-architecture-and-scaling.md` plans for a peak of about 3,000 payments per second.

| Change | Effect | Why |
|---|---|---|
| Run more app nodes | 276 per second per core, so about 11 cores for 3,000 per second | Nodes are stateless; this needs a shared cache, queue and lock, which is what the interfaces are for |
| Hash the PIN off the main thread (asynchronous scrypt) | Removes two thirds of the per-payment CPU from the event loop and the connection-accept stall | The hash is the single largest cost and is blocking |
| Fewer commits per payment | 12 commits today; the idempotency claim, the INITIATED row and the outbox marks could be batched | Each commit is a separate write to the log |
| A networked database | Adds latency per payment but not CPU on the app node | Shown by the 5 ms scenario |

The write path is the constraint, as expected for a payment system. Reads already run at thousands per second on one core and scale further with replicas and the cache.

## Double-spend race across processes

### Why this test exists

The app server is single-threaded. Inside one process, two payments can only interleave at an `await`, and the payer lock closes that gap. A fair question is whether the design is safe only because of that single thread.

`scripts/multiprocess-race.ts` removes it. Four separate processes open the same database file and pay from the same wallet at the same moment. They do not use the payer lock at all, because a lock in one process means nothing to another. What is left is what sits behind the lock:

| Guard | Where |
|---|---|
| One writer at a time, across processes | `BEGIN IMMEDIATE` in `PrimaryDatabase.runInTransaction`, with `busy_timeout` |
| The balance is re-read inside the transaction and cannot go below zero | `Wallet.debit` in `WalletPaymentStrategy.pay` |
| A write based on a stale read is rejected | `version` column on `wallets` and `transactions` |
| Last line of defence | `CHECK (balance_paise >= 0)` |
| Only one process can claim an idempotency key | Primary key on `idempotency_keys` |

### Result

Wallet holds ₹1,000. Four processes each try ten payments of ₹100 (40 attempts, room for 10).

| Check | Result |
|---|---|
| Exactly 10 payments succeeded, spread across the processes (for example 3, 4, 3 and 0) | Pass |
| Payer balance is exactly zero, never negative | Pass |
| Payee received exactly ₹1,000 | Pass |
| All 30 refusals were `INSUFFICIENT_BALANCE` | Pass |
| Ledger hash chain intact, although four processes appended to it | Pass |
| Debits equal credits; wallet balances equal their ledger sums | Pass |
| Exactly one of the four processes claimed a shared idempotency key | Pass |

The run was repeated; the split of the ten successes between processes changed each time and every check passed each time.

### What it proves and what it does not

It proves that correctness does not depend on the single thread or on the in-process lock: the database-level guards alone prevent a double spend and a double claim under real parallelism.

It does not prove that the full service is ready to run as several processes. The cache, the queue, the rate limits, the PIN counters and the payer lock are per process. The lock still matters across nodes, because it is what makes the daily-limit and velocity checks see a consistent view; with several nodes it has to be a shared lock. That is the first row of the known limits in `09-architecture-and-scaling.md`.

## Crash in the middle of a payment

`scripts/crash-recovery-demo.ts` starts a bank-funded payment against a bank that takes three seconds to answer, kills the server process with `SIGKILL` while that call is in flight, and starts a new process on the same database.

| Moment | Transaction | Idempotency key |
|---|---|---|
| Right after the crash | PROCESSING | IN_PROGRESS |
| After the restart | FAILED, code `INTERRUPTED` | released at start-up, then COMPLETED by the retry |

What the new process did, as reported by `ReconciliationService`: one interrupted payment closed, zero charges found captured at the gateway (it asked), one stuck key released. The client's retry with the same key received the recorded outcome ("The service restarted before this payment finished. No money was moved."), the lifecycle on record reads INITIATED, PROCESSING, FAILED, the ledger has no entries for it, and the ledger audit is healthy.

## Limits of this evidence

- One machine, loopback networking, short runs. These are order-of-magnitude figures, not a benchmark.
- The load generator shares the machine with the server and takes CPU from it.
- The bank and the notification providers are simulated with zero latency; real ones add waiting time (not CPU) to bank-funded payments.
- SQLite is in-process. A networked database would move the numbers, in the direction the 5 ms scenario shows.
