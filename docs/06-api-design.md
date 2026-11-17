# API and interface design

This document describes the contract of the system at two levels: the HTTP API that clients call, and the internal interfaces (service methods and ports) that keep the layers independent of each other. It answers "what can a client send, what comes back, and which class is responsible for what". All request and response examples below were captured with `curl` from the running dev server and only re-indented or shortened where stated. A machine-readable OpenAPI 3.0 description of every route is in `docs/openapi.yaml`; measured throughput, a multi-process race and a live crash-recovery run are in `11-load-and-concurrency-evidence.md`.

## Layering

```mermaid
flowchart TD
  root["Composition root: src/main.ts, src/container.ts"]
  api["API layer: src/api"]
  svc["Service layer: src/service, src/payment, src/validation, src/events, src/notification"]
  dto["Read model DTOs: src/readmodel/views.ts"]
  repo["Repository layer: src/repository"]
  dom["Domain: src/domain"]
  infra["Infrastructure: src/infrastructure"]
  root --> api
  root --> svc
  root --> repo
  root --> infra
  api --> svc
  api --> dto
  svc --> repo
  svc --> dto
  svc --> dom
  svc -. "ports: Cache, LockManager, UnitOfWork, MessageQueue" .-> infra
  repo --> dom
  repo -. "SqlReader, SqlWriter, UnitOfWork, Cache" .-> infra
  dto --> dom
  infra -. "error classes only" .-> dom
```

Arrows point from the user of a module to the module it uses. The rules the code follows: `src/domain/` imports nothing outside itself and knows nothing about HTTP (errors carry a category, and `src/api/httpStatus.ts` turns it into a status code); nothing imports `src/api/`; controllers never import a repository; services receive repositories and infrastructure as interfaces through their constructors; `src/container.ts` chooses the concrete classes (the HTTP layer builds its own controllers). The API layer also uses a few infrastructure types directly (`LoadBalancer`, `RateLimiter`, `tracer`, and `PrimaryDatabase` for the ledger audit endpoint), because that is edge and operator plumbing rather than business logic.

| Layer | Responsible for | Not responsible for | Files |
|---|---|---|---|
| API | Routing, middleware order, same-site, identity, operator-key and rate-limit guards, parsing untrusted JSON into typed values, calling one service method, response envelope and headers, mapping error categories to status codes | Business rules, database access, deciding what a valid payment is | `src/api/createHttpApp.ts`, `middleware.ts`, `controllers.ts`, `requests.ts`, `httpStatus.ts` |
| Service | Orchestrating use cases: sign-in, idempotency, locking, validation chain, payment strategies, refunds and compensations, scheduling, read routing, PIN checks, recording and announcing state changes, start-up reconciliation | HTTP details, SQL, how a cache or queue is implemented | `src/service/*.ts`, `src/payment/`, `src/validation/`, `src/events/`, `src/notification/` |
| Read model | Plain response shapes (DTOs), the mapping functions, and per-viewer redaction | Behaviour beyond shaping data | `src/readmodel/views.ts` |
| Repository | Persisting and loading aggregates (a transaction together with its audit and outbox rows), the joined and paginated read queries, optimistic locking, compare-and-set on schedules, cache-aside for wallets | Business decisions | `src/repository/interfaces.ts`, `src/repository/sqlite/*.ts`, `src/repository/CachingWalletRepository.ts` |
| Domain | Entities, value objects and invariants: `Money`, `Wallet.debit`, the `TransactionState` machine, `ScheduledPayment` states, `PaymentSource` polymorphism, the error hierarchy and `ErrorCategory` | Persistence, I/O, HTTP | `src/domain/*.ts` |
| Infrastructure | Technical stand-ins behind ports: SQLite primary and replica with migrations, replication, cache, queue, lock, rate limiter, load balancer, circuit breaker, chaos and the fault-injecting wallet decorator, tracing, metrics | Knowing about users, wallets or payments | `src/infrastructure/**` |

## Conventions

**Base path and versioning.** The public API lives under `/api/v1`, the operator and demo API under `/api/v1/system`. There is one version today; a breaking change would get a new `Router` mounted at `/api/v2` in `src/api/createHttpApp.ts`. `GET /health` sits outside the versioned API. The server listens on `settings.host`, `127.0.0.1` by default (environment variable `HOST`).

**Middleware order** (from `createHttpApp`): `securityHeaders` on every response; `sameSiteOnly` on everything under `/api` (403 `HOST_NOT_ALLOWED` for an unknown `Host`, 403 `CROSS_SITE_REQUEST` for a cross-site `Origin` or `Sec-Fetch-Site`; command-line clients send neither and pass); `express.json({ limit: '16kb' })`; then the operator router at `/api/v1/system` with `operatorOnly` in front; then, for the rest of `/api/v1`, `requestContext` (request id and trace), `loadBalancing`, `addressRateLimiting` (a token bucket per client address); then per route `authentication` (identify the caller, then one token from that user's bucket), the controller, and finally `errorHandler`. Operator calls are therefore not load balanced, not rate limited and carry no request id.

**Sign-in and identity.** `POST /api/v1/auth/login` with `{ "upiId", "pin" }` returns a session token that is valid for `sessionTtlMs` (30 minutes). The token is `<userId>.<expiryMillis>.<signature>`, the signature an HMAC-SHA256 with `sessionSecret` (`src/service/SessionService.ts`); it is stateless, so any node with the secret can verify it. Authenticated routes accept `Authorization: Bearer <token>`, which always wins. The `X-User-Id: <user id>` header is accepted as well while the setting `allowHeaderIdentity` is true (the default, so the demo UI can switch users; environment variable `ALLOW_HEADER_IDENTITY=false` turns it off). Failures: 401 `INVALID_CREDENTIALS` (unknown UPI ID or wrong PIN at sign-in, deliberately the same answer), `PIN_LOCKED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `UNAUTHENTICATED` (no usable identity), and 403 `ACCOUNT_BLOCKED` for a blocked user.

**Operator key.** When the setting `operatorKey` (environment variable `OPERATOR_KEY`) is non-empty, every non-GET route under `/api/v1/system` requires `X-Operator-Key: <key>`, compared in constant time, else 403 `OPERATOR_KEY_REQUIRED`. Read-only operator routes stay open so dashboards keep working. The default is empty: open to whoever can reach the server, which is loopback only by default.

**UPI PIN.** Every call that moves or commits money sends `"pin"` in the JSON body: `POST /transfers`, `POST /wallet/topup`, `POST /transactions/:id/refund`, `POST /scheduled-payments`. `UserService.verifyPin` compares it with a salted scrypt hash (`src/domain/PinHasher.ts`). A wrong PIN gives 401 `INVALID_PIN` with `details.attemptsLeft`; after `pinMaxAttempts` (5) wrong PINs, PIN entry is refused for `pinLockMs` (60 s) with 401 `PIN_LOCKED`, even if the next PIN is right. Sign-in uses the same check and counter but reports a wrong PIN as `INVALID_CREDENTIALS`.

**Idempotency-Key.** Required on `POST /transfers` and `POST /wallet/topup`: 8 to 128 characters, for example a UUID, the same value on every retry of one payment; keys starting with `scheduled:` are reserved for the scheduler (400 `IDEMPOTENCY_KEY_RESERVED`). Keys are scoped per user (`PRIMARY KEY (user_id, idem_key)`). A repeat with the same body returns the stored response with `Idempotent-Replayed: true` (200 for a stored success, the stored status for a stored failure); a repeat with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`; a repeat while the first is still running waits for it. Flows are in `05-sequence-diagrams.md`, diagrams 2a to 2c.

**Money.** Request bodies should carry `amountPaise`, a whole number of paise, which cannot suffer from floating point. `amount` in rupees (at most two decimals) is still accepted; when both are present `amountPaise` is used. Both forms of the same value are the same request for idempotency. Responses carry both `amount` (rupees) and `amountPaise`. Internally every amount is a `Money` holding integer paise (`src/domain/Money.ts`), and the database stores `INTEGER` paise. Error details use paise (`availablePaise`, `limitPaise`). Amounts must be above zero and at most ₹10,00,000 (`MAX_AMOUNT_RUPEES` in `src/api/requests.ts`).

**Text fields.** Names, bank names and notes are shown to other people, so `plainText` in `src/api/requests.ts` refuses control and format characters and `<` `>` (400 `INVALID_FIELD`).

**Response envelope.** Success: `{ "data": ... }`, plus `"page": { "nextCursor" }` on paginated lists. Failure: `{ "error": { "code", "message", "details"?, "requestId"? } }`, where `code` is stable and machine readable and `details` is present only when the error carries some. A payment that was accepted and then failed is still a recorded transaction, so it returns both: `{ "error": {...}, "data": { "transaction": {...} } }` (`PaymentController.respond`).

**Pagination.** `GET /transactions` is cursor-paginated, newest first: the response has `page.nextCursor`, an opaque string, or `null` on the last page; pass it back as `?before=<nextCursor>` for the next, older page. The cursor encodes the `created_at` and `id` of the last row shown (keyset pagination), so rows are never skipped or repeated when new payments arrive. A cursor that cannot be decoded is 400 `INVALID_CURSOR`. `?limit=` must be a positive integer and is clamped to a maximum (20 default and 100 max for history, 15 and 50 for notifications). `?consistency=strong` forces a read to the primary.

**Response headers.**

| Header | When | Meaning |
|---|---|---|
| `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy` | Every response | Browser protections from `securityHeaders` (scripts only from `'self'`, `nosniff`, `no-referrer`) |
| `X-Request-Id` | Every `/api/v1` request that reaches `requestContext` (not `/api/v1/system`, not same-site or JSON-parse rejections) | Request id, also in `error.requestId`; the trace is at `GET /api/v1/system/traces/:id` |
| `X-Served-By` | Same | Logical app node picked by round robin, `app-node-1` to `app-node-3` |
| `X-RateLimit-Remaining` | Authenticated routes only | Whole tokens left in this user's bucket (capacity 30, refill 15 per second) |
| `Retry-After` | Only on 429 | Seconds until a token is available |
| `Idempotent-Replayed` | `POST /transfers`, `POST /wallet/topup` | `true` if this is the stored answer of an earlier request |
| `X-Data-Source` | `GET /transactions`, `GET /transactions/:id`, `GET /notifications`, `GET /system/ledger` | `primary` or `replica`: which database answered |

**Error categories and status codes.** Errors in the domain carry an `ErrorCategory` (`src/domain/errors.ts`), never a status code. The only translation table is `statusFor` in `src/api/httpStatus.ts`, used by `errorHandler` and by `PaymentController.respond`:

| `ErrorCategory` | HTTP | Typical codes |
|---|---|---|
| `INVALID_INPUT` | 400 | `MISSING_FIELD`, `INVALID_AMOUNT`, `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REQUIRED` |
| `UNAUTHENTICATED` | 401 | `UNAUTHENTICATED`, `INVALID_PIN`, `PIN_LOCKED`, `INVALID_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED` |
| `DECLINED` | 402 | `PAYMENT_DECLINED` |
| `FORBIDDEN` | 403 | `FRAUD_SUSPECTED`, `ACCOUNT_BLOCKED`, `REFUND_NOT_ALLOWED`, `CROSS_SITE_REQUEST`, `OPERATOR_KEY_REQUIRED` |
| `NOT_FOUND` | 404 | `RECEIVER_NOT_FOUND`, `TRANSACTION_NOT_FOUND` (also "exists but not yours") |
| `CONFLICT` | 409 | `ILLEGAL_STATE_TRANSITION`, `REQUEST_IN_PROGRESS`, `CONCURRENT_MODIFICATION` |
| `RULE_VIOLATION` | 422 | `INSUFFICIENT_BALANCE`, `DAILY_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`, `CREDIT_FAILED_REFUNDED` |
| `RATE_LIMITED` | 429 | `RATE_LIMIT_EXCEEDED` |
| `INTERNAL` | 500 | `INTERNAL_ERROR` |
| `UNAVAILABLE` | 503 | `GATEWAY_UNAVAILABLE`, `CIRCUIT_OPEN`, `LOCK_TIMEOUT`, `NO_HEALTHY_NODES` |

Two responses do not come from a `DomainError`: 400 or 413 `INVALID_JSON` from the body parser, and 404 `ROUTE_NOT_FOUND`. The full code list is in `08-error-handling-and-edge-cases.md`.

## Endpoint reference: public API

"Auth" means a Bearer token or, while allowed, `X-User-Id` (every Auth route can also answer 401 `UNAUTHENTICATED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, 403 `ACCOUNT_BLOCKED` and 429); "PIN" means the body PIN (adding 401 `INVALID_PIN` and `PIN_LOCKED`); "Key" means the `Idempotency-Key` header.

| Method | Path | Auth | Purpose | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/api/v1/auth/login` | none | Sign in with UPI ID and PIN, get a session token | 200 | 400 `MISSING_FIELD`; 401 `INVALID_CREDENTIALS` (unknown UPI ID or wrong PIN), `PIN_LOCKED` |
| POST | `/api/v1/users` | none | Register: user, wallet and wallet source in one unit of work | 201 | 400 `INVALID_NAME`, `INVALID_PHONE`, `INVALID_PIN`, `INVALID_UPI_HANDLE`, `INVALID_FIELD`; 409 `UPI_ID_TAKEN`, `PHONE_TAKEN` |
| GET | `/api/v1/users` | none | List all users (the demo's user picker) | 200 | none |
| GET | `/api/v1/users/resolve?upiId=` | none | Look up a payee by UPI ID (cached) | 200 | 400 `MISSING_FIELD`; 404 `UPI_ID_NOT_FOUND` |
| GET | `/api/v1/me` | Auth | Profile, wallet balance (cache-aside), linked sources | 200 | none beyond Auth |
| POST | `/api/v1/payment-sources/bank-accounts` | Auth | Link a bank account (only the last 4 digits are kept) | 201 | 400 `INVALID_BANK_NAME`, `INVALID_ACCOUNT_NUMBER`, `INVALID_IFSC`, `INVALID_FIELD` |
| POST | `/api/v1/payment-sources/cards` | Auth | Link a card (Luhn check, expiry) | 201 | 400 `INVALID_CARD_NETWORK`, `INVALID_CARD_NUMBER`, `INVALID_EXPIRY`; 422 `CARD_EXPIRED` |
| POST | `/api/v1/transfers` | Auth, PIN, Key | Send money to a UPI ID from the wallet or a linked source | 201, replay 200 | 400 `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_RESERVED`, `INVALID_AMOUNT`; 404 `RECEIVER_NOT_FOUND`, `SOURCE_NOT_FOUND`; 422 `INSUFFICIENT_BALANCE`, `DAILY_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`, `CREDIT_FAILED_REFUNDED`, `CREDIT_FAILED_REFUND_PENDING`; 403 `FRAUD_SUSPECTED`; 402 `PAYMENT_DECLINED`; 409 `REQUEST_IN_PROGRESS`; 503 `GATEWAY_UNAVAILABLE`, `CIRCUIT_OPEN`, `LOCK_TIMEOUT` |
| POST | `/api/v1/wallet/topup` | Auth, PIN, Key | Load your own wallet from a linked bank or card (`sourceId` required) | 201, replay 200 | as transfers; 422 `SELF_TRANSFER` if the source is the wallet itself |
| GET | `/api/v1/transactions?limit=&before=&consistency=` | Auth | History as sender or receiver, one page at a time, replica by default, redacted per viewer | 200 | 400 `INVALID_LIMIT`, `INVALID_CURSOR` |
| GET | `/api/v1/transactions/:id` | Auth | One transaction with its state timeline and ledger entries, redacted per viewer | 200 | 404 `TRANSACTION_NOT_FOUND` (also for non-parties) |
| POST | `/api/v1/transactions/:id/refund` | Auth, PIN | Receiver refunds a SUCCESS payment; either party releases a FAILED payment whose funds were captured | 200 | 403 `REFUND_NOT_ALLOWED`; 404 `TRANSACTION_NOT_FOUND`; 409 `ILLEGAL_STATE_TRANSITION`; 422 `INSUFFICIENT_BALANCE`, `REFUND_NOT_POSSIBLE`; 503 gateway or `LOCK_TIMEOUT` |
| POST | `/api/v1/scheduled-payments` | Auth, PIN | Pay later: `executeAt` (ISO time) or `delaySeconds` | 201 | 400 `MISSING_FIELD`, `INVALID_SCHEDULE_TIME`, `INVALID_AMOUNT`; 404 `RECEIVER_NOT_FOUND`, `SOURCE_NOT_FOUND` |
| GET | `/api/v1/scheduled-payments` | Auth | The caller's 20 most recent schedules by execution time | 200 | none |
| DELETE | `/api/v1/scheduled-payments/:id` | Auth | Cancel a PENDING schedule | 200 | 404 `SCHEDULE_NOT_FOUND`; 409 `SCHEDULE_NOT_PENDING` (also when the scheduler has just started it) |
| GET | `/api/v1/notifications?limit=&consistency=` | Auth | Delivered and failed notifications for the caller | 200 | 400 `INVALID_LIMIT` |
| GET | `/health` | none | Liveness: `{ status, uptimeSeconds }` | 200 | none |

Any other path under `/api` returns 404 `ROUTE_NOT_FOUND`.

## Endpoint reference: operator and demo API

These routes are implemented by `SystemController`. "Key" means `X-Operator-Key`, required only when `operatorKey` is configured (then a missing or wrong key is 403 `OPERATOR_KEY_REQUIRED`).

| Method | Path | Key | Purpose | Success | Notable errors |
|---|---|---|---|---|---|
| GET | `/api/v1/system/metrics` | no | One snapshot of every component's counters, including `deadLetters` and `stuckCompensations` | 200 | none |
| GET | `/api/v1/system/design` | no | What is plugged into each extension point (chain, fraud rules, strategies, observers) | 200 | none |
| GET | `/api/v1/system/feed?limit=` | no | Latest trace steps across all requests (default 60, max 250) | 200 | 400 `INVALID_LIMIT` |
| GET | `/api/v1/system/traces/:id` | no | Every step of one request, by `X-Request-Id` | 200 | 404 `TRACE_NOT_FOUND` |
| GET | `/api/v1/system/ledger?limit=&consistency=` | no | Most recent ledger entries (default 30, max 200) | 200 | 400 `INVALID_LIMIT` |
| GET | `/api/v1/system/ledger/verify` | no | Full audit on the primary: hash chain, debits equal credits, wallets equal ledger | 200 | none |
| GET | `/api/v1/system/docs` | no | The `docs/*.md` files and their titles, for the in-app viewer | 200 | none |
| POST | `/api/v1/system/ledger/tamper-test` | yes | Tries an UPDATE, a DELETE and an INSERT OR REPLACE on the newest ledger row; all three must be refused | 200 | none |
| PUT | `/api/v1/system/chaos` | yes | Fault injection: bank and card latency, failure rate and outage, replica lag, database latency, notification failures, fail the next wallet credit | 200 | 400 `INVALID_CHAOS_SETTING` |
| PUT | `/api/v1/system/nodes/:id` | yes | Mark an app node healthy or unhealthy (`{ "healthy": false }`) | 200 | 400 `INVALID_FIELD`; 404 `NODE_NOT_FOUND` |
| POST | `/api/v1/system/queue/redrive` | yes | Move dead letters back onto their topic: notifications and stuck compensations | 200 | none |
| POST | `/api/v1/system/breakers/reset` | yes | Force both circuit breakers to CLOSED | 200 | none |
| POST | `/api/v1/system/reset` | yes | Wipe both databases, cache, queue, limiters, PIN counters, breakers and chaos, then seed the demo data again | 200 | none |

Static content is served after the API: `/design-docs` (this folder), `/vendor/...` (marked, mermaid, and only `.css` and `.woff`/`.woff2` files from the font packages) and the UI from `public/`.

## Request and response examples

Headers are trimmed to the ones defined above. JSON is re-indented, and short nested objects are written on one line.

**Sign in, then call with the token.** The token below expired 30 minutes after capture.

```http
POST /api/v1/auth/login
Content-Type: application/json

{"upiId":"alice@miniupi","pin":"1234"}
```

```json
HTTP/1.1 200 OK
X-Request-Id: req_7a68504377124f4d
X-Served-By: app-node-1

{
  "data": {
    "token": "usr_91cf53b46aa24b72.1794871903356.u3m2D9spE2w-BxDGQZ3fGyy3nFPOQMDd80CdB3ua_8A",
    "expiresAt": "2026-11-16T23:31:43.356Z",
    "user": {
      "id": "usr_91cf53b46aa24b72", "name": "Alice Sharma", "upiId": "alice@miniupi", "phone": "9876543210",
      "email": "alice@example.com", "status": "ACTIVE", "dailyLimit": 50000,
      "notificationChannels": ["SMS", "PUSH", "EMAIL"], "blacklisted": false
    }
  }
}
```

An unknown UPI ID and a wrong PIN for `alice@miniupi` both gave `401 { "error": { "code": "INVALID_CREDENTIALS", "message": "UPI ID or PIN is incorrect.", ... } }`. The Bearer-authenticated `GET /me` (shortened: the user object and the card source are omitted):

```http
GET /api/v1/me
Authorization: Bearer usr_91cf53b46aa24b72.1794871903356.u3m2D9spE2w-BxDGQZ3fGyy3nFPOQMDd80CdB3ua_8A
```

```json
HTTP/1.1 200 OK
X-Request-Id: req_a3002cc4be284bc5
X-Served-By: app-node-3
X-RateLimit-Remaining: 29

{
  "data": {
    "user": { "id": "usr_91cf53b46aa24b72", "name": "Alice Sharma", "upiId": "alice@miniupi", "...": "..." },
    "wallet": {
      "id": "wal_2b8e01ffda124174", "userId": "usr_91cf53b46aa24b72", "balance": 18971, "balancePaise": 1897100,
      "status": "ACTIVE", "version": 9, "updatedAt": "2026-11-16T22:58:51.951Z"
    },
    "sources": [
      { "id": "src_9a5b118154c241e0", "type": "WALLET", "label": "Wallet balance", "isExternal": false, "perTransactionLimit": 100000 },
      { "id": "src_c6730eb1372d448c", "type": "BANK_ACCOUNT", "label": "HDFC Bank XXXX6789", "isExternal": true, "perTransactionLimit": 100000 }
    ]
  }
}
```

A forged or malformed token (`Bearer abc.def.ghi`, or the real token with its last character changed) gave `401 INVALID_TOKEN`.

**Register.** No `X-RateLimit-Remaining` header: the route is not authenticated, so only the per-address limit applies.

```http
POST /api/v1/users
Content-Type: application/json

{"name":"Meera Iyer","phone":"9845027290","pin":"4321","email":"meera@example.com","upiHandle":"meera.docs2729"}
```

```json
HTTP/1.1 201 Created
X-Request-Id: req_9362ac6cadce40cd
X-Served-By: app-node-3

{
  "data": {
    "user": {
      "id": "usr_0c67b9e5127d4bce", "name": "Meera Iyer", "upiId": "meera.docs2729@miniupi",
      "phone": "9845027290", "email": "meera@example.com", "status": "ACTIVE", "dailyLimit": 50000,
      "notificationChannels": ["SMS", "PUSH"], "blacklisted": false
    },
    "wallet": {
      "id": "wal_215ba2eb33344f67", "userId": "usr_0c67b9e5127d4bce", "balance": 0, "balancePaise": 0,
      "status": "ACTIVE", "version": 0, "updatedAt": "2026-11-16T23:02:42.121Z"
    },
    "sources": [
      { "id": "src_68b9a8f78681471b", "type": "WALLET", "label": "Wallet balance", "isExternal": false, "perTransactionLimit": 100000 }
    ]
  }
}
```

**Link a bank account.** The IFSC is upper-cased by the controller; the full account number is not stored.

```http
POST /api/v1/payment-sources/bank-accounts
X-User-Id: usr_0c67b9e5127d4bce

{"bankName":"Canara Bank","accountNumber":"110023456789","ifsc":"cnrb0001234"}
```

```json
HTTP/1.1 201 Created

{ "data": { "id": "src_3fe73fd229ff44a1", "type": "BANK_ACCOUNT", "label": "Canara Bank XXXX6789", "isExternal": true, "perTransactionLimit": 100000 } }
```

**`POST /transfers`, success** (with the token from above, abbreviated):

```http
POST /api/v1/transfers
Authorization: Bearer usr_91cf53b46aa24b72.1794871903356.u3m2...
Idempotency-Key: dffbb5a5-0905-4971-b1a3-e88c216faa68

{"receiverUpiId":"bob@miniupi","amountPaise":200,"note":"Chai","pin":"1234"}
```

```json
HTTP/1.1 201 Created
X-Request-Id: req_d3f69879335d4bb8
X-Served-By: app-node-3
X-RateLimit-Remaining: 29
Idempotent-Replayed: false

{
  "data": {
    "transaction": {
      "id": "txn_cabdc879a38d42dd", "type": "P2P", "status": "SUCCESS", "amount": 2, "amountPaise": 200,
      "sender": { "id": "usr_91cf53b46aa24b72", "name": "Alice Sharma", "upiId": "alice@miniupi" },
      "receiver": { "id": "usr_a0d8585fb6e24fca", "name": "Bob Verma", "upiId": "bob@miniupi" },
      "source": { "id": "src_9a5b118154c241e0", "type": "WALLET", "label": "Wallet balance" },
      "note": "Chai", "failureCode": null, "failureReason": null,
      "createdAt": "2026-11-16T23:02:12.772Z", "updatedAt": "2026-11-16T23:02:12.797Z"
    }
  }
}
```

**`POST /transfers`, replay.** The identical request sent again returned the identical body with `200 OK`, `Idempotent-Replayed: true` and a new `X-Request-Id: req_d49ef645d783433b`; so did the same key with `"amount":2` instead of `"amountPaise":200`. The same key with `"amountPaise":300` returned:

```json
HTTP/1.1 422 Unprocessable Entity

{ "error": { "code": "IDEMPOTENCY_KEY_REUSED", "message": "This Idempotency-Key was already used with a different request body.",
             "details": { "key": "dffbb5a5-0905-4971-b1a3-e88c216faa68" }, "requestId": "req_8eb546f02c9b42ad" } }
```

**`POST /transfers`, business failure.** Paying the blacklisted `quickloan@miniupi` is blocked by `BlacklistedPayeeRule`. The transaction was recorded as FAILED, so the response carries both parts:

```json
HTTP/1.1 403 Forbidden
X-Request-Id: req_caa9842381904686
Idempotent-Replayed: false

{
  "error": {
    "code": "FRAUD_SUSPECTED",
    "message": "quickloan@miniupi has been reported for fraud. This payment was blocked to protect you.",
    "details": { "rule": "Blacklisted payee" },
    "requestId": "req_caa9842381904686"
  },
  "data": {
    "transaction": {
      "id": "txn_c0b34ec966cd4073", "type": "P2P", "status": "FAILED", "amount": 1, "amountPaise": 100,
      "sender": { "id": "usr_91cf53b46aa24b72", "name": "Alice Sharma", "upiId": "alice@miniupi" },
      "receiver": { "id": "usr_f9ccd0208e344e36", "name": "Quick Loan Offers", "upiId": "quickloan@miniupi" },
      "source": { "id": "src_9a5b118154c241e0", "type": "WALLET", "label": "Wallet balance" },
      "note": "Processing fee", "failureCode": "FRAUD_SUSPECTED",
      "failureReason": "quickloan@miniupi has been reported for fraud. This payment was blocked to protect you.",
      "createdAt": "2026-11-16T23:02:12.842Z", "updatedAt": "2026-11-16T23:02:12.848Z"
    }
  }
}
```

**`GET /transactions`, two pages** (shortened: each element is a full `TransactionView`):

```http
GET /api/v1/transactions?limit=2
Authorization: Bearer usr_91cf53b46aa24b72.1794871903356.u3m2...
```

```text
HTTP/1.1 200 OK
X-Data-Source: replica

{ "data": [ { "id": "txn_c9d51bcb93cb490e", "type": "TOPUP", "status": "FAILED", "failureCode": "SELF_TRANSFER", "createdAt": "2026-11-16T22:58:51.121Z", ... },
            { "id": "txn_a15f76f86fdc4204", "type": "P2P", "status": "FAILED", "failureCode": "FRAUD_SUSPECTED", "createdAt": "2026-11-16T22:58:51.110Z", ... } ],
  "page": { "nextCursor": "MjAyNi0xMS0xNlQyMjo1ODo1MS4xMTBafHR4bl9hMTVmNzZmODZmZGM0MjA0" } }
```

```http
GET /api/v1/transactions?limit=2&before=MjAyNi0xMS0xNlQyMjo1ODo1MS4xMTBafHR4bl9hMTVmNzZmODZmZGM0MjA0
```

```text
HTTP/1.1 200 OK
X-Data-Source: replica

{ "data": [ { "id": "txn_69b012ea53734480", "status": "FAILED", "createdAt": "2026-11-16T22:58:51.099Z", ... },
            { "id": "txn_eb67765bba2946bc", "status": "REFUNDED", "createdAt": "2026-11-16T22:58:51.027Z", ... } ],
  "page": { "nextCursor": "MjAyNi0xMS0xNlQyMjo1ODo1MS4wMjdafHR4bl9lYjY3NzY1YmJhMjk0NmJj" } }
```

The first cursor decodes to `2026-11-16T22:58:51.110Z|txn_a15f76f86fdc4204`, the last row of page one. `?before=xyz` returned `400 INVALID_CURSOR`.

**`GET /transactions/:id`** as Alice, the payer (shortened: the transaction object). Her own ledger line is complete; Bob's line is redacted by `redactLedgerFor`:

```json
HTTP/1.1 200 OK
X-Data-Source: replica

{
  "data": {
    "transaction": { "id": "txn_cabdc879a38d42dd", "status": "SUCCESS", "amountPaise": 200, "...": "..." },
    "timeline": [
      { "from": null, "to": "INITIATED", "detail": "Payment request accepted", "at": "2026-11-16T23:02:12.772Z" },
      { "from": "INITIATED", "to": "PROCESSING", "detail": "Picked up for processing", "at": "2026-11-16T23:02:12.796Z" },
      { "from": "PROCESSING", "to": "SUCCESS", "detail": "Money moved and ledger written", "at": "2026-11-16T23:02:12.797Z" }
    ],
    "ledger": [
      {
        "sequence": 107, "id": "led_97dce30b5b9b4fd9", "transactionId": "txn_cabdc879a38d42dd",
        "accountId": "WALLET:wal_2b8e01ffda124174", "entryType": "DEBIT", "amount": 2, "balanceAfter": 18969,
        "description": "Paid to bob@miniupi",
        "prevHash": "597081bfb226662027607669fabff6480be55ffffb214f43f7d7245885011aa1",
        "hash": "d0f157bff130f26662e903236854b55cdcb3c4370ac27cac9901fd3e7a095043",
        "createdAt": "2026-11-16T23:02:12.797Z"
      },
      {
        "sequence": 108, "id": "led_4e431e301eb84b54", "transactionId": "txn_cabdc879a38d42dd",
        "accountId": "WALLET:(other party)", "entryType": "CREDIT", "amount": 2, "balanceAfter": null,
        "description": "Credited to the other party",
        "prevHash": "d0f157bff130f26662e903236854b55cdcb3c4370ac27cac9901fd3e7a095043",
        "hash": "fbb15c8f886aa74d66b71504e4e3f2496c6ac2aa7e977be5abff269e161fd52f",
        "createdAt": "2026-11-16T23:02:12.797Z"
      }
    ]
  }
}
```

As Bob, the receiver, the same transaction shows `"source": { "id": "", "type": "WALLET", "label": "Wallet" }`, his own CREDIT line in full and Alice's DEBIT line redacted.

**Refund.** Alice, the payer, may not take the money back (`403 REFUND_NOT_ALLOWED`, "Only the person who received this payment can refund it."); Bob, the receiver, may give it back once:

```http
POST /api/v1/transactions/txn_cabdc879a38d42dd/refund
X-User-Id: usr_a0d8585fb6e24fca

{"pin":"1234"}
```

```json
HTTP/1.1 200 OK
X-Request-Id: req_c733b11d4a244e81

{ "data": { "transaction": { "id": "txn_cabdc879a38d42dd", "status": "REFUNDED", "source": { "id": "", "type": "WALLET", "label": "Wallet" },
                             "updatedAt": "2026-11-16T23:02:27.269Z", "...": "..." } } }
```

Bob's second attempt returned `409 ILLEGAL_STATE_TRANSITION` ("A REFUNDED transaction cannot move to REFUNDED."). Immediately after the refund, Alice's `GET /transactions` came from the primary, but Bob's came from the replica and still listed the payment as SUCCESS: only the payer is pinned for read-your-writes (see `05-sequence-diagrams.md`, diagram 9a).

**Schedule a payment.** A few seconds later `GET /scheduled-payments` showed the same id with `"status": "EXECUTED"` and `"transactionId": "txn_f6dbb5bed968482c"`.

```http
POST /api/v1/scheduled-payments
Authorization: Bearer usr_91cf53b46aa24b72.1794871903356.u3m2...

{"receiverUpiId":"bob@miniupi","amountPaise":100,"note":"Rent share","delaySeconds":5,"pin":"1234"}
```

```json
HTTP/1.1 201 Created

{ "data": { "id": "sch_503fcacb38cb434f", "receiverUpiId": "bob@miniupi", "amount": 1, "note": "Rent share",
            "executeAt": "2026-11-16T23:02:47.107Z", "status": "PENDING", "transactionId": null, "failureReason": null } }
```

**Validation and guard errors.** All rejected before anything is recorded. The last two were produced by the same-site guard and the body parser, which run before a request id exists:

```json
HTTP/1.1 400 Bad Request
{ "error": { "code": "INVALID_AMOUNT", "message": "\"amountPaise\" must be a whole number greater than zero.", "details": { "field": "amountPaise" }, "requestId": "req_ae23d494f0aa40b4" } }

HTTP/1.1 400 Bad Request
{ "error": { "code": "INVALID_AMOUNT", "message": "Amount can have at most 2 decimal places.", "details": { "rupees": 1.005 }, "requestId": "req_bc11c21411ea464e" } }

HTTP/1.1 400 Bad Request
{ "error": { "code": "INVALID_FIELD", "message": "\"note\" contains characters that are not allowed.", "details": { "field": "note" }, "requestId": "req_0e8988096879421f" } }

HTTP/1.1 400 Bad Request
{ "error": { "code": "IDEMPOTENCY_KEY_RESERVED", "message": "Idempotency keys starting with \"scheduled:\" are reserved.", "requestId": "req_fcfa7a30b60048e2" } }

HTTP/1.1 403 Forbidden
{ "error": { "code": "CROSS_SITE_REQUEST", "message": "Requests from other sites are not accepted." } }

HTTP/1.1 400 Bad Request
{ "error": { "code": "INVALID_JSON", "message": "Request body must be valid JSON under 16 kB." } }
```

## Internal interface design

### Service entry points

```ts
// src/service/SessionService.ts
login(upiId: string, pin: unknown): Session
verify(token: string): string
// src/service/TransferService.ts
transfer(command: TransferCommand): Promise<IdempotentOutcome<TransferResult>>
// src/service/RefundService.ts
refund(transactionId: string, requester: User): Promise<TransactionView>
releaseCapturedFunds(transactionId: string): Promise<void>
// src/service/IdempotencyService.ts
execute<T>(userId: string, key: string, requestHash: string, operation: () => Promise<T>): Promise<IdempotentOutcome<T>>
// src/service/TransactionQueryService.ts
history(userId: string, limit: number, strong = false, cursor?: string): Served<TransactionView[]>
details(transactionId: string, requesterId: string, strong = false): Served<TransactionDetails>
// src/service/ScheduledPaymentService.ts
schedule(user: User, input: SchedulePaymentInput): ScheduledPayment
cancel(user: User, id: string): ScheduledPayment
runDue(now = new Date()): Promise<number>
// src/service/ReconciliationService.ts
run(): Promise<ReconciliationReport>
// src/service/UserService.ts
register(input: RegisterUserInput): User
authenticate(userId: string | undefined): User
verifyPin(user: User, pin: unknown): void
// src/service/LedgerService.ts
record(transaction: Transaction, lines: LedgerLine[]): void
verify(primary: SqlReader): LedgerVerification
```

`UserController.login` calls `SessionService.login`, and the `authentication` middleware calls `verify`; `PaymentController` calls `transfer`, `refund`, `history`, `details` and `schedule`; `PaymentScheduler` calls `runDue`; the `compensations` queue consumer calls `releaseCapturedFunds`; `createApplication` calls `ReconciliationService.run` once at start-up. `TransferFailure` is `{ code, message, category, details? }`: the service reports a category, and the controller picks the status with `statusFor`.

### Collaborators that keep the services small

```ts
// src/service/TransactionJournal.ts
class PartyResolver {
  forNewPayment(senderId: string, receiverUpiId: string, sourceId: string | undefined): TransactionParties
  of(transaction: Transaction): TransactionParties
  strategyFor(source: PaymentSource): PaymentStrategy
}
class TransactionJournal {
  open(transaction: Transaction, parties: TransactionParties): void
  save(transaction: Transaction, parties: TransactionParties): void
  announce(transaction: Transaction, parties: TransactionParties): void
  find(transactionId: string): Transaction | undefined
  require(transactionId: string): Transaction
  findByKey(senderId: string, idempotencyKey: string): Transaction | undefined
}
// src/events/Outbox.ts
class OutboxRelay {
  relay(transaction: Transaction, parties: TransactionParties): number
  relayAll(): number
}
// TransactionParties = { sender: User; receiver: User; source: PaymentSource }
```

`PartyResolver` holds the lookup rules (receiver exists, a source owned by someone else is "not found"), used by transfers, refunds, the outbox and recovery. `TransactionJournal` is what services call to store a transaction (`open`, `save`) and to announce committed changes (`announce`, which relays the outbox and pins the payer for read-your-writes). `OutboxRelay` reads unpublished events, publishes them to the observers and marks them published; `relayAll` does that at start-up. These are concrete classes rather than interfaces because they contain no technology choice; their own dependencies are interfaces. With them, `TransferService` takes 7 constructor parameters and `RefundService` 3.

### Payment ports

```ts
// src/payment/PaymentStrategy.ts
interface PaymentStrategy {
  readonly sourceType: PaymentSourceType;
  assertFundsAvailable(context: PaymentContext, senderWallet: Wallet): void;
  pay(context: PaymentContext): Promise<Transaction>;
  reverse(context: PaymentContext): Promise<Transaction>;
}
// src/payment/gateway/PaymentGateway.ts
interface PaymentGateway {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeReceipt>;
  refund(reference: string): Promise<void>;
  statusOf(reference: string): Promise<ChargeStatus>;
}
type ChargeStatus = { state: 'NOT_FOUND' } | { state: 'CAPTURED' | 'REFUNDED'; gatewayTransactionId: string };
```

Strategies are picked by `PaymentStrategyFactory.for(source.type)`; a new payment method is a new class plus one `register()` call. `ExternalPaymentStrategy` calls `charge` and `refund`; `ReconciliationService` calls `statusOf` to resolve a charge whose outcome was never seen. The gateway is an interface so `CircuitBreakerGateway` can wrap `SimulatedGateway` (or a real bank adapter) without the callers noticing.

### Persistence ports

```ts
// src/infrastructure/db/Database.ts
interface SqlReader { readonly role: 'primary' | 'replica'; get<T>(sql: string, ...params: SqlValue[]): T | undefined; all<T>(sql: string, ...params: SqlValue[]): T[]; }
interface SqlWriter extends SqlReader { run(sql: string, ...params: SqlValue[]): { changes: number }; }
interface UnitOfWork { runInTransaction<T>(work: () => T): T; }
// src/repository/interfaces.ts (method signatures only)
interface UserRepository { insert(user: User): void; findById(id: string): User | undefined; findByUpiId(upiId: string): User | undefined; findByPhone(phone: string): User | undefined; findAll(): User[]; }
interface WalletRepository { insert(wallet: Wallet): void; findByUserId(userId: string): Wallet | undefined; findByUserIdForUpdate(userId: string): Wallet | undefined; save(wallet: Wallet): void; findAll(): Wallet[]; }
interface PaymentSourceRepository { insert(source: PaymentSource): void; findById(id: string): PaymentSource | undefined; findByUserId(userId: string): PaymentSource[]; findWalletSource(userId: string): WalletSource | undefined; }
interface TransferHistoryReader { sumOutgoingSince(senderId: string, since: Date, excludeTransactionId: string): Money; countInitiatedSince(senderId: string, since: Date, excludeTransactionId: string): number; hasSuccessfulTransfer(senderId: string, receiverId: string): boolean; }
interface TransactionRepository extends TransferHistoryReader { insert(txn: Transaction): void; update(txn: Transaction): void; findById(id: string): Transaction | undefined; findBySenderAndKey(senderId: string, idempotencyKey: string): Transaction | undefined; findCaptured(): Transaction[]; findUnfinished(): Transaction[]; countByStatus(): Record<string, number>; }
interface TransactionQueryRepository { findHistory(reader: SqlReader, userId: string, limit: number, before?: { createdAt: string; id: string }): TransactionView[]; findView(reader: SqlReader, transactionId: string): TransactionView | undefined; }
interface TransactionEventRepository { append(event: TransactionEventRecord): void; findByTransaction(reader: SqlReader, transactionId: string): TransactionEventRecord[]; findUnpublished(transactionId: string): OutboxEvent[]; markPublished(eventIds: number[], at: Date): void; findTransactionsWithUnpublished(): string[]; }
interface LedgerRepository { append(entry: LedgerEntry): void; lastHash(): string; findByTransaction(reader: SqlReader, transactionId: string): LedgerEntry[]; findRecent(reader: SqlReader, limit: number): LedgerEntry[]; findAllInOrder(reader: SqlReader): LedgerEntry[]; }
interface IdempotencyRepository { tryBegin(userId: string, key: string, requestHash: string, now: Date): boolean; find(userId: string, key: string): IdempotencyRecord | undefined; complete(userId: string, key: string, responseBody: string, now: Date): void; release(userId: string, key: string): void; releaseAllInProgress(): number; }
interface NotificationRepository { upsert(notification: Notification): void; findByUser(reader: SqlReader, userId: string, limit: number): Notification[]; }
interface ScheduledPaymentRepository { insert(payment: ScheduledPayment): void; transition(payment: ScheduledPayment, expected: ScheduledPaymentStatus): boolean; findById(id: string): ScheduledPayment | undefined; findDue(now: Date, limit: number): ScheduledPayment[]; findByUser(userId: string): ScheduledPayment[]; requeueRunning(): number; }
```

Services depend on these instead of SQLite. Read-side methods take a `SqlReader` argument so the caller, through `ReadRouter.route`, decides whether the primary or the replica answers; only `PrimaryDatabase` implements `SqlWriter` and `UnitOfWork`, so code holding a replica cannot write. `TransactionRepository.insert` and `update` store the row and its new events atomically, and `update` is versioned. `TransactionEventRepository` is both the audit trail (`append`, `findByTransaction`) and the outbox (`findUnpublished`, `markPublished`, `findTransactionsWithUnpublished`; `OutboxEvent` is a `TransactionEventRecord` with its numeric `id`). `findUnfinished`, `releaseAllInProgress` and `requeueRunning` exist for start-up reconciliation. Validation handlers and fraud rules receive the narrow `TransferHistoryReader`.

### Infrastructure ports

```ts
// src/infrastructure/cache/Cache.ts
interface Cache { get<T>(key: string): T | undefined; set<T>(key: string, value: T, ttlMs?: number): void; delete(key: string): void; clear(): void; stats(): CacheStats; }
// src/infrastructure/queue/MessageQueue.ts
interface MessageQueue {
  publish<T>(topic: string, payload: T): string;
  subscribe<T>(topic: string, handler: MessageHandler<T>, options?: SubscribeOptions<T>): void;
  stats(): Record<string, TopicStats>;
  deadLetters(topic: string): DeadLetter[];
  redrive(topic: string): number;
  drain(): Promise<void>;
  clear(): void;
}
// src/infrastructure/lock/LockManager.ts
interface LockManager { withLock<T>(key: string, work: () => Promise<T>, timeoutMs?: number): Promise<T>; stats(): LockStats; }
```

`Cache` is used by `IdempotencyService`, `UserService.resolveUpiId` and `CachingWalletRepository`; `MessageQueue` by `NotificationService` (topic `notifications`) and by `CompensationObserver` and its consumer (topic `compensations`); `LockManager` by `TransferService` and `RefundService`. Each is an interface because the in-process classes are stand-ins for Redis, a broker such as Kafka or SQS, and a distributed lock; swapping them changes only `src/container.ts`.

### Extension ports

```ts
// src/events/TransactionEvents.ts
interface TransactionObserver { readonly name: string; onTransactionEvent(event: TransactionEvent): void; }
// src/validation/fraud.ts
interface FraudRule { readonly name: string; evaluate(context: ValidationContext): FraudVerdict; }
// src/notification/channels.ts
interface NotificationChannel { readonly type: NotificationChannelType; recipientFor(user: User): string | null; send(message: OutboundMessage): Promise<string>; }
```

`TransactionEventPublisher.publish`, called only by `OutboxRelay`, runs every observer (`LifecycleTraceObserver`, `NotificationObserver`, `MetricsObserver`, `CompensationObserver`) and isolates their failures; `FraudEngine.assess` runs every rule; `NotificationChannelFactory` hands out the channel registered for a type. Because the outbox delivers at least once, observers must tolerate a repeated event. A new reaction, rule or channel is one new class registered in `src/container.ts` (recipes in `04-design-patterns.md`).

## DTOs

The response shapes live in `src/readmodel/views.ts`: `PartyView` (id, name, upiId), `UserView` (adds phone, email, status, dailyLimit in rupees, notificationChannels, blacklisted), `WalletView` (balance and balancePaise, status, version), `SourceView` (id, type, masked label, isExternal, perTransactionLimit), `TransactionView` (amount and amountPaise, sender and receiver as `PartyView`, source summary, failure fields, ISO timestamps), `LedgerEntryView`, `NotificationView` and `ScheduledPaymentView`. Each has a mapping function (`toUserView`, `toTransactionView`, ...). Two more functions shape what one person may see of a shared transaction: `redactFor(view, viewerId)` replaces the source with a generic one (`{ id: '', type, label: 'Wallet' | 'Bank account' | 'Card' }`) for anyone but the payer, and `redactLedgerFor(entries, ownAccountIds)` masks the other party's account id, balance and description.

Domain objects are never serialised to JSON. The payment-side services (`TransferService`, `RefundService`, `TransactionQueryService`, and `LedgerService` for reads) return views themselves; the account-side services (`UserService`, `ScheduledPaymentService`, `SessionService`) return domain objects to the controller, which maps them with the same functions before responding. The reasons: the API contract stays stable while the domain changes (for example `Money` becomes two plain numbers, `amount` and `amountPaise`); secrets cannot leak by accident, since `User` keeps its PIN hash in a private `#pinHash` field and `UserView` has no such field; privacy rules live in one place; and the read model can be filled from one joined SQL query (`SqliteTransactionQueryRepository`) without loading whole aggregates.
