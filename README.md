# Mini UPI Wallet

A simplified UPI wallet backend with a small web UI, built as a system design (low-level design) project. Users hold a wallet, link a bank account or card, and send money to each other. The interesting part is what happens around each payment:

- **Idempotent**: a retried request never debits twice.
- **Safe under concurrency**: two payments cannot spend the same balance.
- **Validated**: account status, source limits, funds, daily limit and fraud rules, as a chain.
- **A clear lifecycle**: Initiated → Processing → Success or Failed → Refunded.
- **Recorded in an immutable ledger**: append-only, double-entry, hash-chained.
- **Asynchronous notifications**: SMS, push and email through a queue with retries and a dead-letter queue.
- **Crash-safe**: events are stored with the state change (outbox) and unfinished work is reconciled at start-up.
- **Built to scale**: stateless app nodes behind a load balancer, a cache, a read replica, rate limiting and circuit breakers.

It is a prototype meant to show the design working. The cache, queue, lock manager, read replica, load balancer and bank network run in-process behind interfaces, so the project starts with one command and no external services. `docs/09-architecture-and-scaling.md` maps each of them to its production equivalent.

## Run it

Requires Node.js 22.13 or newer. Nothing else.

```bash
npm install
npm start
```

Open http://localhost:3000. Every seeded user has the UPI PIN `1234`.

```bash
npm test          # automated test suite
npm run race      # four processes pay from one wallet at once: the double-spend proof
npm run loadtest  # measured throughput and latency, with money invariants checked afterwards
npm run crash     # kills the server in the middle of a payment, restarts it, shows the recovery
npm run typecheck # TypeScript, no emit
npm run dev       # restart on file changes
```

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Interface to listen on. Loopback only by default; `0.0.0.0` shares it on your network |
| `DATA_DIR` | `data` | Where `primary.db` and `replica.db` live |
| `REPLICA_LAG_MS` | `400` | How far the read replica trails the primary |
| `SEED_DEMO_DATA` | `true` | Create the demo users and payments on an empty database |
| `ALLOW_HEADER_IDENTITY` | `true` | Demo convenience: accept `X-User-Id`. Set `false` to require a session token from `POST /api/v1/auth/login` |
| `SESSION_SECRET` | random per start | Secret that signs session tokens |
| `OPERATOR_KEY` | unset | When set, state-changing operator endpoints need it in `X-Operator-Key` |
| `FAULT_INJECTION` | `true` | Demo switch for "fail the next wallet credit". Set `false` to leave the fault-injecting decorator out |

To start over, delete the `data/` folder or use "Reset demo data" on the Live system screen. An existing database is upgraded in place by versioned migrations, and anything a crash left half-done is reconciled at start-up.

## What you will see

| Screen | What it shows |
|---|---|
| **Wallet** | Balance, linked sources, send money, add money, schedule a payment, history with lifecycle and ledger entries, refunds, notifications. Next to it, "What just happened": every stop your last request made inside the system. |
| **Scenario lab** | Twenty scenarios that call the real API from the browser and check the result: retry storms, double-spend races, fraud rules, PIN guessing, bank outage, saga refund, dead-letter queue, replica lag, rate limiting and more. |
| **Live system** | The components a payment passes through, with live counters, and switches to break them: take the bank down, stop an app node, slow the replica. |
| **Ledger** | The append-only ledger with its hash chain, an audit button and a tamper test. |
| **Design** | The design documents below, rendered with their diagrams. |

## Design documents

| Document | Covers |
|---|---|
| `docs/01-requirements.md` | Functional and non-functional requirements, actors, use cases |
| `docs/02-class-diagram.md` | Entities, attributes, methods, relationships and multiplicities |
| `docs/03-oop-and-solid.md` | Abstraction, encapsulation, inheritance, polymorphism; where each SOLID principle is applied |
| `docs/04-design-patterns.md` | Strategy, Chain of Responsibility, State, Observer, Factory, Builder, Singleton, Decorator, Template Method and why each was chosen |
| `docs/05-sequence-diagrams.md` | Sequence and activity diagrams for the core flows |
| `docs/06-api-design.md` | Endpoints, request and response shapes, layers and internal interfaces |
| `docs/07-database-schema.md` | Tables, keys, indexes, constraints, replication |
| `docs/08-error-handling-and-edge-cases.md` | Error model, validation layers, concurrency and failure scenarios |
| `docs/09-architecture-and-scaling.md` | Components, production mapping, consistency, capacity, scaling path, known limits |
| `docs/10-demo-guide.md` | A ten-minute demo order and where each assessment criterion is shown |
| `docs/11-load-and-concurrency-evidence.md` | Measured throughput and latency, the multi-process double-spend race, bottleneck analysis |
| `docs/openapi.yaml` | Machine-readable description of the REST API |

## How the code is organised

```
src/
  main.ts               start-up
  container.ts          composition root: the only place concrete classes are chosen and wired
  config/               AppConfig (Singleton)
  domain/               User, Wallet, Money, PaymentSource hierarchy, Transaction + State + Builder, LedgerEntry, errors
  payment/              PaymentStrategy (wallet, bank, card), factory, gateways, circuit-breaker decorator
  validation/           Chain of Responsibility handlers and fraud rules
  events/               Observer: event publisher and observers; transactional outbox relay
  notification/         channels (SMS, push, email), factory, queue producer and workers
  service/              TransferService, RefundService, IdempotencyService, LedgerService, UserService, sessions,
                        scheduling, start-up reconciliation
  repository/           repository interfaces, SQLite implementations, caching decorator
  readmodel/            response shapes (DTOs)
  infrastructure/       database + replica, cache, queue, locks, rate limiter, load balancer, circuit breaker, tracing
  api/                  Express app, middleware, controllers, request parsing
public/                 the web UI (plain HTML, CSS and JavaScript modules, no build step)
scripts/                load test and multi-process race
tests/                  node:test suites
docs/                   design documents
```

Dependencies point inwards: `api` → `service` → `domain`, with `repository` and `infrastructure` implementing interfaces the services depend on.

## The life of one payment

```
POST /api/v1/transfers   (X-User-Id, Idempotency-Key, PIN in the body)

 1. Same-site guard, request id, load balancer picks a node, rate limits
 2. PIN verified (locks after 5 wrong attempts)
 3. Idempotency: claim the key, or replay the stored answer
 4. Transaction created as INITIATED
 5. Payer lock acquired; PROCESSING
 6. Validation chain: account status → source → funds → daily limit → fraud rules
 7. Payment strategy for the source:
      wallet      debit + credit + 2 ledger entries + SUCCESS in one database transaction
      bank, card  charge through a circuit breaker, then credit; refund the charge if the credit fails
 8. Events (stored with the status, in the outbox) relayed to observers: notifications queued, metrics counted
 9. Response sent; queue workers deliver SMS, push and email; the replica catches up
```

## API in one glance

```bash
# who is there
curl -s localhost:3000/api/v1/users

# pay (replace the ids; run it twice with the same key to see the replay)
curl -s -X POST localhost:3000/api/v1/transfers \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: <alice id>' \
  -H 'Idempotency-Key: 6b1f4c0e-demo-0001' \
  -d '{"receiverUpiId":"bob@miniupi","amount":250,"pin":"1234","note":"Dinner"}'
```

The full reference is in `docs/06-api-design.md`.

## Scope

This is a teaching prototype, not a payment system. The bank is simulated, the supporting infrastructure runs in one process, and the demo UI identifies users with a header (signed session tokens are available and can be made mandatory). `docs/09-architecture-and-scaling.md` ends with the complete list of known limits and what production would do about each.
