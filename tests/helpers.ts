import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppConfig, type AppSettings } from '../src/config/AppConfig';
import { type Application, createApplication } from '../src/container';
import { Money } from '../src/domain/Money';
import type { PaymentSource } from '../src/domain/PaymentSource';
import type { User } from '../src/domain/User';
import type { SqlReader, SqlWriter } from '../src/infrastructure/db/Database';
import type { IdempotentOutcome } from '../src/service/IdempotencyService';
import type { TransferResult } from '../src/service/TransferService';
import type { RegisterUserInput } from '../src/service/UserService';

/**
 * Shared test fixtures. Not a test file itself (the runner only picks up *.test.ts).
 *
 * Every test file builds its own in-memory application; every test registers its own users,
 * so tests never depend on data another test left behind.
 */

/** Fast, deterministic settings: no simulated latency, no demo data, in-memory SQLite. */
export const FAST_SETTINGS: Partial<AppSettings> = {
  dataDir: ':memory:',
  seedDemoData: false,
  gatewayLatencyMs: 0,
  notificationLatencyMs: 0,
  databaseLatencyMs: 0,
  replicaLagMs: 0,
  queueBackoffBaseMs: 5,
  idempotencyPollIntervalMs: 5,
  // The velocity fraud rule (6 payments a minute by default) would trip in any test that makes
  // several payments from one user. It is switched off here and tested on its own.
  fraudMaxTransfersPerMinute: 100_000,
};

export function createTestApp(overrides: Partial<AppSettings> = {}): Promise<Application> {
  return createApplication(AppConfig.with({ ...FAST_SETTINGS, ...overrides }));
}

/**
 * Shuts an application down cleanly. Notification jobs that are still in flight would otherwise
 * run against a closed database, so the queue is drained first.
 */
export async function closeApp(app: Application): Promise<void> {
  await keepAlive(app.settle());
  app.shutdown();
}

/**
 * For the rare test that leaves a retry scheduled far in the future (the compensation queue
 * backs off for a full second): waits only for work that is queued or running right now.
 */
export async function closeAppIgnoringScheduledRetries(app: Application): Promise<void> {
  await eventually(() =>
    Object.values(app.system.snapshot().queue).every((topic) => topic.depth === 0 && topic.inFlight === 0),
  );
  app.shutdown();
}

export const PIN = '1234';

let userSequence = 0;

/** Registers a user with a unique handle and phone number. */
export function registerUser(app: Application, overrides: Partial<RegisterUserInput> = {}): User {
  userSequence += 1;
  return app.users.register({
    name: `Test User ${userSequence}`,
    upiHandle: `user${userSequence}`,
    phone: `9${String(userSequence).padStart(9, '0')}`,
    pin: PIN,
    ...overrides,
  });
}

export function uniqueKey(label = 'key'): string {
  return `${label}-${randomUUID()}`;
}

export function linkBank(app: Application, user: User): PaymentSource {
  return app.users.linkBankAccount(user.id, {
    bankName: 'Test Bank',
    accountNumber: '123456789012',
    ifsc: 'TEST0001234',
  });
}

export function linkCard(app: Application, user: User): PaymentSource {
  return app.users.linkCard(user.id, {
    network: 'Visa',
    cardNumber: '4111111111111111',
    expiryMonth: 12,
    expiryYear: new Date().getFullYear() + 3,
  });
}

export interface PayOptions {
  key?: string;
  sourceId?: string;
  note?: string;
}

/** One transfer through the real service. `receiver` may be a user or a raw UPI ID. */
export function pay(
  app: Application,
  sender: User,
  receiver: User | string,
  rupees: number,
  options: PayOptions = {},
): Promise<IdempotentOutcome<TransferResult>> {
  return app.transfers.transfer({
    idempotencyKey: options.key ?? uniqueKey('pay'),
    senderId: sender.id,
    receiverUpiId: typeof receiver === 'string' ? receiver : receiver.upiId,
    amount: Money.fromRupees(rupees),
    sourceId: options.sourceId,
    note: options.note,
  });
}

/** Loads a user's wallet from a (new or given) linked bank account. Asserts that it worked. */
export async function fund(app: Application, user: User, rupees: number, bank?: PaymentSource): Promise<PaymentSource> {
  const source = bank ?? linkBank(app, user);
  const { result } = await pay(app, user, user, rupees, { sourceId: source.id, note: 'Test funding' });
  assert.equal(result.error, undefined, `funding failed: ${result.error?.code} ${result.error?.message}`);
  assert.equal(result.transaction.status, 'SUCCESS');
  return source;
}

/** Wallet balance in paise, through the public (cached) read path. */
export function balanceOf(app: Application, user: User): number {
  return app.users.walletOf(user.id).balance.paise;
}

/** Wallet balance in paise, read straight from the primary database (no cache). */
export function storedBalanceOf(app: Application, user: User): number {
  const row = primaryOf(app).get<{ balance_paise: number }>('SELECT balance_paise FROM wallets WHERE user_id = ?', user.id);
  assert.ok(row, `no wallet row for ${user.id}`);
  return row.balance_paise;
}

export function primaryOf(app: Application): SqlReader {
  const reader = app.readRouter.route(undefined, { strong: true });
  assert.equal(reader.role, 'primary');
  return reader;
}

/**
 * Test-only back door: the primary with write access, for arranging states the public API
 * cannot produce (a blocked user, a frozen wallet, a lost idempotency record).
 */
export function writerOf(app: Application): SqlWriter {
  return primaryOf(app) as SqlWriter;
}

/** With no user to pin, an ordinary read is routed to the replica. */
export function replicaOf(app: Application): SqlReader {
  const reader = app.readRouter.route();
  assert.equal(reader.role, 'replica');
  return reader;
}

/** The statuses a transaction went through, in order, read from the primary. */
export function timelineOf(app: Application, transactionId: string, requester: User): string[] {
  return app.queries.details(transactionId, requester.id, true).data.timeline.map((step) => step.to);
}

export function ledgerOf(app: Application, transactionId: string) {
  return app.ledger.forTransaction(primaryOf(app), transactionId);
}

export function verifyLedger(app: Application) {
  return app.ledger.verify(primaryOf(app));
}

/** Notifications of one user for one transaction, read from the primary. Call `app.settle()` first. */
export function notificationsFor(app: Application, user: User, transactionId: string) {
  return app.notifications.listFor(primaryOf(app), user.id, 500).filter((n) => n.transactionId === transactionId);
}

/**
 * The queue and the replication stream use unref'd timers, so on their own they do not keep
 * the test process alive. Awaiting something that only they will resolve needs a live handle.
 */
export async function keepAlive<T>(work: Promise<T>): Promise<T> {
  const timer = setInterval(() => {}, 1_000);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Freezes Date.now() at the current moment for the rest of the test and returns a function
 * that moves it forward. Real timers keep running, so awaited work still completes. Used for
 * cool-downs and lock-outs, which would otherwise need real waiting and break under load.
 */
export function freezeClock(t: TestContext): (ms: number) => void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  return (ms) => t.mock.timers.tick(ms);
}

/** Polls until `condition` holds; fails the test if it does not within `timeoutMs`. */
export async function eventually(condition: () => boolean, timeoutMs = 1_000, intervalMs = 2): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`condition was not met within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

export { sleep };
