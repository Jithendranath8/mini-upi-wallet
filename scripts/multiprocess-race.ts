/**
 * Double-spend proof under REAL parallelism.
 *
 * The app server is single-threaded, so inside one process two payments can only interleave
 * at an `await`. This script removes that comfort: several operating-system processes open
 * the same database file and hammer one wallet at the same time, WITHOUT the in-process payer
 * lock (a lock in one process means nothing to another process).
 *
 * What must still hold is everything behind the lock:
 *   - BEGIN IMMEDIATE: one writer at a time, enforced by the database across processes
 *   - Wallet.debit(): refuses to go below zero, re-read inside the transaction
 *   - version column: a stale write is rejected
 *   - CHECK (balance_paise >= 0)
 *   - idempotency primary key: only one process can claim a key
 *
 *   npm run race            (4 processes x 10 attempts of Rs 100 against Rs 1,000)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConfig } from '../src/config/AppConfig';
import { createApplication } from '../src/container';
import { DomainError } from '../src/domain/errors';
import { Money } from '../src/domain/Money';
import { Transaction } from '../src/domain/Transaction';
import { PrimaryDatabase } from '../src/infrastructure/db/Database';
import { WalletPaymentStrategy } from '../src/payment/strategies';
import {
  SqlitePaymentSourceRepository,
  SqliteUserRepository,
  SqliteWalletRepository,
} from '../src/repository/sqlite/AccountRepositories';
import { SqliteIdempotencyRepository, SqliteLedgerRepository } from '../src/repository/sqlite/SupportRepositories';
import {
  SqliteTransactionEventRepository,
  SqliteTransactionRepository,
} from '../src/repository/sqlite/TransactionRepositories';
import { LedgerService } from '../src/service/LedgerService';
import { newId } from '../src/util/ids';

const PROCESSES = 4;
const ATTEMPTS_EACH = 10;
const OPENING_RUPEES = 1_000;
const PAYMENT_RUPEES = 100;
const SHARED_KEY = 'one-key-claimed-by-every-process';

interface WorkerResult {
  pid: number;
  succeeded: number;
  refused: Record<string, number>;
  claimedSharedKey: boolean;
}

function openStack(dataDir: string) {
  const db = new PrimaryDatabase(join(dataDir, 'primary.db'));
  const wallets = new SqliteWalletRepository(db);
  const transactions = new SqliteTransactionRepository(db, new SqliteTransactionEventRepository(db));
  const ledgerRepository = new SqliteLedgerRepository(db);
  const ledger = new LedgerService(ledgerRepository, wallets);
  return {
    db,
    wallets,
    transactions,
    ledger,
    users: new SqliteUserRepository(db),
    sources: new SqlitePaymentSourceRepository(db),
    idempotency: new SqliteIdempotencyRepository(db),
    strategy: new WalletPaymentStrategy({ unitOfWork: db, wallets, transactions, ledger }),
  };
}

/** One competing process: pays as fast as it can, with no application-level lock at all. */
async function worker(dataDir: string, payerId: string, payeeId: string, startAt: number): Promise<void> {
  const stack = openStack(dataDir);
  const sender = stack.users.findById(payerId)!;
  const receiver = stack.users.findById(payeeId)!;
  const source = stack.sources.findWalletSource(payerId)!;
  const result: WorkerResult = { pid: process.pid, succeeded: 0, refused: {}, claimedSharedKey: false };

  while (Date.now() < startAt) await new Promise((resolve) => setImmediate(resolve)); // all start together

  result.claimedSharedKey = stack.idempotency.tryBegin(payerId, SHARED_KEY, 'same-request', new Date());

  for (let attempt = 0; attempt < ATTEMPTS_EACH; attempt += 1) {
    // A short random pause between attempts, so the processes genuinely interleave.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 6));
    const txn = Transaction.builder()
      .withId(newId('txn'))
      .withIdempotencyKey(newId('race'))
      .from(sender.id)
      .to(receiver.id)
      .fundedBy(source.id, source.type)
      .forAmount(Money.fromRupees(PAYMENT_RUPEES))
      .build();
    stack.transactions.insert(txn);
    txn.startProcessing();
    stack.transactions.update(txn);
    try {
      await stack.strategy.pay({ transaction: txn, sender, receiver, source });
      result.succeeded += 1;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'UNEXPECTED';
      result.refused[code] = (result.refused[code] ?? 0) + 1;
      txn.fail(code, error instanceof Error ? error.message : String(error));
      stack.transactions.update(txn);
    }
  }
  stack.db.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function runWorker(args: string[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fileURLToPath(import.meta.url), 'worker', ...args],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker exited with code ${code}`));
      resolve(JSON.parse(output.trim().split('\n').pop()!) as WorkerResult);
    });
  });
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'miniupi-race-'));
  try {
    // 1. Set the stage with the real application: two users, Rs 1,000 in the payer's wallet.
    const app = await createApplication(
      AppConfig.with({ dataDir, seedDemoData: false, gatewayLatencyMs: 0, databaseLatencyMs: 0, notificationLatencyMs: 0, replicaLagMs: 0 }),
    );
    const payer = app.users.register({ name: 'Race Payer', phone: '9000000001', pin: '1234', upiHandle: 'race.payer' });
    const payee = app.users.register({ name: 'Race Payee', phone: '9000000002', pin: '1234', upiHandle: 'race.payee' });
    const bank = app.users.linkBankAccount(payer.id, { bankName: 'Race Bank', accountNumber: '123456789012', ifsc: 'RACE0000001' });
    await app.transfers.transfer({
      idempotencyKey: 'race-opening-balance',
      senderId: payer.id,
      receiverUpiId: payer.upiId,
      amount: Money.fromRupees(OPENING_RUPEES),
      sourceId: bank.id,
    });
    await app.settle();
    app.shutdown();

    // 2. Let several processes fight over that wallet.
    const startAt = Date.now() + 4_000; // long enough for every process to boot before the gun
    const results = await Promise.all(
      Array.from({ length: PROCESSES }, () => runWorker([dataDir, payer.id, payee.id, String(startAt)])),
    );

    // 3. Inspect what they left behind.
    const stack = openStack(dataDir);
    const payerBalance = stack.wallets.findByUserId(payer.id)!.balance.toRupees();
    const payeeBalance = stack.wallets.findByUserId(payee.id)!.balance.toRupees();
    const audit = stack.ledger.verify(stack.db);
    stack.db.close();

    const succeeded = results.reduce((sum, r) => sum + r.succeeded, 0);
    const refused = results.reduce((sum, r) => sum + Object.values(r.refused).reduce((a, b) => a + b, 0), 0);
    const keyWinners = results.filter((r) => r.claimedSharedKey).length;
    const expected = OPENING_RUPEES / PAYMENT_RUPEES;

    console.log(`\n${PROCESSES} processes x ${ATTEMPTS_EACH} attempts of Rs ${PAYMENT_RUPEES} against a wallet holding Rs ${OPENING_RUPEES}\n`);
    for (const r of results) {
      console.log(`  process ${String(r.pid).padEnd(6)} succeeded ${String(r.succeeded).padStart(2)}   refused ${JSON.stringify(r.refused)}`);
    }
    const checks: Array<[string, boolean, string]> = [
      [`exactly ${expected} payments succeeded`, succeeded === expected, `${succeeded} succeeded, ${refused} refused`],
      ['payer balance is exactly zero, never negative', payerBalance === 0, `Rs ${payerBalance}`],
      [`payee received exactly Rs ${OPENING_RUPEES}`, payeeBalance === OPENING_RUPEES, `Rs ${payeeBalance}`],
      ['every refusal was INSUFFICIENT_BALANCE', results.every((r) => Object.keys(r.refused).every((code) => code === 'INSUFFICIENT_BALANCE')), ''],
      ['ledger hash chain intact across processes', audit.chainIntact, `${audit.entries} entries`],
      ['debits equal credits for every transaction', audit.unbalancedTransactions.length === 0, ''],
      ['wallet balances equal their ledger sums', audit.walletMismatches.length === 0, ''],
      ['exactly one process claimed the shared idempotency key', keyWinners === 1, `${keyWinners} of ${PROCESSES}`],
    ];
    console.log('');
    for (const [label, pass, detail] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
    console.log('');
    if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'worker') {
  const [, , , dataDir, payerId, payeeId, startAt] = process.argv;
  await worker(dataDir, payerId, payeeId, Number(startAt));
} else {
  await main();
}
