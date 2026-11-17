/**
 * Load test: measured throughput and latency, plus the invariants that must survive the load.
 *
 * The server runs in its own process (a real HTTP server on a real port, file-backed database);
 * this process is the load generator. Limits that exist to stop abuse (rate limits, the
 * payment-velocity fraud rule) are raised so the test measures capacity, not the limiter.
 *
 *   npm run loadtest                 default: 4 seconds per scenario
 *   npm run loadtest -- 10           10 seconds per scenario
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppConfig } from '../src/config/AppConfig';
import { createApplication } from '../src/container';
import { Money } from '../src/domain/Money';

const USERS = 200;
const OPENING_RUPEES = 50_000;
const PIN = '1234';

interface Actor {
  id: string;
  upiId: string;
}

// ---------------------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------------------

async function server(dataDir: string): Promise<void> {
  const app = await createApplication(
    AppConfig.with({
      dataDir,
      seedDemoData: false,
      // Raised so the test measures the system, not its abuse limits.
      rateLimitCapacity: 1_000_000,
      rateLimitRefillPerSecond: 1_000_000,
      ipRateLimitCapacity: 1_000_000,
      ipRateLimitRefillPerSecond: 1_000_000,
      fraudMaxTransfersPerMinute: 1_000_000,
      pinMaxAttempts: 1_000_000,
      // No artificial delays except where a scenario sets one.
      gatewayLatencyMs: 0,
      notificationLatencyMs: 0,
      databaseLatencyMs: 0,
      replicaLagMs: 100,
    }),
  );

  const actors: Actor[] = [];
  for (let i = 0; i < USERS; i += 1) {
    const user = app.users.register({
      name: `Load User ${i}`,
      upiHandle: `load.user.${i}`,
      phone: `9${String(100_000_000 + i)}`,
      pin: PIN,
      dailyLimitRupees: 100_000,
    });
    const bank = app.users.linkBankAccount(user.id, { bankName: 'Load Bank', accountNumber: String(100_000_000_000 + i), ifsc: 'LOAD0000001' });
    await app.transfers.transfer({
      idempotencyKey: `load-opening-${i}`,
      senderId: user.id,
      receiverUpiId: user.upiId,
      amount: Money.fromRupees(OPENING_RUPEES),
      sourceId: bank.id,
    });
    actors.push({ id: user.id, upiId: user.upiId });
  }
  await app.settle();

  const http = app.http.listen(0, '127.0.0.1', () => {
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    process.stdout.write(`${JSON.stringify({ port, actors })}\n`);
  });
  process.on('SIGTERM', () => {
    http.close(() => {
      app.shutdown();
      process.exit(0);
    });
  });
}

// ---------------------------------------------------------------------------------------
// Load generator
// ---------------------------------------------------------------------------------------

interface Outcome {
  name: string;
  concurrency: number;
  requests: number;
  perSecond: number;
  p50: number;
  p95: number;
  p99: number;
  statuses: Record<string, number>;
  /** First error body seen per non-2xx status, so an unexpected failure explains itself. */
  samples: Record<string, string>;
}

async function scenario(
  name: string,
  concurrency: number,
  seconds: number,
  request: (worker: number, iteration: number) => Promise<Response>,
): Promise<Outcome> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const samples: Record<string, string> = {};
  const deadline = performance.now() + seconds * 1000;
  const started = performance.now();

  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      for (let iteration = 0; performance.now() < deadline; iteration += 1) {
        const before = performance.now();
        const response = await request(worker, iteration);
        const body = await response.text(); // a request is not done until its body is consumed
        latencies.push(performance.now() - before);
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status >= 400) samples[response.status] ??= body.slice(0, 160);
      }
    }),
  );

  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
  return {
    name,
    concurrency,
    requests: latencies.length,
    perSecond: Math.round(latencies.length / elapsed),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    statuses,
    samples,
  };
}

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 4);
  const dataDir = mkdtempSync(join(tmpdir(), 'miniupi-load-'));
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fileURLToPath(import.meta.url), 'server', dataDir],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  try {
    process.stderr.write(`Starting the server and loading ${USERS} wallets...\n`);
    const { port, actors } = await new Promise<{ port: number; actors: Actor[] }>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
      child.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
    });

    const base = `http://127.0.0.1:${port}/api/v1`;
    const get = (path: string, user: Actor) => fetch(base + path, { headers: { 'X-User-Id': user.id } });
    const system = async (method: string, path: string, body?: unknown) =>
      (await (await fetch(`${base}/system${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      })).json()) as { data: any };
    let keySequence = 0;
    const pay = (from: Actor, to: Actor, key = `load-payment-${(keySequence += 1)}`) =>
      fetch(`${base}/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': from.id, 'Idempotency-Key': key },
        body: JSON.stringify({ receiverUpiId: to.upiId, amountPaise: 100, pin: PIN }),
      });
    const pick = (worker: number, iteration: number) => actors[(worker * 7919 + iteration * 31) % actors.length];
    const other = (actor: Actor, iteration: number) => actors[(actors.indexOf(actor) + 1 + (iteration % (actors.length - 1))) % actors.length];

    const outcomes: Outcome[] = [];
    const run = async (...args: Parameters<typeof scenario>) => {
      process.stderr.write(`  ${args[0]}...\n`);
      outcomes.push(await scenario(...args));
    };

    // Open the connections up front, so no scenario pays for TCP set-up in its latencies.
    await Promise.all(actors.slice(0, 120).map(async (actor) => (await get('/me', actor)).arrayBuffer()));

    await run('Read balance (cache)', 50, seconds, (w, i) => get('/me', pick(w, i)));
    await run('Read history (replica)', 50, seconds, (w, i) => get('/transactions?limit=20', pick(w, i)));
    await run('Pay, many payers', 50, seconds, (w, i) => {
      const from = pick(w, i);
      return pay(from, other(from, i));
    });

    await system('PUT', '/chaos', { databaseLatencyMs: 5 });
    await run('Pay, many payers, 5 ms database round trip', 50, seconds, (w, i) => {
      const from = pick(w, i);
      return pay(from, other(from, i));
    });
    await run('Pay, ONE payer, 5 ms database round trip', 50, seconds, (_w, i) => pay(actors[0], actors[1 + (i % 50)]));
    await system('PUT', '/chaos', { databaseLatencyMs: 0 });

    // Every logical payment is sent three times at once with the same key.
    let storms = 0;
    await run('Retry storm: each payment sent 3 times', 16, seconds, async (w, i) => {
      const from = pick(w, i);
      const to = other(from, i);
      const key = `storm-${w}-${i}`;
      storms += 1;
      const [first, second, third] = await Promise.all([pay(from, to, key), pay(from, to, key), pay(from, to, key)]);
      await Promise.all([second.arrayBuffer(), third.arrayBuffer()]);
      return first;
    });

    // ---- What must be true after all of that -------------------------------------------
    await new Promise((resolve) => setTimeout(resolve, 600)); // let the queue and the replica settle
    const metrics = (await system('GET', '/metrics')).data;
    const audit = (await system('GET', '/ledger/verify')).data;
    const balances = await Promise.all(
      actors.map(async (actor) => ((await (await get('/me', actor)).json()) as { data: { wallet: { balancePaise: number } } }).data.wallet.balancePaise),
    );
    const total = balances.reduce((sum, paise) => sum + paise, 0);
    const succeeded = metrics.transactions.SUCCESS - USERS; // minus the opening top-ups
    // Plain scenarios: one 201 per payment. Storm scenario: one payment per storm, whichever
    // of its three requests happened to be the one that executed.
    const paymentRequests =
      outcomes.filter((o) => o.name.startsWith('Pay')).reduce((sum, o) => sum + (o.statuses['201'] ?? 0), 0) + storms;

    const format = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0));
    console.log(`\nMachine: ${cpus()[0].model}, ${cpus().length} cores. Node ${process.version}. ${seconds} s per scenario, ${USERS} wallets.\n`);
    console.log('| Scenario | Concurrent clients | Requests | Per second | p50 ms | p95 ms | p99 ms | Responses |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const o of outcomes) {
      const responses = Object.entries(o.statuses).map(([status, n]) => `${status}: ${n}`).join(', ');
      console.log(`| ${o.name} | ${o.concurrency} | ${o.requests} | ${o.perSecond} | ${format(o.p50)} | ${format(o.p95)} | ${format(o.p99)} | ${responses} |`);
    }

    const checks: Array<[string, boolean, string]> = [
      ['No money created or lost', total === USERS * OPENING_RUPEES * 100, `total Rs ${total / 100} across ${USERS} wallets`],
      ['No wallet went negative', balances.every((paise) => paise >= 0), `lowest Rs ${Math.min(...balances) / 100}`],
      ['Every accepted payment was executed exactly once', succeeded === paymentRequests, `${succeeded} SUCCESS rows for ${paymentRequests} accepted payments`],
      ['Retry storms never paid twice', metrics.idempotency.replayed >= storms * 2 * 0.99, `${storms} payments sent 3 times, ${metrics.idempotency.replayed} replays`],
      ['Ledger hash chain intact', audit.chainIntact, `${audit.entries} entries`],
      ['Debits equal credits; balances equal ledger sums', audit.unbalancedTransactions.length === 0 && audit.walletMismatches.length === 0, ''],
      ['No server errors', outcomes.every((o) => !Object.keys(o.statuses).some((status) => status.startsWith('5'))), ''],
    ];
    for (const o of outcomes) {
      for (const [status, body] of Object.entries(o.samples)) console.log(`\n${o.name}: first ${status} response: ${body}`);
    }
    console.log('');
    for (const [label, pass, detail] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
    console.log(`\nLock waits ${metrics.locks.contended}, lock timeouts ${metrics.locks.timeouts}, cache hit ratio ${Math.round(metrics.cache.hitRatio * 100)}%, reads served by the replica ${metrics.database.readRouting.toReplica}, by the primary ${metrics.database.readRouting.toPrimary}.`);
    if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 400));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'server') {
  await server(process.argv[3]);
} else {
  await main();
}
