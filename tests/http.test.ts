import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { AppSettings } from '../src/config/AppConfig';
import type { Application } from '../src/container';
import { closeApp, createTestApp, freezeClock, PIN, sleep, uniqueKey, writerOf } from './helpers';

// ---- A tiny HTTP client around global fetch -------------------------------------------------

interface ApiResponse {
  status: number;
  headers: Headers;
  // The response envelope: { data } on success, { error } (and sometimes data too) on failure.
  body: { data?: any; error?: { code: string; message: string; details?: any; requestId?: string } };
}

interface CallOptions {
  /** Sent as X-User-Id. */
  as?: string;
  /** Sent as Idempotency-Key. */
  key?: string;
  body?: unknown;
  /** Sent verbatim instead of a JSON-encoded body. */
  rawBody?: string;
  headers?: Record<string, string>;
}

interface TestServer {
  app: Application;
  url: string;
  call(method: string, path: string, options?: CallOptions): Promise<ApiResponse>;
  /** Registers a user over HTTP and returns the identifiers tests need. */
  newUser(overrides?: Record<string, unknown>): Promise<{ id: string; upiId: string; name: string }>;
  /** Links a bank account and tops the wallet up, all over HTTP. Returns the bank source id. */
  fundUser(userId: string, rupees: number): Promise<string>;
  pay(from: string, toUpiId: string, amount: number, extra?: { key?: string; note?: string; sourceId?: string; pin?: unknown }): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** Limits high enough that only the tests about limits ever hit them. */
const NO_LIMITS: Partial<AppSettings> = {
  pinMaxAttempts: 1_000,
  rateLimitCapacity: 100_000,
  rateLimitRefillPerSecond: 100_000,
  ipRateLimitCapacity: 100_000,
  ipRateLimitRefillPerSecond: 100_000,
};

async function startServer(overrides: Partial<AppSettings> = {}): Promise<TestServer> {
  const app = await createTestApp({ ...NO_LIMITS, ...overrides });
  const server: Server = app.http.listen(0, '127.0.0.1'); // an ephemeral port, never 3000
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let users = 0;

  const call: TestServer['call'] = async (method, path, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.as) headers['X-User-Id'] = options.as;
    if (options.key) headers['Idempotency-Key'] = options.key;
    let body: string | undefined = options.rawBody;
    if (options.body !== undefined) body = JSON.stringify(options.body);
    if (body !== undefined && headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${url}${path}`, { method, headers, body });
    const text = await response.text();
    let parsed: ApiResponse['body'] = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      assert.fail(`${method} ${path} answered ${response.status} with a non-JSON body: ${text.slice(0, 200)}`);
    }
    return { status: response.status, headers: response.headers, body: parsed };
  };

  const newUser: TestServer['newUser'] = async (overrides = {}) => {
    users += 1;
    const response = await call('POST', '/api/v1/users', {
      body: { name: `Http User ${users}`, upiHandle: `http${users}`, phone: `8${String(users).padStart(9, '0')}`, pin: PIN, ...overrides },
    });
    assert.equal(response.status, 201, `registration failed: ${JSON.stringify(response.body)}`);
    const { id, upiId, name } = response.body.data.user;
    return { id, upiId, name };
  };

  const fundUser: TestServer['fundUser'] = async (userId, rupees) => {
    const linked = await call('POST', '/api/v1/payment-sources/bank-accounts', {
      as: userId,
      body: { bankName: 'Test Bank', accountNumber: '123456789012', ifsc: 'TEST0001234' },
    });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    const sourceId: string = linked.body.data.id;
    const toppedUp = await call('POST', '/api/v1/wallet/topup', {
      as: userId,
      key: uniqueKey('topup'),
      body: { amount: rupees, sourceId, pin: PIN },
    });
    assert.equal(toppedUp.status, 201, JSON.stringify(toppedUp.body));
    return sourceId;
  };

  const pay: TestServer['pay'] = (from, toUpiId, amount, extra = {}) =>
    call('POST', '/api/v1/transfers', {
      as: from,
      key: extra.key ?? uniqueKey('http-pay'),
      body: { receiverUpiId: toUpiId, amount, pin: 'pin' in extra ? extra.pin : PIN, note: extra.note, sourceId: extra.sourceId },
    });

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await closeApp(app);
  };

  return { app, url, call, newUser, fundUser, pay, close };
}

/** A request with full control over the Host header, which fetch does not allow. */
function rawGet(url: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({ host: target.hostname, port: target.port, path, method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
describe('HTTP API', () => {
  let server: TestServer;

  before(async () => {
    server = await startServer();
  });

  after(() => server.close());

  describe('response envelope and request identity', () => {
    test('success is { data } and carries a request id header', async () => {
      const response = await server.call('GET', '/api/v1/users');
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.body), ['data']);
      assert.ok(Array.isArray(response.body.data));
      assert.match(response.headers.get('x-request-id') ?? '', /^req_[0-9a-f]{16}$/);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    });

    test('failure is { error: { code, message, requestId } } and the id matches the X-Request-Id header', async () => {
      const response = await server.call('GET', '/api/v1/me');
      assert.equal(response.status, 401);
      assert.deepEqual(Object.keys(response.body), ['error']);
      const error = response.body.error!;
      assert.equal(error.code, 'UNAUTHENTICATED');
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.length > 0);
      assert.equal(error.requestId, response.headers.get('x-request-id'));
    });

    test('every request gets its own request id', async () => {
      const [a, b] = await Promise.all([server.call('GET', '/api/v1/users'), server.call('GET', '/api/v1/users')]);
      assert.notEqual(a.headers.get('x-request-id'), b.headers.get('x-request-id'));
    });

    test('security headers are set and the framework does not announce itself', async () => {
      const response = await server.call('GET', '/health');
      assert.equal(response.status, 200);
      assert.equal(response.body.data, undefined);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('x-powered-by'), null);
    });

    test('an unknown /api route is a 404 with a JSON body, on any version prefix', async () => {
      for (const path of ['/api/v1/does-not-exist', '/api/v2/users', '/api']) {
        const response = await server.call('GET', path);
        assert.equal(response.status, 404, path);
        assert.equal(response.body.error?.code, 'ROUTE_NOT_FOUND');
        assert.ok(response.body.error?.message.includes(path));
      }
      const wrongMethod = await server.call('DELETE', '/api/v1/users');
      assert.equal(wrongMethod.status, 404);
      assert.equal(wrongMethod.body.error?.code, 'ROUTE_NOT_FOUND');
    });
  });

  describe('authentication', () => {
    test('401 UNAUTHENTICATED without X-User-Id, on every protected route', async () => {
      const routes: Array<[string, string]> = [
        ['GET', '/api/v1/me'],
        ['POST', '/api/v1/transfers'],
        ['POST', '/api/v1/wallet/topup'],
        ['GET', '/api/v1/transactions'],
        ['GET', '/api/v1/transactions/txn_x'],
        ['POST', '/api/v1/transactions/txn_x/refund'],
        ['POST', '/api/v1/payment-sources/bank-accounts'],
        ['POST', '/api/v1/payment-sources/cards'],
        ['POST', '/api/v1/scheduled-payments'],
        ['GET', '/api/v1/scheduled-payments'],
        ['DELETE', '/api/v1/scheduled-payments/sch_x'],
        ['GET', '/api/v1/notifications'],
      ];
      for (const [method, path] of routes) {
        const response = await server.call(method, path, method === 'GET' ? {} : { body: {} });
        assert.equal(response.status, 401, `${method} ${path}`);
        assert.equal(response.body.error?.code, 'UNAUTHENTICATED');
      }
    });

    test('401 for an X-User-Id that is not a user (a UPI ID is not a user id)', async () => {
      const user = await server.newUser();
      for (const id of ['usr_0000000000000000', user.upiId, "' OR 1=1 --"]) {
        const response = await server.call('GET', '/api/v1/me', { as: id });
        assert.equal(response.status, 401);
        assert.equal(response.body.error?.code, 'UNAUTHENTICATED');
      }
    });

    test('401 INVALID_PIN for a wrong PIN, with the attempts left, and no payment is made', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 500);

      for (const pin of ['0000', '', '12345', 1234, null, [PIN], undefined]) {
        const response = await server.pay(alice.id, bob.upiId, 100, { pin }); // undefined: the field is absent
        assert.equal(response.status, 401, `PIN ${JSON.stringify(pin)}`);
        assert.equal(response.body.error?.code, 'INVALID_PIN');
        assert.equal(typeof response.body.error?.details.attemptsLeft, 'number');
        assert.equal(response.body.data, undefined);
      }
      const me = await server.call('GET', '/api/v1/me', { as: alice.id });
      assert.equal(me.body.data.wallet.balancePaise, 50_000);
      const history = await server.call('GET', '/api/v1/transactions?consistency=strong', { as: bob.id });
      assert.deepEqual(history.body.data, []);
    });

    test('403 ACCOUNT_BLOCKED for a blocked account', async () => {
      const user = await server.newUser();
      writerOf(server.app).run(`UPDATE users SET status = 'BLOCKED' WHERE id = ?`, user.id);
      const response = await server.call('GET', '/api/v1/me', { as: user.id });
      assert.equal(response.status, 403);
      assert.equal(response.body.error?.code, 'ACCOUNT_BLOCKED');
    });
  });

  describe('request validation', () => {
    test('400 INVALID_JSON for a malformed body', async () => {
      const alice = await server.newUser();
      for (const rawBody of ['{"receiverUpiId": "bob@miniupi", "amount": ', '{not json}', '"just a string"x']) {
        const response = await server.call('POST', '/api/v1/transfers', { as: alice.id, key: uniqueKey(), rawBody });
        assert.equal(response.status, 400, rawBody);
        assert.equal(response.body.error?.code, 'INVALID_JSON');
      }
    });

    test('413 for a body over 16 kB', async () => {
      const alice = await server.newUser();
      const response = await server.call('POST', '/api/v1/transfers', {
        as: alice.id,
        key: uniqueKey(),
        body: { receiverUpiId: 'bob@miniupi', amount: 1, pin: PIN, padding: 'x'.repeat(20_000) },
      });
      assert.equal(response.status, 413);
      assert.equal(response.body.error?.code, 'INVALID_JSON');
    });

    test('400 INVALID_BODY when the body is not a JSON object', async () => {
      const alice = await server.newUser();
      for (const options of [{ body: [1, 2, 3] }, {}, { rawBody: 'plain text', headers: { 'Content-Type': 'text/plain' } }]) {
        const response = await server.call('POST', '/api/v1/transfers', { as: alice.id, key: uniqueKey(), ...options });
        assert.equal(response.status, 400);
        assert.equal(response.body.error?.code, 'INVALID_BODY');
      }
    });

    test('400 for an amount sent as a string: money must be a JSON number', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 500);
      const response = await server.call('POST', '/api/v1/transfers', {
        as: alice.id,
        key: uniqueKey(),
        body: { receiverUpiId: bob.upiId, amount: '100', pin: PIN },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error?.code, 'INVALID_FIELD');
      assert.deepEqual(response.body.error?.details, { field: 'amount' });
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 0);
    });

    const badAmounts: Array<[string, unknown, string]> = [
      ['missing', undefined, 'MISSING_FIELD'],
      ['null', null, 'MISSING_FIELD'],
      ['zero', 0, 'INVALID_AMOUNT'],
      ['negative', -5, 'INVALID_AMOUNT'],
      ['three decimals', 10.005, 'INVALID_AMOUNT'],
      ['a hair over two decimals', 10.000000001, 'INVALID_AMOUNT'],
      ['above the ceiling', 1_000_000.01, 'INVALID_AMOUNT'],
      ['a boolean', true, 'INVALID_FIELD'],
      ['an object', { rupees: 10 }, 'INVALID_FIELD'],
      ['an array', [10], 'INVALID_FIELD'],
    ];
    for (const [label, amount, code] of badAmounts) {
      test(`400 ${code} for an amount that is ${label}`, async () => {
        const alice = await server.newUser();
        const bob = await server.newUser();
        const response = await server.call('POST', '/api/v1/transfers', {
          as: alice.id,
          key: uniqueKey(),
          body: { receiverUpiId: bob.upiId, amount, pin: PIN },
        });
        assert.equal(response.status, 400);
        assert.equal(response.body.error?.code, code);
      });
    }

    test('400 MISSING_FIELD without a receiver, 400 FIELD_TOO_LONG for an oversized note', async () => {
      const alice = await server.newUser();
      const noReceiver = await server.call('POST', '/api/v1/transfers', { as: alice.id, key: uniqueKey(), body: { amount: 10, pin: PIN } });
      assert.equal(noReceiver.status, 400);
      assert.equal(noReceiver.body.error?.code, 'MISSING_FIELD');
      assert.deepEqual(noReceiver.body.error?.details, { field: 'receiverUpiId' });

      const longNote = await server.pay(alice.id, 'bob@miniupi', 10, { note: 'n'.repeat(81) });
      assert.equal(longNote.status, 400);
      assert.equal(longNote.body.error?.code, 'FIELD_TOO_LONG');
    });

    test('400 INVALID_FIELD for markup or invisible control characters in free text', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 100);
      for (const note of ['<script>alert(1)</script>', 'line\nbreak', 'right-to-left ‮ override', 'zero​width']) {
        const response = await server.pay(alice.id, bob.upiId, 1, { note });
        assert.equal(response.status, 400, JSON.stringify(note));
        assert.equal(response.body.error?.code, 'INVALID_FIELD');
        assert.deepEqual(response.body.error?.details, { field: 'note' });
      }
      const badName = await server.call('POST', '/api/v1/users', { body: { name: 'Eve <b>Bold</b>', phone: '8999999990', pin: PIN } });
      assert.equal(badName.status, 400);
      assert.equal(badName.body.error?.code, 'INVALID_FIELD');

      // Ordinary punctuation, other scripts and emoji are fine.
      const fine = await server.pay(alice.id, bob.upiId, 1, { note: `Chai & समोसा 🍵 "50%" off; it's OK` });
      assert.equal(fine.status, 201);
      assert.equal(fine.body.data.transaction.note, `Chai & समोसा 🍵 "50%" off; it's OK`);
    });

    test('400 INVALID_LIMIT for a bad ?limit=, and a valid limit is honoured', async () => {
      const alice = await server.newUser();
      await server.fundUser(alice.id, 100);
      await server.fundUser(alice.id, 100);
      for (const limit of ['abc', '0', '-1', '1.5']) {
        const response = await server.call('GET', `/api/v1/transactions?limit=${limit}`, { as: alice.id });
        assert.equal(response.status, 400, limit);
        assert.equal(response.body.error?.code, 'INVALID_LIMIT');
      }
      const one = await server.call('GET', '/api/v1/transactions?limit=1&consistency=strong', { as: alice.id });
      assert.equal(one.body.data.length, 1);
    });
  });

  describe('transfers', () => {
    test('201 with the transaction; the money has moved', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 1_000);

      const response = await server.pay(alice.id, bob.upiId, 250.5, { note: 'Lunch' });

      assert.equal(response.status, 201);
      assert.equal(response.headers.get('idempotent-replayed'), 'false');
      const txn = response.body.data.transaction;
      assert.equal(txn.status, 'SUCCESS');
      assert.equal(txn.amount, 250.5);
      assert.equal(txn.amountPaise, 25_050);
      assert.equal(txn.sender.id, alice.id);
      assert.equal(txn.receiver.upiId, bob.upiId);
      assert.equal(txn.note, 'Lunch');
      assert.equal(response.body.error, undefined);

      assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).body.data.wallet.balancePaise, 74_950);
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 25_050);
    });

    test('400 IDEMPOTENCY_KEY_REQUIRED without the header, or with one that is too short', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 100);
      const body = { receiverUpiId: bob.upiId, amount: 10, pin: PIN };

      const missing = await server.call('POST', '/api/v1/transfers', { as: alice.id, body });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error?.code, 'IDEMPOTENCY_KEY_REQUIRED');

      const short = await server.call('POST', '/api/v1/transfers', { as: alice.id, key: 'short', body });
      assert.equal(short.status, 400);
      assert.equal(short.body.error?.code, 'IDEMPOTENCY_KEY_REQUIRED');

      const topUp = await server.call('POST', '/api/v1/wallet/topup', { as: alice.id, body: { amount: 10, sourceId: 'src_x', pin: PIN } });
      assert.equal(topUp.status, 400);
      assert.equal(topUp.body.error?.code, 'IDEMPOTENCY_KEY_REQUIRED');

      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 0);
    });

    test("400 IDEMPOTENCY_KEY_RESERVED for a key in the scheduler's namespace", async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 100);
      const response = await server.pay(alice.id, bob.upiId, 10, { key: 'scheduled:sch_0123456789abcdef' });
      assert.equal(response.status, 400);
      assert.equal(response.body.error?.code, 'IDEMPOTENCY_KEY_RESERVED');
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 0);
    });

    test('a retry with the same key answers 200 with Idempotent-Replayed: true and the same transaction', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 1_000);
      const key = uniqueKey('http-retry');

      const first = await server.pay(alice.id, bob.upiId, 300, { key });
      const second = await server.pay(alice.id, bob.upiId, 300, { key });

      assert.equal(first.status, 201);
      assert.equal(first.headers.get('idempotent-replayed'), 'false');
      assert.equal(second.status, 200);
      assert.equal(second.headers.get('idempotent-replayed'), 'true');
      assert.deepEqual(second.body.data, first.body.data);
      assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).body.data.wallet.balancePaise, 70_000);
    });

    test('a storm of identical requests over HTTP still debits once', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 1_000);
      const key = uniqueKey('http-storm');

      const responses = await Promise.all(Array.from({ length: 8 }, () => server.pay(alice.id, bob.upiId, 300, { key })));

      assert.equal(new Set(responses.map((r) => r.body.data.transaction.id)).size, 1);
      assert.equal(responses.filter((r) => r.status === 201).length, 1);
      assert.equal(responses.filter((r) => r.status === 200 && r.headers.get('idempotent-replayed') === 'true').length, 7);
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 30_000);
    });

    test('422 IDEMPOTENCY_KEY_REUSED when the key comes back with a different body', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 1_000);
      const key = uniqueKey('http-reuse');
      await server.pay(alice.id, bob.upiId, 100, { key });
      const reused = await server.pay(alice.id, bob.upiId, 200, { key });
      assert.equal(reused.status, 422);
      assert.equal(reused.body.error?.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(reused.body.data, undefined);
    });

    test('a payment refused by a business rule returns the error AND the FAILED transaction', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 100);

      const response = await server.pay(alice.id, bob.upiId, 500);

      assert.equal(response.status, 422);
      assert.equal(response.body.error?.code, 'INSUFFICIENT_BALANCE');
      assert.deepEqual(response.body.error?.details, { availablePaise: 10_000, requiredPaise: 50_000 });
      assert.equal(response.body.error?.requestId, response.headers.get('x-request-id'));
      const errorBody = response.body.error as Record<string, unknown>;
      assert.equal(errorBody.httpStatus, undefined, 'the status is in the status line only');
      assert.equal(errorBody.category, undefined, 'the internal category is not part of the wire format');
      const txn = response.body.data.transaction;
      assert.equal(txn.status, 'FAILED');
      assert.equal(txn.failureCode, 'INSUFFICIENT_BALANCE');
      assert.match(txn.id, /^txn_/);

      // The failed transaction is a real, retrievable record.
      const details = await server.call('GET', `/api/v1/transactions/${txn.id}?consistency=strong`, { as: alice.id });
      assert.equal(details.status, 200);
      assert.equal(details.body.data.transaction.status, 'FAILED');
      assert.deepEqual(
        details.body.data.timeline.map((step: { to: string }) => step.to),
        ['INITIATED', 'PROCESSING', 'FAILED'],
      );
    });

    test('a refused payment replays with its original status code and body', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      const key = uniqueKey('http-failed-retry');
      const first = await server.pay(alice.id, bob.upiId, 500, { key });
      const second = await server.pay(alice.id, bob.upiId, 500, { key });
      assert.equal(first.status, 422);
      assert.equal(second.status, 422);
      assert.equal(second.headers.get('idempotent-replayed'), 'true');
      assert.deepEqual(second.body.data, first.body.data);
      assert.equal(second.body.error?.code, 'INSUFFICIENT_BALANCE');
    });

    test('status codes follow the kind of failure: 404 unknown receiver, 403 fraud, 503 gateway down', async () => {
      const alice = await server.newUser();
      const bankId = await server.fundUser(alice.id, 500);

      const unknown = await server.pay(alice.id, 'nobody@miniupi', 10);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error?.code, 'RECEIVER_NOT_FOUND');
      assert.equal(unknown.body.data, undefined, 'nothing was recorded for a request that could not start');

      const scammer = server.app.users.register({ name: 'Quick Loans', upiHandle: 'httpscam', phone: '8777777777', pin: PIN, blacklisted: true });
      const fraud = await server.pay(alice.id, scammer.upiId, 10);
      assert.equal(fraud.status, 403);
      assert.equal(fraud.body.error?.code, 'FRAUD_SUSPECTED');
      assert.equal(fraud.body.data.transaction.status, 'FAILED');

      server.app.chaos.update({ bank: { down: true } });
      try {
        const down = await server.call('POST', '/api/v1/wallet/topup', {
          as: alice.id,
          key: uniqueKey(),
          body: { amount: 10, sourceId: bankId, pin: PIN },
        });
        assert.equal(down.status, 503);
        assert.equal(down.body.error?.code, 'GATEWAY_UNAVAILABLE');
        assert.equal(down.body.data.transaction.status, 'FAILED');
      } finally {
        server.app.chaos.reset();
        server.app.system.resetBreakers();
      }
    });
  });

  describe('transaction details and privacy', () => {
    test('a party gets the transaction, its timeline and its ledger entries', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 500);
      const paid = await server.pay(alice.id, bob.upiId, 120);
      const id = paid.body.data.transaction.id;

      const response = await server.call('GET', `/api/v1/transactions/${id}?consistency=strong`, { as: alice.id });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-data-source'), 'primary');
      assert.deepEqual(Object.keys(response.body.data).sort(), ['ledger', 'timeline', 'transaction']);
      assert.equal(response.body.data.transaction.id, id);
      assert.deepEqual(
        response.body.data.timeline.map((step: { to: string }) => step.to),
        ['INITIATED', 'PROCESSING', 'SUCCESS'],
      );
      assert.equal(response.body.data.ledger.length, 2);
    });

    test('someone who is not a party gets 404, the same as for an id that does not exist', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      const mallory = await server.newUser();
      await server.fundUser(alice.id, 500);
      const paid = await server.pay(alice.id, bob.upiId, 120);
      const id = paid.body.data.transaction.id;

      const snooping = await server.call('GET', `/api/v1/transactions/${id}?consistency=strong`, { as: mallory.id });
      const missing = await server.call('GET', '/api/v1/transactions/txn_0000000000000000', { as: mallory.id });

      for (const response of [snooping, missing]) {
        assert.equal(response.status, 404);
        assert.equal(response.body.error?.code, 'TRANSACTION_NOT_FOUND');
        assert.equal(response.body.data, undefined);
      }
      assert.deepEqual((await server.call('GET', '/api/v1/transactions?consistency=strong', { as: mallory.id })).body.data, []);
    });

    test("the receiver sees neither the payer's source nor the payer's balance", async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      const bankId = await server.fundUser(alice.id, 500);
      const paid = await server.pay(alice.id, bob.upiId, 120, { sourceId: bankId });
      const id = paid.body.data.transaction.id;
      assert.equal(paid.body.data.transaction.source.label, 'Test Bank XXXX9012', 'the payer sees their own source');

      const forReceiver = await server.call('GET', `/api/v1/transactions/${id}?consistency=strong`, { as: bob.id });
      assert.deepEqual(forReceiver.body.data.transaction.source, { id: '', type: 'BANK_ACCOUNT', label: 'Bank account' });
      const [payerSide, ownSide] = forReceiver.body.data.ledger;
      assert.equal(payerSide.accountId, 'EXTERNAL:(other party)');
      assert.equal(payerSide.balanceAfter, null);
      assert.equal(ownSide.balanceAfter, 120);
      assert.equal(JSON.stringify(forReceiver.body).includes(bankId), false);
      for (const leak of ['XXXX9012', 'Test Bank']) assert.equal(JSON.stringify(forReceiver.body).includes(leak), false, leak);

      const list = await server.call('GET', '/api/v1/transactions?consistency=strong', { as: bob.id });
      assert.deepEqual(list.body.data[0].source, { id: '', type: 'BANK_ACCOUNT', label: 'Bank account' });

      const walletPayment = await server.pay(alice.id, bob.upiId, 50);
      const forPayer = await server.call('GET', `/api/v1/transactions/${walletPayment.body.data.transaction.id}?consistency=strong`, { as: alice.id });
      assert.equal(forPayer.body.data.ledger[0].balanceAfter, 450);
      assert.equal(forPayer.body.data.ledger[1].balanceAfter, null, "the payer does not learn the receiver's balance");
      assert.equal(forPayer.body.data.ledger[1].accountId, 'WALLET:(other party)');
    });

    test('profiles never expose the PIN or its hash', async () => {
      const alice = await server.newUser();
      const responses = await Promise.all([
        server.call('GET', '/api/v1/me', { as: alice.id }),
        server.call('GET', '/api/v1/users'),
        server.call('GET', `/api/v1/users/resolve?upiId=${alice.upiId}`),
      ]);
      for (const response of responses) {
        const text = JSON.stringify(response.body).toLowerCase();
        for (const secret of ['pin', 'hash', 'salt']) assert.equal(text.includes(secret), false, `"${secret}" appears in a response`);
      }
    });
  });

  describe('refunds', () => {
    test('the payer gets 403 REFUND_NOT_ALLOWED; the receiver can refund; a second refund is 409', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      const mallory = await server.newUser();
      await server.fundUser(alice.id, 500);
      const paid = await server.pay(alice.id, bob.upiId, 200);
      const path = `/api/v1/transactions/${paid.body.data.transaction.id}/refund`;

      const byPayer = await server.call('POST', path, { as: alice.id, body: { pin: PIN } });
      assert.equal(byPayer.status, 403);
      assert.equal(byPayer.body.error?.code, 'REFUND_NOT_ALLOWED');

      const byStranger = await server.call('POST', path, { as: mallory.id, body: { pin: PIN } });
      assert.equal(byStranger.status, 404);
      assert.equal(byStranger.body.error?.code, 'TRANSACTION_NOT_FOUND');

      const wrongPin = await server.call('POST', path, { as: bob.id, body: { pin: '0000' } });
      assert.equal(wrongPin.status, 401);
      assert.equal(wrongPin.body.error?.code, 'INVALID_PIN');
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 20_000);

      const byReceiver = await server.call('POST', path, { as: bob.id, body: { pin: PIN } });
      assert.equal(byReceiver.status, 200);
      assert.equal(byReceiver.body.data.transaction.status, 'REFUNDED');
      assert.equal(byReceiver.body.data.transaction.source.id, '', 'still redacted for the receiver');
      assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).body.data.wallet.balancePaise, 50_000);
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 0);

      const again = await server.call('POST', path, { as: bob.id, body: { pin: PIN } });
      assert.equal(again.status, 409);
      assert.equal(again.body.error?.code, 'ILLEGAL_STATE_TRANSITION');
    });
  });

  describe('users and payment sources', () => {
    test('POST /users creates the profile with an empty wallet; duplicates are 409', async () => {
      const response = await server.call('POST', '/api/v1/users', {
        body: { name: 'Meera Nair', upiHandle: 'meera.n', phone: '8123456780', pin: '4321', email: 'meera@example.com', dailyLimit: 2_000 },
      });
      assert.equal(response.status, 201);
      const { user, wallet, sources } = response.body.data;
      assert.equal(user.upiId, 'meera.n@miniupi');
      assert.equal(user.dailyLimit, 2_000);
      assert.equal(user.email, 'meera@example.com');
      assert.equal(user.status, 'ACTIVE');
      assert.equal(wallet.balance, 0);
      assert.equal(wallet.userId, user.id);
      assert.deepEqual(
        sources.map((s: { type: string; isExternal: boolean }) => [s.type, s.isExternal]),
        [['WALLET', false]],
      );

      const sameHandle = await server.call('POST', '/api/v1/users', { body: { name: 'Other', upiHandle: 'meera.n', phone: '8123456781', pin: '4321' } });
      assert.equal(sameHandle.status, 409);
      assert.equal(sameHandle.body.error?.code, 'UPI_ID_TAKEN');
      const samePhone = await server.call('POST', '/api/v1/users', { body: { name: 'Other', upiHandle: 'other.n', phone: '8123456780', pin: '4321' } });
      assert.equal(samePhone.status, 409);
      assert.equal(samePhone.body.error?.code, 'PHONE_TAKEN');
    });

    test('POST /users validates its fields', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ phone: '8123456782', pin: '4321' }, 'MISSING_FIELD'],
        [{ name: 'Ok Name', phone: '12345', pin: '4321' }, 'INVALID_PHONE'],
        [{ name: 'Ok Name', phone: '8123456782', pin: '12' }, 'INVALID_PIN'],
        [{ name: 'Ok Name', phone: '8123456782', pin: 4321 }, 'MISSING_FIELD'],
        [{ name: 'Ok Name', phone: '8123456782', pin: '4321', dailyLimit: '5000' }, 'INVALID_FIELD'],
        [{ name: 'Ok Name', phone: '8123456782', pin: '4321', dailyLimit: 999_999 }, 'INVALID_DAILY_LIMIT'],
        [{ name: 'n'.repeat(51), phone: '8123456782', pin: '4321' }, 'FIELD_TOO_LONG'],
      ];
      for (const [body, code] of cases) {
        const response = await server.call('POST', '/api/v1/users', { body });
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.equal(response.body.error?.code, code, JSON.stringify(body));
      }
    });

    test('GET /users/resolve finds a payee by UPI ID', async () => {
      const user = await server.newUser();
      const found = await server.call('GET', `/api/v1/users/resolve?upiId=${encodeURIComponent(user.upiId.toUpperCase())}`);
      assert.equal(found.status, 200);
      assert.deepEqual(found.body.data, { id: user.id, name: user.name, upiId: user.upiId });

      const unknown = await server.call('GET', '/api/v1/users/resolve?upiId=ghost@miniupi');
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error?.code, 'UPI_ID_NOT_FOUND');
      const missing = await server.call('GET', '/api/v1/users/resolve');
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error?.code, 'MISSING_FIELD');
    });

    test('linking a bank account and a card returns masked sources; top-up needs one of them', async () => {
      const user = await server.newUser();
      const bank = await server.call('POST', '/api/v1/payment-sources/bank-accounts', {
        as: user.id,
        body: { bankName: 'HDFC Bank', accountNumber: '50100123456789', ifsc: 'hdfc0001234' }, // lower case is accepted
      });
      assert.equal(bank.status, 201);
      assert.deepEqual(
        { ...bank.body.data, id: 'x' },
        { id: 'x', type: 'BANK_ACCOUNT', label: 'HDFC Bank XXXX6789', isExternal: true, perTransactionLimit: 100_000 },
      );

      const card = await server.call('POST', '/api/v1/payment-sources/cards', {
        as: user.id,
        body: { network: 'Visa', cardNumber: '4111111111111111', expiryMonth: 12, expiryYear: new Date().getFullYear() + 2 },
      });
      assert.equal(card.status, 201);
      assert.equal(card.body.data.label, 'Visa card •••• 1111');
      assert.equal(card.body.data.perTransactionLimit, 50_000);
      assert.equal(JSON.stringify(card.body).includes('4111111111111111'), false);

      const badCard = await server.call('POST', '/api/v1/payment-sources/cards', {
        as: user.id,
        body: { network: 'Visa', cardNumber: '4111111111111112', expiryMonth: 12, expiryYear: 2099 },
      });
      assert.equal(badCard.status, 400);
      assert.equal(badCard.body.error?.code, 'INVALID_CARD_NUMBER');

      const topUp = await server.call('POST', '/api/v1/wallet/topup', {
        as: user.id,
        key: uniqueKey(),
        body: { amount: 750, sourceId: card.body.data.id, pin: PIN },
      });
      assert.equal(topUp.status, 201);
      assert.equal(topUp.body.data.transaction.type, 'TOPUP');
      assert.equal(topUp.body.data.transaction.note, 'Wallet top-up');

      const me = await server.call('GET', '/api/v1/me', { as: user.id });
      assert.equal(me.body.data.wallet.balance, 750);
      assert.equal(me.body.data.sources.length, 3);

      const noSource = await server.call('POST', '/api/v1/wallet/topup', { as: user.id, key: uniqueKey(), body: { amount: 10, pin: PIN } });
      assert.equal(noSource.status, 400);
      assert.equal(noSource.body.error?.code, 'MISSING_FIELD');

      const other = await server.newUser();
      const notYours = await server.call('POST', '/api/v1/wallet/topup', {
        as: other.id,
        key: uniqueKey(),
        body: { amount: 10, sourceId: bank.body.data.id, pin: PIN },
      });
      assert.equal(notYours.status, 404);
      assert.equal(notYours.body.error?.code, 'SOURCE_NOT_FOUND');
    });
  });

  describe('scheduled payments', () => {
    test('create, list and cancel; a cancelled payment cannot be cancelled again', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();

      const created = await server.call('POST', '/api/v1/scheduled-payments', {
        as: alice.id,
        body: { receiverUpiId: bob.upiId, amount: 99.5, delaySeconds: 3_600, note: 'Rent', pin: PIN },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.status, 'PENDING');
      assert.equal(created.body.data.amount, 99.5);
      assert.equal(created.body.data.receiverUpiId, bob.upiId);
      const id: string = created.body.data.id;

      const listed = await server.call('GET', '/api/v1/scheduled-payments', { as: alice.id });
      assert.deepEqual(
        listed.body.data.map((p: { id: string }) => p.id),
        [id],
      );
      assert.deepEqual((await server.call('GET', '/api/v1/scheduled-payments', { as: bob.id })).body.data, []);

      const byStranger = await server.call('DELETE', `/api/v1/scheduled-payments/${id}`, { as: bob.id });
      assert.equal(byStranger.status, 404);
      assert.equal(byStranger.body.error?.code, 'SCHEDULE_NOT_FOUND');

      const cancelled = await server.call('DELETE', `/api/v1/scheduled-payments/${id}`, { as: alice.id });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.data.status, 'CANCELLED');

      const again = await server.call('DELETE', `/api/v1/scheduled-payments/${id}`, { as: alice.id });
      assert.equal(again.status, 409);
      assert.equal(again.body.error?.code, 'SCHEDULE_NOT_PENDING');
    });

    test('scheduling validates the time, the PIN and the body', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      const base = { receiverUpiId: bob.upiId, amount: 10, pin: PIN };
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ ...base }, 400, 'MISSING_FIELD'],
        [{ ...base, delaySeconds: -5 }, 400, 'INVALID_SCHEDULE_TIME'],
        [{ ...base, executeAt: 'tomorrow-ish' }, 400, 'INVALID_SCHEDULE_TIME'],
        [{ ...base, executeAt: '2001-01-01T00:00:00.000Z' }, 400, 'INVALID_SCHEDULE_TIME'],
        [{ ...base, delaySeconds: 40 * 24 * 3_600 }, 400, 'INVALID_SCHEDULE_TIME'],
        [{ ...base, delaySeconds: '60' }, 400, 'INVALID_FIELD'],
        [{ ...base, delaySeconds: 60, pin: '0000' }, 401, 'INVALID_PIN'],
        [{ ...base, delaySeconds: 60, receiverUpiId: 'ghost@miniupi' }, 404, 'RECEIVER_NOT_FOUND'],
      ];
      for (const [body, status, code] of cases) {
        const response = await server.call('POST', '/api/v1/scheduled-payments', { as: alice.id, body });
        assert.equal(response.status, status, JSON.stringify(body));
        assert.equal(response.body.error?.code, code, JSON.stringify(body));
      }
      const accepted = await server.call('POST', '/api/v1/scheduled-payments', {
        as: alice.id,
        body: { ...base, executeAt: new Date(Date.now() + 60_000).toISOString() },
      });
      assert.equal(accepted.status, 201);
    });

    test('DELETE while the scheduled bank payment is in flight is 409, and the payment ends EXECUTED', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      const bankId = await server.fundUser(alice.id, 10);
      const created = await server.call('POST', '/api/v1/scheduled-payments', {
        as: alice.id,
        body: { receiverUpiId: bob.upiId, amount: 400, delaySeconds: 1, sourceId: bankId, pin: PIN },
      });
      const id: string = created.body.data.id;
      server.app.chaos.update({ bank: { latencyMs: 80 } });
      try {
        // The scheduler tick: claims the payment and waits for the bank.
        const running = server.app.scheduled.runDue(new Date(Date.now() + 5_000));

        const cancel = await server.call('DELETE', `/api/v1/scheduled-payments/${id}`, { as: alice.id });
        assert.equal(cancel.status, 409);
        assert.equal(cancel.body.error?.code, 'SCHEDULE_NOT_PENDING');

        await running;
      } finally {
        server.app.chaos.reset();
      }
      const listed = await server.call('GET', '/api/v1/scheduled-payments', { as: alice.id });
      assert.equal(listed.body.data[0].status, 'EXECUTED');
      assert.ok(listed.body.data[0].transactionId);
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 40_000);
    });
  });

  describe('reads', () => {
    test('GET /notifications lists what was delivered, newest first, from the node named in X-Data-Source', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 100);
      await server.pay(alice.id, bob.upiId, 40);
      await server.app.settle();

      const strong = await server.call('GET', '/api/v1/notifications?consistency=strong', { as: bob.id });
      assert.equal(strong.status, 200);
      assert.equal(strong.headers.get('x-data-source'), 'primary');
      assert.deepEqual(
        strong.body.data.map((n: { title: string; channel: string; status: string }) => [n.title, n.channel, n.status]).sort(),
        [
          ['Money received', 'PUSH', 'SENT'],
          ['Money received', 'SMS', 'SENT'],
        ],
      );

      const fromReplica = await server.call('GET', '/api/v1/notifications', { as: bob.id });
      assert.equal(fromReplica.headers.get('x-data-source'), 'replica', 'settled: the replica has everything');
      assert.deepEqual(fromReplica.body.data, strong.body.data);
    });

    test('GET /transactions is served by the replica once it has caught up, by the primary on request', async () => {
      const alice = await server.newUser();
      await server.fundUser(alice.id, 100);
      await server.app.settle();

      const normal = await server.call('GET', '/api/v1/transactions', { as: alice.id });
      const strong = await server.call('GET', '/api/v1/transactions?consistency=strong', { as: alice.id });
      assert.equal(normal.headers.get('x-data-source'), 'replica');
      assert.equal(strong.headers.get('x-data-source'), 'primary');
      assert.deepEqual(normal.body.data, strong.body.data);
      assert.equal(normal.body.data.length, 1);
    });
  });

  describe('same-site guard', () => {
    test('a request from another site (Origin or Sec-Fetch-Site) is refused with 403 CROSS_SITE_REQUEST', async () => {
      const alice = await server.newUser();
      const crossSite: Array<Record<string, string>> = [
        { Origin: 'https://evil.example' },
        { Origin: 'http://127.0.0.1:1' }, // same host name, different port: a different origin
        { 'Sec-Fetch-Site': 'cross-site' },
        { Origin: 'not a url' },
      ];
      for (const headers of crossSite) {
        const response = await server.call('GET', '/api/v1/me', { as: alice.id, headers });
        assert.equal(response.status, 403, JSON.stringify(headers));
        assert.equal(response.body.error?.code, 'CROSS_SITE_REQUEST');
      }
      const forged = await server.call('POST', '/api/v1/system/reset', { headers: { Origin: 'https://evil.example' } });
      assert.equal(forged.status, 403, 'the operator API is protected as well');
      assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).status, 200, 'and nothing was reset');
    });

    test('same-origin requests and clients that send no Origin pass', async () => {
      const alice = await server.newUser();
      const sameSite: Array<Record<string, string>> = [{ Origin: server.url }, { 'Sec-Fetch-Site': 'same-origin' }, {}];
      for (const headers of sameSite) {
        const response = await server.call('GET', '/api/v1/me', { as: alice.id, headers });
        assert.equal(response.status, 200, JSON.stringify(headers));
      }
    });

    test('a request addressed to a host name this server does not answer to is 403 HOST_NOT_ALLOWED', async () => {
      const rebinding = await rawGet(server.url, '/api/v1/users', { Host: 'evil.example' });
      assert.equal(rebinding.status, 403);
      assert.equal(rebinding.body.error.code, 'HOST_NOT_ALLOWED');

      const port = new URL(server.url).port;
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'LOCALHOST']) {
        assert.equal((await rawGet(server.url, '/api/v1/users', { Host: host })).status, 200, host);
      }
    });
  });

  describe('operator API', () => {
    test('GET /system/metrics and /system/design describe the running system', async () => {
      const metrics = await server.call('GET', '/api/v1/system/metrics');
      assert.equal(metrics.status, 200);
      for (const section of ['loadBalancer', 'rateLimiter', 'addressRateLimiter', 'cache', 'queue', 'database', 'locks', 'idempotency', 'circuitBreakers', 'transactions', 'chaos']) {
        assert.ok(section in metrics.body.data, `metrics has no "${section}" section`);
      }
      assert.equal(metrics.body.data.loadBalancer.nodes.length, 3);
      assert.deepEqual(
        metrics.body.data.circuitBreakers.map((b: { name: string }) => b.name),
        ['Bank network', 'Card network'],
      );

      const design = await server.call('GET', '/api/v1/system/design');
      assert.deepEqual(design.body.data.validationChain, ['Account status', 'Payment source', 'Available funds', 'Daily limit', 'Fraud rules']);
      assert.deepEqual(design.body.data.paymentStrategies, ['WALLET', 'BANK_ACCOUNT', 'CARD']);
    });

    test('the trace of a request can be fetched by its request id', async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 100);
      const paid = await server.pay(alice.id, bob.upiId, 10);
      const requestId = paid.headers.get('x-request-id')!;

      const trace = await server.call('GET', `/api/v1/system/traces/${requestId}`);
      assert.equal(trace.status, 200);
      assert.equal(trace.body.data.id, requestId);
      assert.equal(trace.body.data.label, 'POST /api/v1/transfers');
      const components = new Set(trace.body.data.steps.map((step: { component: string }) => step.component));
      for (const expected of ['LoadBalancer', 'RateLimiter', 'Auth', 'Idempotency', 'Lock', 'Validation', 'Ledger', 'Database', 'State']) {
        assert.ok(components.has(expected), `the trace has no ${expected} step`);
      }

      const unknown = await server.call('GET', '/api/v1/system/traces/req_0000000000000000');
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error?.code, 'TRACE_NOT_FOUND');

      const feed = await server.call('GET', '/api/v1/system/feed?limit=5');
      assert.equal(feed.status, 200);
      assert.equal(feed.body.data.length, 5);
    });

    test('GET /system/ledger/verify audits the ledger; POST /system/ledger/tamper-test proves it is append-only', async () => {
      const alice = await server.newUser();
      await server.fundUser(alice.id, 100);

      const verify = await server.call('GET', '/api/v1/system/ledger/verify');
      assert.equal(verify.status, 200);
      assert.equal(verify.body.data.healthy, true);
      assert.equal(verify.body.data.chainIntact, true);
      assert.ok(verify.body.data.entries >= 2);

      const tamper = await server.call('POST', '/api/v1/system/ledger/tamper-test');
      assert.equal(tamper.status, 200);
      assert.deepEqual(Object.keys(tamper.body.data).sort(), ['delete', 'replace', 'update']);
      for (const attempt of ['update', 'delete', 'replace']) {
        assert.equal(tamper.body.data[attempt].blocked, true, attempt);
        assert.match(tamper.body.data[attempt].databaseSaid, /append-only/);
      }
      assert.equal((await server.call('GET', '/api/v1/system/ledger/verify')).body.data.healthy, true);

      const ledger = await server.call('GET', '/api/v1/system/ledger?limit=2&consistency=strong');
      assert.equal(ledger.headers.get('x-data-source'), 'primary');
      assert.equal(ledger.body.data.length, 2);
    });

    test('PUT /system/chaos applies valid settings and rejects invalid ones with 400', async () => {
      try {
        const applied = await server.call('PUT', '/api/v1/system/chaos', { body: { card: { down: true }, replicaLagMs: 5 } });
        assert.equal(applied.status, 200);
        assert.equal(applied.body.data.card.down, true);
        assert.equal(applied.body.data.replicaLagMs, 5);
        assert.equal(applied.body.data.bank.down, false);

        for (const body of [{ bank: { failureRate: 2 } }, { replicaLagMs: -1 }, { failNextCredit: 'yes' }]) {
          const rejected = await server.call('PUT', '/api/v1/system/chaos', { body });
          assert.equal(rejected.status, 400, JSON.stringify(body));
          assert.equal(rejected.body.error?.code, 'INVALID_CHAOS_SETTING');
        }
        assert.equal(server.app.chaos.state.card.down, true, 'a rejected patch leaves the settings as they were');
      } finally {
        server.app.chaos.reset();
      }
    });

    test('PUT /system/nodes/:id validates the node and the flag', async () => {
      const unknown = await server.call('PUT', '/api/v1/system/nodes/app-node-99', { body: { healthy: false } });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error?.code, 'NODE_NOT_FOUND');
      const badFlag = await server.call('PUT', '/api/v1/system/nodes/app-node-1', { body: { healthy: 'no' } });
      assert.equal(badFlag.status, 400);
      assert.equal(badFlag.body.error?.code, 'INVALID_FIELD');
    });

    test('POST /system/queue/redrive and /system/breakers/reset answer with what they did', async () => {
      const redrive = await server.call('POST', '/api/v1/system/queue/redrive');
      assert.equal(redrive.status, 200);
      assert.deepEqual(redrive.body.data, { redriven: 0 });

      const reset = await server.call('POST', '/api/v1/system/breakers/reset');
      assert.equal(reset.status, 200);
      assert.deepEqual(reset.body.data, { reset: true });
      for (const breaker of server.app.system.snapshot().circuitBreakers) assert.equal(breaker.state, 'CLOSED');
    });

    test('GET /system/docs lists the design documents', async () => {
      const response = await server.call('GET', '/api/v1/system/docs');
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(response.body.data));
      for (const doc of response.body.data) {
        assert.match(doc.file, /\.md$/);
        assert.equal(typeof doc.title, 'string');
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('HTTP API: load balancer', () => {
  let server: TestServer;

  before(async () => {
    server = await startServer();
  });

  after(() => server.close());

  const servedBy = async (count: number) => {
    const nodes: string[] = [];
    for (let i = 0; i < count; i += 1) nodes.push((await server.call('GET', '/api/v1/users')).headers.get('x-served-by') ?? '');
    return nodes;
  };

  test('X-Served-By rotates across the app nodes, round robin', async () => {
    assert.deepEqual(await servedBy(7), [
      'app-node-1',
      'app-node-2',
      'app-node-3',
      'app-node-1',
      'app-node-2',
      'app-node-3',
      'app-node-1',
    ]);
  });

  test('any node can serve any request: a payment made through one node is visible through the next', async () => {
    const alice = await server.newUser();
    const first = await server.call('GET', '/api/v1/me', { as: alice.id });
    const second = await server.call('GET', '/api/v1/me', { as: alice.id });
    assert.notEqual(first.headers.get('x-served-by'), second.headers.get('x-served-by'));
    assert.deepEqual(first.body.data, second.body.data);
  });

  test('an unhealthy node is skipped; with no healthy node the API answers 503', async () => {
    try {
      const marked = await server.call('PUT', '/api/v1/system/nodes/app-node-2', { body: { healthy: false } });
      assert.equal(marked.status, 200);
      assert.equal(marked.body.data.healthy, false);
      const nodes = await servedBy(6);
      assert.equal(nodes.includes('app-node-2'), false);
      assert.deepEqual(new Set(nodes), new Set(['app-node-1', 'app-node-3']));

      await server.call('PUT', '/api/v1/system/nodes/app-node-1', { body: { healthy: false } });
      await server.call('PUT', '/api/v1/system/nodes/app-node-3', { body: { healthy: false } });
      const down = await server.call('GET', '/api/v1/users');
      assert.equal(down.status, 503);
      assert.equal(down.body.error?.code, 'NO_HEALTHY_NODES');
      assert.equal(down.headers.get('x-served-by'), null);

      // The operator API is not load balanced, so it can still bring nodes back.
      assert.equal((await server.call('GET', '/api/v1/system/metrics')).status, 200);
    } finally {
      for (const id of ['app-node-1', 'app-node-2', 'app-node-3']) {
        await server.call('PUT', `/api/v1/system/nodes/${id}`, { body: { healthy: true } });
      }
    }
    assert.equal((await server.call('GET', '/api/v1/users')).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------
describe('HTTP API: rate limiting', () => {
  test('per user: 429 with Retry-After once the bucket is empty; other users are unaffected', async () => {
    const server = await startServer({ rateLimitCapacity: 3, rateLimitRefillPerSecond: 0.01 });
    try {
      const alice = await server.newUser();
      const bob = await server.newUser();

      const remaining: Array<string | null> = [];
      for (let i = 0; i < 3; i += 1) {
        const ok = await server.call('GET', '/api/v1/me', { as: alice.id });
        assert.equal(ok.status, 200);
        remaining.push(ok.headers.get('x-ratelimit-remaining'));
      }
      assert.deepEqual(remaining, ['2', '1', '0']);

      const limited = await server.call('GET', '/api/v1/me', { as: alice.id });
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error?.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal(limited.headers.get('x-ratelimit-remaining'), '0');
      const retryAfter = Number(limited.headers.get('retry-after'));
      assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After was ${limited.headers.get('retry-after')}`);
      assert.equal(Math.ceil(limited.body.error?.details.retryAfterMs / 1000), retryAfter);
      assert.equal(limited.body.error?.requestId, limited.headers.get('x-request-id'));

      // A payment is limited just the same, before anything is executed.
      const payment = await server.pay(alice.id, bob.upiId, 1);
      assert.equal(payment.status, 429);

      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).status, 200, "bob has his own bucket");
      const anonymous = await server.call('GET', '/api/v1/users');
      assert.equal(anonymous.status, 200, 'routes without a signed-in user do not use a user bucket');
      assert.equal(anonymous.headers.get('x-ratelimit-remaining'), null);

      const stats = server.app.system.snapshot().rateLimiter;
      assert.equal(stats.capacity, 3);
      assert.ok(stats.rejected >= 2);
    } finally {
      await server.close();
    }
  });

  test('per user: the bucket refills over time', async (t) => {
    const server = await startServer({ rateLimitCapacity: 1, rateLimitRefillPerSecond: 0.5 }); // one token per 2 s
    try {
      const alice = await server.newUser();
      const advance = freezeClock(t);
      assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).status, 200);
      const limited = await server.call('GET', '/api/v1/me', { as: alice.id });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '2');

      advance(1_500);
      const stillLimited = await server.call('GET', '/api/v1/me', { as: alice.id });
      assert.equal(stillLimited.status, 429);
      assert.equal(stillLimited.headers.get('retry-after'), '1', 'rounded up to whole seconds');

      advance(500);
      assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).status, 200);
    } finally {
      await server.close();
    }
  });

  test('per address: a flood from one address is cut off before the caller is even identified', async () => {
    const server = await startServer({ ipRateLimitCapacity: 4, ipRateLimitRefillPerSecond: 0.01 });
    try {
      for (let i = 0; i < 4; i += 1) assert.equal((await server.call('GET', '/api/v1/users')).status, 200);

      const limited = await server.call('GET', '/api/v1/users');
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error?.code, 'RATE_LIMIT_EXCEEDED');
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);

      // Claiming to be someone else in a header does not buy a fresh bucket.
      for (const as of ['usr_aaaaaaaaaaaaaaaa', 'usr_bbbbbbbbbbbbbbbb']) {
        assert.equal((await server.call('GET', '/api/v1/me', { as })).status, 429);
      }
      assert.equal((await server.call('GET', '/api/v1/does-not-exist')).status, 429);

      // The operator API and the health check are outside the limiter.
      assert.equal((await server.call('GET', '/api/v1/system/metrics')).status, 200);
      assert.equal((await server.call('GET', '/health')).status, 200);
      assert.ok(server.app.system.snapshot().addressRateLimiter.rejected >= 4);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('HTTP API: PIN lockout', () => {
  test('after pinMaxAttempts wrong PINs the account answers 401 PIN_LOCKED, even to the right PIN', async () => {
    const server = await startServer({ pinMaxAttempts: 3, pinLockMs: 60_000 });
    try {
      const alice = await server.newUser();
      const bob = await server.newUser();
      await server.fundUser(alice.id, 100);

      const attemptsLeft: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const wrong = await server.pay(alice.id, bob.upiId, 10, { pin: '9999' });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body.error?.code, 'INVALID_PIN');
        attemptsLeft.push(wrong.body.error?.details.attemptsLeft);
      }
      assert.deepEqual(attemptsLeft, [2, 1, 0]);

      const locked = await server.pay(alice.id, bob.upiId, 10);
      assert.equal(locked.status, 401);
      assert.equal(locked.body.error?.code, 'PIN_LOCKED');
      assert.equal(locked.body.error?.details.retryAfterSeconds, 60);
      assert.equal(locked.body.data, undefined);

      // Every PIN-protected action is locked, reads are not, and nobody else is affected.
      const refund = await server.call('POST', '/api/v1/transactions/txn_x/refund', { as: alice.id, body: { pin: PIN } });
      assert.equal(refund.body.error?.code, 'PIN_LOCKED');
      const me = await server.call('GET', '/api/v1/me', { as: alice.id });
      assert.equal(me.status, 200);
      assert.equal(me.body.data.wallet.balancePaise, 10_000);
      assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 0);
      await server.fundUser(bob.id, 50);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('HTTP API: demo reset', () => {
  test('POST /system/reset rebuilds the seeded demo world', async () => {
    const server = await startServer({ seedDemoData: true });
    try {
      const before = await server.call('GET', '/api/v1/users');
      assert.deepEqual(
        before.body.data.map((u: { upiId: string }) => u.upiId),
        ['alice@miniupi', 'bob@miniupi', 'charlie@miniupi', 'diya.store@miniupi', 'quickloan@miniupi'],
      );
      const alice = before.body.data[0];
      await server.newUser();
      const paid = await server.pay(alice.id, 'bob@miniupi', 1_000);
      assert.equal(paid.status, 201);

      const reset = await server.call('POST', '/api/v1/system/reset');
      assert.equal(reset.status, 200);
      assert.deepEqual(reset.body.data, { reset: true });

      const after = await server.call('GET', '/api/v1/users');
      assert.equal(after.body.data.length, 5, 'the extra user is gone');
      const newAlice = after.body.data[0];
      assert.notEqual(newAlice.id, alice.id);
      assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).status, 401, 'old ids no longer identify anyone');
      const me = await server.call('GET', '/api/v1/me', { as: newAlice.id });
      assert.equal(me.body.data.wallet.balance, 24_071);
      assert.equal((await server.call('GET', '/api/v1/system/ledger/verify')).body.data.healthy, true);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('HTTP API: sign-in and session tokens', () => {
  let server: TestServer;

  before(async () => {
    server = await startServer({ sessionSecret: 'http-test-secret', sessionTtlMs: 30 * 60_000 });
  });

  after(() => server.close());

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = (upiId: unknown, pin: unknown) => server.call('POST', '/api/v1/auth/login', { body: { upiId, pin } });
  const tokenFor = async (upiId: string) => {
    const response = await login(upiId, PIN);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.token as string;
  };

  test('POST /auth/login returns a token, its expiry and the profile', async () => {
    const alice = await server.newUser();
    const before = Date.now();

    const response = await login(alice.upiId, PIN);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body.data).sort(), ['expiresAt', 'token', 'user']);
    const { token, expiresAt, user } = response.body.data;
    assert.equal(token.split('.').length, 3);
    assert.equal(token.split('.')[0], alice.id);
    const lifetime = Date.parse(expiresAt) - before;
    assert.ok(lifetime > 29 * 60_000 && lifetime <= 30 * 60_000 + 5_000, `expires in ${lifetime} ms`);
    assert.equal(user.id, alice.id);
    assert.equal(user.upiId, alice.upiId);
    for (const secret of ['pin', 'hash', 'salt']) assert.equal(JSON.stringify(user).toLowerCase().includes(secret), false);
  });

  test('a wrong PIN and an unknown UPI ID get the very same 401 answer', async () => {
    const alice = await server.newUser();

    const wrongPin = await login(alice.upiId, '0000');
    const unknown = await login('nobody@miniupi', PIN);

    for (const response of [wrongPin, unknown]) {
      assert.equal(response.status, 401);
      assert.equal(response.body.error?.code, 'INVALID_CREDENTIALS');
      assert.equal(response.body.data, undefined);
    }
    const comparable = (response: ApiResponse) => ({ ...response.body.error, requestId: undefined });
    assert.deepEqual(comparable(wrongPin), comparable(unknown), 'nothing in the body tells the two apart');
  });

  test('login validates its body', async () => {
    const alice = await server.newUser();
    const cases: Array<[unknown, number, string]> = [
      [{ pin: PIN }, 400, 'MISSING_FIELD'],
      [{ upiId: '', pin: PIN }, 400, 'MISSING_FIELD'],
      [{ upiId: 12345, pin: PIN }, 400, 'MISSING_FIELD'],
      [{ upiId: 'x'.repeat(61), pin: PIN }, 400, 'FIELD_TOO_LONG'],
      [[alice.upiId, PIN], 400, 'INVALID_BODY'],
      [{ upiId: alice.upiId }, 401, 'INVALID_CREDENTIALS'],
      [{ upiId: alice.upiId, pin: 1234 }, 401, 'INVALID_CREDENTIALS'],
    ];
    for (const [body, status, code] of cases) {
      const response = await server.call('POST', '/api/v1/auth/login', { body });
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(response.body.error?.code, code, JSON.stringify(body));
    }
  });

  test('Authorization: Bearer identifies the caller on every protected route', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    await server.fundUser(alice.id, 500);
    const token = await tokenFor(alice.upiId);

    const me = await server.call('GET', '/api/v1/me', { headers: bearer(token) });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.id, alice.id);
    assert.equal(me.body.data.wallet.balancePaise, 50_000);
    assert.ok(me.headers.get('x-ratelimit-remaining'), 'a token-authenticated request uses the user bucket too');

    const paid = await server.call('POST', '/api/v1/transfers', {
      headers: bearer(token),
      key: uniqueKey('bearer-pay'),
      body: { receiverUpiId: bob.upiId, amount: 120, pin: PIN },
    });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.data.transaction.sender.id, alice.id);

    const history = await server.call('GET', '/api/v1/transactions?consistency=strong', { headers: bearer(token) });
    assert.equal(history.body.data.length, 2);
    assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 12_000);
  });

  test('a session token always wins over an X-User-Id header', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    const token = await tokenFor(alice.upiId);

    const response = await server.call('GET', '/api/v1/me', { as: bob.id, headers: bearer(token) });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.id, alice.id);
  });

  test('a bad token is 401 INVALID_TOKEN, and a valid X-User-Id next to it does not rescue the request', async () => {
    const alice = await server.newUser();
    const mallory = await server.newUser();
    const token = await tokenFor(mallory.upiId);
    const [, expiry, signature] = token.split('.');

    for (const forged of [`${alice.id}.${expiry}.${signature}`, `${token}x`, 'not.a.token', 'garbage']) {
      const response = await server.call('GET', '/api/v1/me', { as: alice.id, headers: bearer(forged) });
      assert.equal(response.status, 401, forged);
      assert.equal(response.body.error?.code, 'INVALID_TOKEN');
      assert.equal(response.body.data, undefined);
    }
  });

  test('an expired token is 401 TOKEN_EXPIRED', async (t) => {
    // Its own server: the clock is moved forward here, which the shared one should not see.
    const shortLived = await startServer({ sessionTtlMs: 60_000 });
    try {
      const alice = await shortLived.newUser();
      const session = await shortLived.call('POST', '/api/v1/auth/login', { body: { upiId: alice.upiId, pin: PIN } });
      const headers = bearer(session.body.data.token);
      const advance = freezeClock(t);

      advance(59_000);
      assert.equal((await shortLived.call('GET', '/api/v1/me', { headers })).status, 200);
      advance(2_000);
      const expired = await shortLived.call('GET', '/api/v1/me', { headers });
      assert.equal(expired.status, 401);
      assert.equal(expired.body.error?.code, 'TOKEN_EXPIRED');
      const payment = await shortLived.call('POST', '/api/v1/transfers', { headers, key: uniqueKey(), body: { receiverUpiId: alice.upiId, amount: 1, pin: PIN } });
      assert.equal(payment.status, 401, 'an expired session cannot pay either');

      // Signing in again gives a working token.
      const renewed = await shortLived.call('POST', '/api/v1/auth/login', { body: { upiId: alice.upiId, pin: PIN } });
      assert.equal((await shortLived.call('GET', '/api/v1/me', { headers: bearer(renewed.body.data.token) })).status, 200);
    } finally {
      await shortLived.close();
    }
  });

  test('an Authorization header that is not a Bearer token is ignored, not trusted', async () => {
    const alice = await server.newUser();
    for (const value of ['Basic YWxpY2U6MTIzNA==', 'Bearer', `Token ${alice.id}`, alice.id]) {
      const alone = await server.call('GET', '/api/v1/me', { headers: { Authorization: value } });
      assert.equal(alone.status, 401, value);
      assert.equal(alone.body.error?.code, 'UNAUTHENTICATED');
    }
  });

  test('a token issued by another server (another secret) is refused', async () => {
    const other = await startServer({ sessionSecret: 'a-different-secret' });
    try {
      const stranger = await other.newUser();
      const login = await other.call('POST', '/api/v1/auth/login', { body: { upiId: stranger.upiId, pin: PIN } });
      const response = await server.call('GET', '/api/v1/me', { headers: bearer(login.body.data.token) });
      assert.equal(response.status, 401);
      assert.equal(response.body.error?.code, 'INVALID_TOKEN');
    } finally {
      await other.close();
    }
  });

  test('wrong PINs at sign-in lock sign-in (401 PIN_LOCKED) but not the owner\'s payments', async () => {
    const strict = await startServer({ pinMaxAttempts: 2, pinLockMs: 60_000 });
    try {
      const alice = await strict.newUser();
      const bob = await strict.newUser();
      const signIn = (pin: string) => strict.call('POST', '/api/v1/auth/login', { body: { upiId: alice.upiId, pin } });

      assert.equal((await signIn('0000')).body.error?.code, 'INVALID_CREDENTIALS');
      assert.equal((await signIn('0001')).body.error?.code, 'INVALID_CREDENTIALS');

      const locked = await signIn(PIN);
      assert.equal(locked.status, 401);
      assert.equal(locked.body.error?.code, 'PIN_LOCKED');

      // Sign-in attempts are counted apart from payment PINs: the owner can still pay.
      await strict.fundUser(alice.id, 100);
      const payment = await strict.pay(alice.id, bob.upiId, 1);
      assert.equal(payment.status, 201);

      // A session obtained before the lock keeps working too; payments have their own counter.
      assert.equal((await strict.pay(alice.id, bob.upiId, 1, { pin: '0000' })).body.error?.code, 'INVALID_PIN');
      assert.equal((await strict.pay(alice.id, bob.upiId, 1, { pin: '0000' })).body.error?.code, 'INVALID_PIN');
      assert.equal((await strict.pay(alice.id, bob.upiId, 1)).body.error?.code, 'PIN_LOCKED');

      const other = await strict.call('POST', '/api/v1/auth/login', { body: { upiId: bob.upiId, pin: PIN } });
      assert.equal(other.status, 200, 'nobody else is locked');
    } finally {
      await strict.close();
    }
  });
});

describe('HTTP API: header identity switched off (allowHeaderIdentity: false)', () => {
  let server: TestServer;

  before(async () => {
    server = await startServer({ allowHeaderIdentity: false });
  });

  after(() => server.close());

  test('X-User-Id is no longer accepted anywhere; only a session token is', async () => {
    const alice = await server.newUser();

    for (const [method, path] of [
      ['GET', '/api/v1/me'],
      ['GET', '/api/v1/transactions'],
      ['GET', '/api/v1/notifications'],
      ['POST', '/api/v1/transfers'],
      ['POST', '/api/v1/wallet/topup'],
    ] as const) {
      const response = await server.call(method, path, { as: alice.id, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.body.error?.code, 'UNAUTHENTICATED');
    }

    const session = await server.call('POST', '/api/v1/auth/login', { body: { upiId: alice.upiId, pin: PIN } });
    assert.equal(session.status, 200, 'signing in needs no identity');
    const me = await server.call('GET', '/api/v1/me', { headers: { Authorization: `Bearer ${session.body.data.token}` } });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.id, alice.id);
  });

  test('a whole payment works with tokens only, and a forged header cannot act for someone else', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    const tokenOf = async (upiId: string) =>
      (await server.call('POST', '/api/v1/auth/login', { body: { upiId, pin: PIN } })).body.data.token as string;
    const asAlice = { Authorization: `Bearer ${await tokenOf(alice.upiId)}` };
    const asBob = { Authorization: `Bearer ${await tokenOf(bob.upiId)}` };

    const bank = await server.call('POST', '/api/v1/payment-sources/bank-accounts', {
      headers: asAlice,
      body: { bankName: 'Test Bank', accountNumber: '123456789012', ifsc: 'TEST0001234' },
    });
    assert.equal(bank.status, 201);
    const topUp = await server.call('POST', '/api/v1/wallet/topup', {
      headers: asAlice,
      key: uniqueKey(),
      body: { amount: 500, sourceId: bank.body.data.id, pin: PIN },
    });
    assert.equal(topUp.status, 201);
    const paid = await server.call('POST', '/api/v1/transfers', {
      headers: asAlice,
      key: uniqueKey(),
      body: { receiverUpiId: bob.upiId, amount: 200, pin: PIN },
    });
    assert.equal(paid.status, 201);

    // Bob, signed in as himself, adds a header claiming to be Alice: he is still Bob.
    const spoof = await server.call('GET', '/api/v1/me', { as: alice.id, headers: asBob });
    assert.equal(spoof.body.data.user.id, bob.id);
    assert.equal(spoof.body.data.wallet.balancePaise, 20_000);
    const refund = await server.call('POST', `/api/v1/transactions/${paid.body.data.transaction.id}/refund`, {
      as: alice.id,
      body: { pin: PIN },
    });
    assert.equal(refund.status, 401, 'the header alone identifies nobody');
  });

  test('public routes stay public', async () => {
    assert.equal((await server.call('GET', '/api/v1/users')).status, 200);
    assert.equal((await server.call('GET', '/health')).status, 200);
    assert.equal((await server.call('GET', '/api/v1/system/metrics')).status, 200);
  });
});

describe('HTTP API: operator key (operatorKey set)', () => {
  const OPERATOR_KEY = 'sekret-operator-key';
  let server: TestServer;

  before(async () => {
    server = await startServer({ operatorKey: OPERATOR_KEY });
  });

  after(() => server.close());

  const changes: Array<[string, string, unknown]> = [
    ['PUT', '/api/v1/system/chaos', { replicaLagMs: 7 }],
    ['PUT', '/api/v1/system/nodes/app-node-1', { healthy: true }],
    ['POST', '/api/v1/system/queue/redrive', undefined],
    ['POST', '/api/v1/system/breakers/reset', undefined],
    ['POST', '/api/v1/system/ledger/tamper-test', undefined],
    ['POST', '/api/v1/system/reset', undefined],
  ];

  test('every state-changing operator endpoint is 403 OPERATOR_KEY_REQUIRED without the key', async () => {
    const alice = await server.newUser();
    for (const [method, path, body] of changes) {
      const response = await server.call(method, path, { body });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.body.error?.code, 'OPERATOR_KEY_REQUIRED');
    }
    assert.equal(server.app.chaos.state.replicaLagMs, 0, 'the refused chaos change was not applied');
    assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).status, 200, 'and the refused reset wiped nothing');
  });

  test('a wrong key is refused just the same, whatever its length', async () => {
    for (const key of ['wrong', 'sekret-operator-kez', `${OPERATOR_KEY}x`, OPERATOR_KEY.toUpperCase(), ' ']) {
      const response = await server.call('PUT', '/api/v1/system/chaos', { body: { replicaLagMs: 7 }, headers: { 'X-Operator-Key': key } });
      assert.equal(response.status, 403, JSON.stringify(key));
      assert.equal(response.body.error?.code, 'OPERATOR_KEY_REQUIRED');
    }
    assert.equal(server.app.chaos.state.replicaLagMs, 0);
  });

  test('with the right key in X-Operator-Key the same endpoints work', async () => {
    try {
      for (const [method, path, body] of changes.filter(([, path]) => !path.endsWith('/reset') || path.includes('breakers'))) {
        const response = await server.call(method, path, { body, headers: { 'X-Operator-Key': OPERATOR_KEY } });
        assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
      }
      assert.equal(server.app.chaos.state.replicaLagMs, 7);
    } finally {
      server.app.chaos.reset();
    }
  });

  test('the demo reset needs the key too, and works with it', async () => {
    const extra = await server.newUser();
    const refused = await server.call('POST', '/api/v1/system/reset');
    assert.equal(refused.status, 403);
    assert.equal((await server.call('GET', '/api/v1/me', { as: extra.id })).status, 200);

    const done = await server.call('POST', '/api/v1/system/reset', { headers: { 'X-Operator-Key': OPERATOR_KEY } });
    assert.equal(done.status, 200);
    assert.equal((await server.call('GET', '/api/v1/me', { as: extra.id })).status, 401, 'the data was wiped');
  });

  test('reading stays open: dashboards need no key', async () => {
    for (const path of ['/metrics', '/design', '/feed', '/ledger', '/ledger/verify', '/docs']) {
      const response = await server.call('GET', `/api/v1/system${path}`);
      assert.equal(response.status, 200, path);
    }
  });

  test('the public API does not need (or accept as identity) the operator key', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    await server.fundUser(alice.id, 100);
    assert.equal((await server.pay(alice.id, bob.upiId, 10)).status, 201);
    const withKeyOnly = await server.call('GET', '/api/v1/me', { headers: { 'X-Operator-Key': OPERATOR_KEY } });
    assert.equal(withKeyOnly.status, 401, 'an operator key is not a user');
  });
});

// ---------------------------------------------------------------------------------------------
describe('HTTP API: cursor pagination of GET /transactions', () => {
  let server: TestServer;

  before(async () => {
    server = await startServer();
  });

  after(() => server.close());

  interface Page {
    ids: string[];
    nextCursor: string | null;
    response: ApiResponse;
  }

  const pageOf = async (userId: string, limit: number, before?: string | null): Promise<Page> => {
    const query = `limit=${limit}&consistency=strong${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const response = await server.call('GET', `/api/v1/transactions?${query}`, { as: userId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const page = (response.body as { page?: { nextCursor: string | null } }).page;
    assert.ok(page, 'the response carries a page object');
    return { ids: response.body.data.map((txn: { id: string }) => txn.id), nextCursor: page.nextCursor, response };
  };

  /** A user with `count` transactions: one top-up and count - 1 payments. */
  const userWithHistory = async (count: number) => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    await server.fundUser(alice.id, 1_000);
    for (let i = 1; i < count; i += 1) assert.equal((await server.pay(alice.id, bob.upiId, i)).status, 201);
    return { alice, bob };
  };

  test('the response is { data, page: { nextCursor } }', async () => {
    const { alice } = await userWithHistory(3);
    const { response } = await pageOf(alice.id, 2);
    assert.deepEqual(Object.keys(response.body).sort(), ['data', 'page']);
    assert.deepEqual(Object.keys((response.body as { page: object }).page), ['nextCursor']);
  });

  test('pages neither overlap nor skip, and the last page has a null cursor', async () => {
    const { alice } = await userWithHistory(7);
    const everything = await pageOf(alice.id, 100);
    assert.equal(everything.ids.length, 7);
    assert.equal(everything.nextCursor, null);

    const first = await pageOf(alice.id, 3);
    const second = await pageOf(alice.id, 3, first.nextCursor);
    const third = await pageOf(alice.id, 3, second.nextCursor);

    assert.deepEqual([first.ids.length, second.ids.length, third.ids.length], [3, 3, 1]);
    assert.equal(typeof first.nextCursor, 'string');
    assert.equal(typeof second.nextCursor, 'string');
    assert.equal(third.nextCursor, null);
    const walked = [...first.ids, ...second.ids, ...third.ids];
    assert.equal(new Set(walked).size, 7, 'no transaction appears on two pages');
    assert.deepEqual(walked, everything.ids, 'none is skipped and the order is the same, newest first');
  });

  test('a last page that is exactly full still ends with a null cursor', async () => {
    const { alice } = await userWithHistory(6);
    const first = await pageOf(alice.id, 3);
    const second = await pageOf(alice.id, 3, first.nextCursor);
    assert.equal(second.ids.length, 3);
    assert.equal(second.nextCursor, null);
    assert.equal((await pageOf(alice.id, 6)).nextCursor, null);
  });

  test('walking page by page with limit 1 visits every transaction once', async () => {
    const { alice } = await userWithHistory(5);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await pageOf(alice.id, 1, cursor);
      assert.equal(page.ids.length, 1);
      seen.push(...page.ids);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5);
  });

  test('payments made while someone is paging do not shift the pages they have yet to see', async () => {
    const { alice, bob } = await userWithHistory(5);
    const everything = await pageOf(alice.id, 100);
    const first = await pageOf(alice.id, 2);

    await sleep(2); // a later millisecond: the new payments are unambiguously newer than the cursor
    await server.pay(alice.id, bob.upiId, 1);
    await server.pay(alice.id, bob.upiId, 2);

    const second = await pageOf(alice.id, 2, first.nextCursor);
    assert.deepEqual(second.ids, everything.ids.slice(2, 4), 'page 2 is what it would have been');
    const fresh = await pageOf(alice.id, 2);
    assert.equal(fresh.ids.some((id) => everything.ids.includes(id)), false, 'the new payments are on the new first page');
  });

  test('the receiver pages through the same payments from their side', async () => {
    const { bob } = await userWithHistory(5); // bob received four payments
    const first = await pageOf(bob.id, 3);
    const second = await pageOf(bob.id, 3, first.nextCursor);
    assert.deepEqual([first.ids.length, second.ids.length], [3, 1]);
    assert.equal(second.nextCursor, null);
    for (const txn of [...first.response.body.data, ...second.response.body.data]) {
      assert.equal(txn.receiver.id, bob.id);
      assert.equal(txn.source.id, '', "the payer's source stays redacted on every page");
    }
  });

  test("a cursor is only a position: used by someone else it shows them nothing of the owner's history", async () => {
    const { alice } = await userWithHistory(4);
    const mallory = await server.newUser();
    const first = await pageOf(alice.id, 2);
    const snooped = await pageOf(mallory.id, 2, first.nextCursor);
    assert.deepEqual(snooped.ids, []);
    assert.equal(snooped.nextCursor, null);
  });

  test('a cursor that was not issued by the server is 400 INVALID_CURSOR', async () => {
    const { alice } = await userWithHistory(2);
    const notADate = Buffer.from('yesterday|txn_1').toString('base64url');
    const noId = Buffer.from('2026-01-01T00:00:00.000Z').toString('base64url');
    for (const cursor of ['garbage', '!!!', notADate, noId, '%00']) {
      const response = await server.call('GET', `/api/v1/transactions?before=${cursor}`, { as: alice.id });
      assert.equal(response.status, 400, cursor);
      assert.equal(response.body.error?.code, 'INVALID_CURSOR');
    }
  });

  test('an empty history is one empty page', async () => {
    const nobody = await server.newUser();
    const page = await pageOf(nobody.id, 10);
    assert.deepEqual(page.ids, []);
    assert.equal(page.nextCursor, null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('HTTP API: amounts in paise', () => {
  let server: TestServer;

  before(async () => {
    server = await startServer();
  });

  after(() => server.close());

  const transfer = (from: string, toUpiId: string, money: Record<string, unknown>, key = uniqueKey('paise')) =>
    server.call('POST', '/api/v1/transfers', { as: from, key, body: { receiverUpiId: toUpiId, pin: PIN, ...money } });

  test('amountPaise, a whole number, is accepted on transfers; the response carries both forms', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    await server.fundUser(alice.id, 500);

    const response = await transfer(alice.id, bob.upiId, { amountPaise: 12_345 });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.transaction.amountPaise, 12_345);
    assert.equal(response.body.data.transaction.amount, 123.45);
    assert.equal((await server.call('GET', '/api/v1/me', { as: bob.id })).body.data.wallet.balancePaise, 12_345);
  });

  test('when both are sent, amountPaise is the one that counts', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    await server.fundUser(alice.id, 500);
    const response = await transfer(alice.id, bob.upiId, { amount: 400, amountPaise: 250 });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.transaction.amountPaise, 250);
  });

  test('the same money in rupees or in paise is the same request to the idempotency check', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    await server.fundUser(alice.id, 500);
    const key = uniqueKey('same-money');
    const inRupees = await transfer(alice.id, bob.upiId, { amount: 123.45 }, key);
    const inPaise = await transfer(alice.id, bob.upiId, { amountPaise: 12_345 }, key);
    assert.equal(inRupees.status, 201);
    assert.equal(inPaise.status, 200);
    assert.equal(inPaise.headers.get('idempotent-replayed'), 'true');
    assert.equal(inPaise.body.data.transaction.id, inRupees.body.data.transaction.id);
  });

  const invalid: Array<[string, unknown]> = [
    ['zero', 0],
    ['negative', -100],
    ['fractional', 10.5],
    ['a string', '1000'],
    ['null', null],
    ['a boolean', true],
    ['above the Rs 10,00,000 ceiling', 100_000_001],
    ['beyond the safe integer range', 2 ** 60],
  ];
  for (const [label, amountPaise] of invalid) {
    test(`400 INVALID_AMOUNT for an amountPaise that is ${label}`, async () => {
      const alice = await server.newUser();
      const bob = await server.newUser();
      const response = await transfer(alice.id, bob.upiId, { amountPaise, amount: 10 });
      assert.equal(response.status, 400);
      assert.equal(response.body.error?.code, 'INVALID_AMOUNT');
      assert.deepEqual(response.body.error?.details, { field: 'amountPaise' });
    });
  }

  test('the ceiling itself (Rs 10,00,000 = 10,00,00,000 paise) passes request validation', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    const response = await transfer(alice.id, bob.upiId, { amountPaise: 100_000_000 });
    assert.equal(response.status, 422, 'refused by a business rule, not as malformed input');
    assert.equal(response.body.error?.code, 'SOURCE_LIMIT_EXCEEDED');
  });

  test('top-ups and scheduled payments take amountPaise too', async () => {
    const alice = await server.newUser();
    const bob = await server.newUser();
    const bankId = await server.fundUser(alice.id, 1);

    const topUp = await server.call('POST', '/api/v1/wallet/topup', {
      as: alice.id,
      key: uniqueKey(),
      body: { amountPaise: 99_999, sourceId: bankId, pin: PIN },
    });
    assert.equal(topUp.status, 201);
    assert.equal(topUp.body.data.transaction.amountPaise, 99_999);
    assert.equal((await server.call('GET', '/api/v1/me', { as: alice.id })).body.data.wallet.balancePaise, 100_099);

    const scheduled = await server.call('POST', '/api/v1/scheduled-payments', {
      as: alice.id,
      body: { receiverUpiId: bob.upiId, amountPaise: 4_550, delaySeconds: 3_600, pin: PIN },
    });
    assert.equal(scheduled.status, 201);
    assert.equal(scheduled.body.data.amount, 45.5);
  });
});
