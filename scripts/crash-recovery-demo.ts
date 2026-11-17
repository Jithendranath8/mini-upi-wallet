/**
 * Crash recovery, live.
 *
 * 1. A process starts a bank-funded payment (the bank takes 3 seconds to answer).
 * 2. The process is KILLED (SIGKILL, no clean-up) while that call is in flight.
 * 3. The database is inspected: the payment is stuck in PROCESSING and its idempotency key
 *    is stuck IN_PROGRESS. Nobody is going to finish them.
 * 4. A new process starts on the same database. Start-up reconciliation asks the gateway
 *    what happened to the charge, closes the payment, and releases the key.
 * 5. The client retries with the SAME Idempotency-Key and gets the recorded outcome.
 *
 *   npm run crash
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConfig } from '../src/config/AppConfig';
import { createApplication } from '../src/container';
import { Money } from '../src/domain/Money';
import { PrimaryDatabase } from '../src/infrastructure/db/Database';
import { tracer } from '../src/infrastructure/observability/Tracer';

const KEY = 'payment-interrupted-by-a-crash';
const settings = (dataDir: string, gatewayLatencyMs: number) =>
  AppConfig.with({ dataDir, seedDemoData: false, gatewayLatencyMs, notificationLatencyMs: 0, databaseLatencyMs: 0, replicaLagMs: 0 });

/** Process A: set up two users, start a slow bank payment, then get killed. */
async function victim(dataDir: string): Promise<void> {
  const app = await createApplication(settings(dataDir, 0));
  const payer = app.users.register({ name: 'Crash Payer', phone: '9000000011', pin: '1234', upiHandle: 'crash.payer' });
  const payee = app.users.register({ name: 'Crash Payee', phone: '9000000012', pin: '1234', upiHandle: 'crash.payee' });
  const bank = app.users.linkBankAccount(payer.id, { bankName: 'Slow Bank', accountNumber: '123456789012', ifsc: 'SLOW0000001' });
  await app.settle();

  app.chaos.update({ bank: { latencyMs: 3_000 } });
  process.stdout.write(`${JSON.stringify({ payerId: payer.id, payeeUpi: payee.upiId, bankId: bank.id })}\n`);
  // This never returns: the parent kills us while the bank call is in flight.
  await app.transfers.transfer({
    idempotencyKey: KEY,
    senderId: payer.id,
    receiverUpiId: payee.upiId,
    amount: Money.fromRupees(750),
    sourceId: bank.id,
  });
}

/** Process B: start on the same database (reconciliation runs), then retry the payment. */
async function survivor(dataDir: string, payerId: string, payeeUpi: string, bankId: string): Promise<void> {
  const app = await createApplication(settings(dataDir, 0));
  const recovery = tracer.recentFeed(50).find((item) => item.component === 'Recovery');
  console.log(`  start-up reconciliation: ${recovery ? recovery.message.replace('Start-up reconciliation: ', '') : 'nothing to do'}`);

  const retry = await app.transfers.transfer({
    idempotencyKey: KEY,
    senderId: payerId,
    receiverUpiId: payeeUpi,
    amount: Money.fromRupees(750),
    sourceId: bankId,
  });
  const txn = retry.result.transaction;
  console.log(`  retry with the same key : ${txn.status} (${retry.result.error?.code}) "${retry.result.error?.message}"`);
  const details = app.queries.details(txn.id, payerId, true).data;
  console.log(`  lifecycle on record     : ${details.timeline.map((event) => event.to).join(' -> ')}`);
  console.log(`  ledger entries          : ${details.ledger.length} (no money moved)`);
  const audit = app.ledger.verify(app.readRouter.route(undefined, { strong: true }));
  console.log(`  ledger audit            : ${audit.healthy ? 'healthy' : 'BROKEN'}`);
  await app.settle();
  app.shutdown();
  if (txn.status !== 'FAILED' || txn.failureCode !== 'INTERRUPTED' || !audit.healthy) process.exitCode = 1;
}

function inspect(dataDir: string, label: string): void {
  const db = new PrimaryDatabase(join(dataDir, 'primary.db'));
  const txn = db.get<{ status: string; funds_captured: number }>('SELECT status, funds_captured FROM transactions WHERE idempotency_key = ?', KEY);
  const key = db.get<{ status: string }>('SELECT status FROM idempotency_keys WHERE idem_key = ?', KEY);
  console.log(`  ${label}: transaction ${txn?.status ?? 'missing'}, idempotency key ${key?.status ?? 'released'}`);
  db.close();
}

const node = (mode: string, ...args: string[]) =>
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fileURLToPath(import.meta.url), mode, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'miniupi-crash-'));
  try {
    console.log('\n1. A process starts a bank-funded payment of Rs 750. The bank takes 3 s to answer.');
    const first = node('victim', dataDir);
    const ids = await new Promise<{ payerId: string; payeeUpi: string; bankId: string }>((resolve, reject) => {
      first.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk))));
      first.on('exit', (code) => code !== null && code !== 0 && reject(new Error(`set-up failed with code ${code}`)));
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    console.log('2. The process is killed while the bank call is in flight (SIGKILL: no clean-up runs).');
    first.kill('SIGKILL');
    await new Promise((resolve) => first.once('exit', resolve));

    console.log('3. What the crash left behind:');
    inspect(dataDir, 'after the crash  ');

    console.log('4. A new process starts on the same database.');
    const second = node('survivor', dataDir, ids.payerId, ids.payeeUpi, ids.bankId);
    second.stdout.on('data', (chunk) => process.stdout.write(chunk));
    const code = await new Promise<number | null>((resolve) => second.once('exit', resolve));
    inspect(dataDir, 'after the restart');
    console.log(code === 0 ? '\nPASS  The interrupted payment was closed, nothing was paid, and the retry got a definite answer.\n' : '\nFAIL\n');
    if (code !== 0) process.exitCode = 1;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const [, , mode, ...rest] = process.argv;
if (mode === 'victim') await victim(rest[0]);
else if (mode === 'survivor') await survivor(rest[0], rest[1], rest[2], rest[3]);
else await main();
