// Scenario lab: each scenario drives the real API from the browser and checks the outcome.
import { api, newKey, system } from './api.js';
import { $, fill, h, rupees, sleep } from './dom.js';
import { clearRail, watchTrace } from './trace.js';

const PIN = '1234';

// ---------- Building blocks shared by the scenarios ----------

class Run {
  constructor(log) {
    this.log = log;
    this.failed = 0;
    this.passed = 0;
    this.keyResult = null;
    this.keyTitle = '';
  }

  step(text) {
    this.log.append(h('li', { class: 'step' }, text));
    this.log.lastChild.scrollIntoView({ block: 'nearest' });
  }

  check(label, pass, detail) {
    if (pass) this.passed += 1;
    else this.failed += 1;
    this.log.append(
      h('li', { class: `check ${pass ? 'pass' : 'fail'}` }, label, detail && h('span', { class: 'detail' }, detail)),
    );
    this.log.lastChild.scrollIntoView({ block: 'nearest' });
    return pass;
  }

  /** Picks the request whose internal trace is shown under the log. */
  spotlight(result, title) {
    this.keyResult = result;
    this.keyTitle = title;
  }
}

async function must(result, what) {
  if (!result.ok) throw new Error(`${what} failed: ${result.error?.code ?? result.status} ${result.error?.message ?? ''}`);
  return result;
}

async function newUser(role, extra = {}) {
  const tag = Math.random().toString(36).slice(2, 7);
  const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  const result = await must(
    await api('POST', '/users', {
      user: null,
      body: { name: `Lab ${role} ${tag}`, upiHandle: `lab.${role}.${tag}`, phone, pin: PIN, ...extra },
    }),
    `Creating the ${role}`,
  );
  return { id: result.data.user.id, upiId: result.data.user.upiId, name: result.data.user.name, bankId: null };
}

async function linkBank(user) {
  if (user.bankId) return user.bankId;
  const digits = String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
  const result = await must(
    await api('POST', '/payment-sources/bank-accounts', {
      user: user.id,
      body: { bankName: 'Lab Bank', accountNumber: digits, ifsc: 'LABB0000001' },
    }),
    'Linking a bank account',
  );
  user.bankId = result.data.id;
  return user.bankId;
}

const topUp = async (user, amount) =>
  api('POST', '/wallet/topup', {
    user: user.id,
    key: newKey(),
    body: { sourceId: await linkBank(user), amount, pin: PIN },
  });

async function funded(role, amount, extra) {
  const user = await newUser(role, extra);
  await must(await topUp(user, amount), `Loading ${rupees(amount)} into the ${role}'s wallet`);
  return user;
}

const pay = (from, to, amount, { key = newKey(), sourceId, pin = PIN } = {}) =>
  api('POST', '/transfers', {
    user: from.id,
    key,
    body: { receiverUpiId: typeof to === 'string' ? to : to.upiId, amount, pin, sourceId },
  });

const balanceOf = async (user) => (await must(await api('GET', '/me', { user: user.id }), 'Reading the balance')).data.wallet.balance;
const historyOf = (user, query = '') => api('GET', `/transactions?limit=20${query}`, { user: user.id });
const metrics = async () => (await must(await system('GET', '/metrics'), 'Reading metrics')).data;
const traceText = async (result) => {
  const { data } = await system('GET', `/traces/${result.meta.requestId}`);
  return (data?.steps ?? []).map((s) => `${s.component}: ${s.message}`).join('\n');
};
const count = (items, predicate) => items.filter(predicate).length;
const statusOf = (result) => result.data?.transaction?.status;

// ---------- The scenarios ----------

const GROUPS = [
  {
    title: 'Safe to retry',
    scenarios: [
      {
        id: 'retry-storm',
        title: 'Retry storm: one payment sent six times at once',
        expect: 'A flaky network makes the app resend the same request. One debit, six identical answers.',
        async run(run) {
          const payer = await funded('payer', 1000);
          const payee = await newUser('payee');
          run.step(`Payer has ${rupees(1000)}. Sending ${rupees(200)} six times in parallel with ONE Idempotency-Key.`);
          const key = newKey();
          const results = await Promise.all(Array.from({ length: 6 }, () => pay(payer, payee, 200, { key })));

          const ids = new Set(results.map((r) => r.data?.transaction?.id));
          const fresh = count(results, (r) => !r.meta.replayed);
          run.check('All six responses describe the same transaction', ids.size === 1 && !ids.has(undefined), [...ids].join(', '));
          run.check('Exactly one request executed; five were replays', fresh === 1, `${fresh} executed, ${6 - fresh} replayed`);
          run.check('Payer was debited once', (await balanceOf(payer)) === 800, `balance ${rupees(await balanceOf(payer))}`);
          run.check('Payee was credited once', (await balanceOf(payee)) === 200, `balance ${rupees(await balanceOf(payee))}`);
          run.spotlight(results.find((r) => r.meta.replayed) ?? results[0], 'One of the duplicates');
        },
      },
      {
        id: 'key-reuse',
        title: 'Same key, different amount',
        expect: 'A key identifies exactly one request. Reusing it for another payment is refused.',
        async run(run) {
          const payer = await funded('payer', 1000);
          const payee = await newUser('payee');
          const key = newKey();
          const first = await pay(payer, payee, 100, { key });
          run.check(`First payment of ${rupees(100)} succeeds`, first.status === 201, `HTTP ${first.status}`);
          const second = await pay(payer, payee, 900, { key });
          run.check(
            `${rupees(900)} with the same key is rejected`,
            second.status === 422 && second.error?.code === 'IDEMPOTENCY_KEY_REUSED',
            `HTTP ${second.status} ${second.error?.code}`,
          );
          run.check('Only the first payment moved money', (await balanceOf(payer)) === 900, `balance ${rupees(await balanceOf(payer))}`);
          run.spotlight(second, 'The rejected request');
        },
      },
    ],
  },
  {
    title: 'Who is calling',
    scenarios: [
      {
        id: 'sessions',
        title: 'Signing in with a session token',
        expect: 'UPI ID and PIN are exchanged for a signed token. Any app node can verify it without a session store.',
        async run(run) {
          const user = await funded('payer', 100);
          const raw = (path, headers = {}, body) =>
            fetch(`/api/v1${path}`, {
              method: body ? 'POST' : 'GET',
              headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
              body: body ? JSON.stringify(body) : undefined,
            }).then(async (response) => ({ status: response.status, json: await response.json() }));

          const login = await raw('/auth/login', {}, { upiId: user.upiId, pin: PIN });
          const token = login.json.data?.token;
          run.check('Signing in returns a token with an expiry', login.status === 200 && Boolean(token), `expires ${login.json.data?.expiresAt}`);
          const me = await raw('/me', { Authorization: `Bearer ${token}` });
          run.check('The token alone identifies the user', me.status === 200 && me.json.data?.user.id === user.id, me.json.data?.user.upiId);
          const forged = await raw('/me', { Authorization: `Bearer ${token.slice(0, -2)}xx` });
          run.check('A token with a changed signature is refused', forged.status === 401 && forged.json.error?.code === 'INVALID_TOKEN', `HTTP ${forged.status} ${forged.json.error?.code}`);
          const someoneElse = await raw('/me', { Authorization: `Bearer ${token.replace(user.id, 'usr_0000000000000000')}` });
          run.check('Swapping the user id inside a token breaks its signature', someoneElse.status === 401, `HTTP ${someoneElse.status} ${someoneElse.json.error?.code}`);
          const wrongPin = await raw('/auth/login', {}, { upiId: user.upiId, pin: '0000' });
          const nobody = await raw('/auth/login', {}, { upiId: 'nobody.here@miniupi', pin: PIN });
          run.check(
            'A wrong PIN and an unknown UPI ID get the same answer',
            wrongPin.status === 401 && nobody.status === 401 && wrongPin.json.error?.code === nobody.json.error?.code,
            `${wrongPin.json.error?.code} and ${nobody.json.error?.code}`,
          );
        },
      },
    ],
  },
  {
    title: 'Money cannot be spent twice',
    scenarios: [
      {
        id: 'double-spend',
        title: 'Double-spend race: five payments, money for two',
        expect: 'Five different payments hit the same wallet together. The balance never goes below zero.',
        async run(run) {
          const payer = await funded('payer', 1000);
          const payee = await newUser('payee');
          const before = await metrics();
          run.step(`Payer has ${rupees(1000)}. Firing five different ${rupees(400)} payments at the same instant.`);
          const results = await Promise.all(Array.from({ length: 5 }, () => pay(payer, payee, 400)));

          const succeeded = count(results, (r) => statusOf(r) === 'SUCCESS');
          const refused = count(results, (r) => r.error?.code === 'INSUFFICIENT_BALANCE');
          run.check('Exactly two payments succeed', succeeded === 2, `${succeeded} succeeded`);
          run.check('The other three fail with INSUFFICIENT_BALANCE', refused === 3, `${refused} refused`);
          const left = await balanceOf(payer);
          run.check('Payer balance is ₹200, never negative', left === 200, `balance ${rupees(left)}`);
          run.check('Payee received exactly ₹800', (await balanceOf(payee)) === 800);
          const after = await metrics();
          run.check(
            'Requests queued behind the payer lock instead of racing',
            after.locks.contended - before.locks.contended >= 4,
            `${after.locks.contended - before.locks.contended} lock waits`,
          );
          const audit = (await system('GET', '/ledger/verify')).data;
          run.check('Ledger audit still passes', audit.healthy === true, `${audit.entries} entries checked`);
          run.spotlight(results.find((r) => r.error) ?? results[0], 'One of the refused payments');
        },
      },
      {
        id: 'refund-once',
        title: 'A refund can only happen once',
        expect: 'SUCCESS moves to REFUNDED exactly once. The state machine refuses a second refund.',
        async run(run) {
          const payer = await funded('payer', 500);
          const payee = await newUser('payee');
          const payment = await must(await pay(payer, payee, 300), 'Payment');
          const id = payment.data.transaction.id;
          const grab = await api('POST', `/transactions/${id}/refund`, { user: payer.id, body: { pin: PIN } });
          run.check(
            'The payer cannot pull the money back themselves',
            grab.status === 403 && grab.error?.code === 'REFUND_NOT_ALLOWED',
            `HTTP ${grab.status} ${grab.error?.code}`,
          );
          const refund = await api('POST', `/transactions/${id}/refund`, { user: payee.id, body: { pin: PIN } });
          run.check('Payee refunds the payment', refund.ok && statusOf(refund) === 'REFUNDED', `HTTP ${refund.status}`);
          run.check('Both balances are back where they started', (await balanceOf(payer)) === 500 && (await balanceOf(payee)) === 0);
          const again = await api('POST', `/transactions/${id}/refund`, { user: payee.id, body: { pin: PIN } });
          run.check(
            'A second refund is refused',
            again.status === 409 && again.error?.code === 'ILLEGAL_STATE_TRANSITION',
            `HTTP ${again.status} ${again.error?.code}`,
          );
          const stranger = await newUser('stranger');
          const peek = await api('GET', `/transactions/${id}`, { user: stranger.id });
          run.check('Someone who is not a party cannot even see it', peek.status === 404, `HTTP ${peek.status}`);
          run.spotlight(refund, 'The refund');
        },
      },
    ],
  },
  {
    title: 'Validation pipeline',
    scenarios: [
      {
        id: 'bad-requests',
        title: 'Bad requests are turned away at the door',
        expect: 'Wrong PIN, unknown payee, missing key, malformed amount: rejected before anything is recorded.',
        async run(run) {
          const payer = await funded('payer', 100);
          const payee = await newUser('payee');
          const wrongPin = await pay(payer, payee, 10, { pin: '9999' });
          run.check('Wrong PIN gives 401 INVALID_PIN', wrongPin.status === 401 && wrongPin.error?.code === 'INVALID_PIN');
          const nobody = await pay(payer, 'nobody.here@miniupi', 10);
          run.check('Unknown payee gives 404 RECEIVER_NOT_FOUND', nobody.status === 404 && nobody.error?.code === 'RECEIVER_NOT_FOUND');
          const noKey = await api('POST', '/transfers', { user: payer.id, body: { receiverUpiId: payee.upiId, amount: 10, pin: PIN } });
          run.check('Missing Idempotency-Key gives 400', noKey.status === 400 && noKey.error?.code === 'IDEMPOTENCY_KEY_REQUIRED');
          const text = await api('POST', '/transfers', { user: payer.id, key: newKey(), body: { receiverUpiId: payee.upiId, amount: '10', pin: PIN } });
          run.check('Amount sent as text gives 400', text.status === 400, text.error?.code);
          const negative = await api('POST', '/transfers', { user: payer.id, key: newKey(), body: { receiverUpiId: payee.upiId, amount: -5, pin: PIN } });
          run.check('Negative amount gives 400 INVALID_AMOUNT', negative.status === 400 && negative.error?.code === 'INVALID_AMOUNT');
          const self = await pay(payer, payer, 10);
          run.check('Paying yourself from your wallet gives 422 SELF_TRANSFER', self.status === 422 && self.error?.code === 'SELF_TRANSFER');
          const history = (await historyOf(payer, '&consistency=strong')).data;
          run.check(
            'Only the top-up and the self-transfer attempt were recorded',
            history.length === 2,
            `${history.length} transactions on record`,
          );
          run.check('No money moved', (await balanceOf(payer)) === 100);
          run.spotlight(wrongPin, 'The wrong-PIN request');
        },
      },
      {
        id: 'pin-lockout',
        title: 'Guessing the UPI PIN',
        expect: 'A 4-digit PIN has only 10,000 values. Five wrong guesses lock PIN entry, even for the right PIN.',
        async run(run) {
          const payer = await funded('payer', 100);
          const payee = await newUser('payee');
          const guesses = [];
          for (const pin of ['0000', '1111', '2222', '3333', '4444']) guesses.push(await pay(payer, payee, 10, { pin }));
          run.check('Five wrong PINs are each refused', guesses.every((g) => g.status === 401 && g.error?.code === 'INVALID_PIN'));
          run.check('The error counts down the attempts left', guesses[0].error?.details?.attemptsLeft === 4 && guesses[4].error?.details?.attemptsLeft === 0);
          const correct = await pay(payer, payee, 10);
          run.check('Now even the correct PIN is refused: PIN entry is locked', correct.status === 401 && correct.error?.code === 'PIN_LOCKED', correct.error?.message);
          run.check('No money moved', (await balanceOf(payer)) === 100);
          run.spotlight(correct, 'The locked-out request');
        },
      },
      {
        id: 'blacklist',
        title: 'Fraud rule: a payee reported for fraud',
        expect: 'quickloan@miniupi is on the blacklist. The fraud step blocks the payment and records it as FAILED.',
        async run(run) {
          const payer = await funded('payer', 500);
          const result = await pay(payer, 'quickloan@miniupi', 50);
          run.check('Blocked with 403 FRAUD_SUSPECTED', result.status === 403 && result.error?.code === 'FRAUD_SUSPECTED', result.error?.message);
          run.check('The rule that fired is named', result.error?.details?.rule === 'Blacklisted payee', result.error?.details?.rule);
          run.check('The attempt is on record as FAILED', statusOf(result) === 'FAILED');
          run.check('No money moved', (await balanceOf(payer)) === 500);
          run.spotlight(result, 'The blocked payment');
        },
      },
      {
        id: 'new-payee',
        title: 'Fraud rule: a large first payment to someone new',
        expect: 'A big first-ever payment is the classic scam pattern. A small one first builds trust.',
        async run(run) {
          const payer = await funded('payer', 15000);
          const payee = await newUser('payee');
          const big = await pay(payer, payee, 12000);
          run.check(`First payment of ${rupees(12000)} is blocked`, big.status === 403 && big.error?.details?.rule === 'High value to new payee', big.error?.message);
          const small = await pay(payer, payee, 100);
          run.check(`A ${rupees(100)} payment to the same person goes through`, small.status === 201);
          const bigAgain = await pay(payer, payee, 12000);
          run.check(`Now ${rupees(12000)} is allowed: the payee is known`, bigAgain.status === 201, `HTTP ${bigAgain.status} ${bigAgain.error?.code ?? ''}`);
          run.spotlight(big, 'The blocked payment');
        },
      },
      {
        id: 'velocity',
        title: 'Fraud rule: too many payments in a minute',
        expect: 'A burst of payments looks like a script or a stolen phone. The velocity rule stops the burst.',
        async run(run) {
          const payer = await funded('payer', 100);
          const payee = await newUser('payee');
          const outcomes = [];
          let blocked = null;
          for (let i = 1; i <= 8 && !blocked; i += 1) {
            const result = await pay(payer, payee, 1);
            outcomes.push(result.status);
            if (result.error?.details?.rule === 'Payment velocity') blocked = { result, at: i };
          }
          run.step(`Responses in order: ${outcomes.join(', ')}`);
          run.check('The burst is cut off by the velocity rule', blocked !== null, blocked ? `payment ${blocked.at} was blocked: ${blocked.result.error.message}` : 'never blocked');
          run.check('Every payment before that succeeded', outcomes.slice(0, -1).every((status) => status === 201));
          if (blocked) run.spotlight(blocked.result, 'The blocked payment');
        },
      },
      {
        id: 'daily-limit',
        title: 'Daily transfer limit',
        expect: 'This user may send ₹1,000 a day. The limit counts what was already sent today.',
        async run(run) {
          const payer = await funded('payer', 3000, { dailyLimit: 1000 });
          const payee = await newUser('payee');
          const first = await pay(payer, payee, 600);
          run.check(`${rupees(600)} is within the limit`, first.status === 201);
          const second = await pay(payer, payee, 600);
          run.check(
            `Another ${rupees(600)} would make ₹1,200: refused`,
            second.status === 422 && second.error?.code === 'DAILY_LIMIT_EXCEEDED',
            `HTTP ${second.status} ${second.error?.code}`,
          );
          const third = await pay(payer, payee, 400);
          run.check(`${rupees(400)} lands exactly on the limit and is allowed`, third.status === 201);
          run.spotlight(second, 'The refused payment');
        },
      },
    ],
  },
  {
    title: 'When a dependency fails',
    scenarios: [
      {
        id: 'bank-outage',
        title: 'Bank outage and the circuit breaker',
        expect: 'After three failures the breaker opens and fails fast. It recovers on its own once the bank is back.',
        async run(run) {
          const user = await newUser('payer');
          await linkBank(user);
          await system('POST', '/breakers/reset');
          try {
            await system('PUT', '/chaos', { bank: { down: true } });
            run.step('The bank network is now down. Trying to add money three times.');
            for (let i = 1; i <= 3; i += 1) {
              const attempt = await topUp(user, 100);
              run.check(`Attempt ${i}: the bank does not answer`, attempt.status === 503 && attempt.error?.code === 'GATEWAY_UNAVAILABLE', `${attempt.error?.code} after ${attempt.ms} ms`);
            }
            const fast = await topUp(user, 100);
            run.check('Attempt 4 is refused instantly: the circuit is open', fast.error?.code === 'CIRCUIT_OPEN', `${fast.error?.code} after ${fast.ms} ms, the bank was not even called`);
            run.spotlight(fast, 'The fail-fast request');
            run.check('No money was created by any of the attempts', (await balanceOf(user)) === 0);

            await system('PUT', '/chaos', { bank: { down: false } });
            run.step('The bank is back. Waiting for the breaker cool-down to end.');
            for (let waited = 0; waited < 14; waited += 1) {
              const breaker = (await metrics()).circuitBreakers.find((b) => b.name === 'Bank network');
              if (breaker.state !== 'OPEN') break;
              await sleep(1000);
            }
            const trial = await topUp(user, 100);
            run.check('The trial call succeeds and money arrives', trial.status === 201 && (await balanceOf(user)) === 100, `HTTP ${trial.status}`);
            const breaker = (await metrics()).circuitBreakers.find((b) => b.name === 'Bank network');
            run.check('The circuit is CLOSED again', breaker.state === 'CLOSED', breaker.state);
          } finally {
            await system('PUT', '/chaos', { bank: { down: false } });
          }
        },
      },
      {
        id: 'saga',
        title: 'Charged at the bank, but the credit fails',
        expect: 'The two steps live in different systems. If the second fails, the first is undone automatically.',
        async run(run) {
          const payer = await newUser('payer');
          const payee = await newUser('payee');
          const bankId = await linkBank(payer);
          try {
            await system('PUT', '/chaos', { failNextCredit: true });
            run.step(`Paying ${rupees(500)} straight from the bank account. The wallet credit is rigged to fail once.`);
            const result = await pay(payer, payee, 500, { sourceId: bankId });
            run.check('The client is told the money was returned', result.error?.code === 'CREDIT_FAILED_REFUNDED', `HTTP ${result.status} ${result.error?.message ?? ''}`);
            run.check('The transaction ends as REFUNDED', statusOf(result) === 'REFUNDED', statusOf(result));
            run.check('The payee received nothing', (await balanceOf(payee)) === 0);
            const details = await api('GET', `/transactions/${result.data.transaction.id}?consistency=strong`, { user: payer.id });
            const path = details.data.timeline.map((event) => event.to).join(' › ');
            run.check('Lifecycle shows the compensation', path === 'INITIATED › PROCESSING › FAILED › REFUNDED', path);
            run.spotlight(result, 'The compensated payment');
          } finally {
            await system('PUT', '/chaos', { failNextCredit: false });
          }
        },
      },
      {
        id: 'notifications-dlq',
        title: 'Notification provider down: retry, dead-letter, redrive',
        expect: 'A broken SMS provider must never fail a payment. Messages retry, park in a dead-letter queue, and can be replayed.',
        async run(run) {
          const payer = await funded('payer', 100);
          const payee = await newUser('payee');
          await sleep(500); // let the top-up's own notifications finish before breaking the provider
          try {
            const before = (await metrics()).deadLetters;
            await system('PUT', '/chaos', { notificationFailureRate: 1 });
            const payment = await pay(payer, payee, 10);
            run.check('The payment itself succeeds', payment.status === 201, `HTTP ${payment.status} in ${payment.ms} ms`);
            run.spotlight(payment, 'The payment');
            run.step('Every delivery attempt fails. Waiting for three attempts with growing gaps.');
            let dead = 0;
            for (let waited = 0; waited < 12 && dead < 4; waited += 1) {
              await sleep(400);
              dead = (await metrics()).deadLetters - before;
            }
            run.check('All four messages ended in the dead-letter queue', dead === 4, `${dead} dead letters`);
            const failed = (await api('GET', '/notifications?consistency=strong', { user: payer.id })).data;
            run.check('They are recorded as FAILED after 3 attempts', failed.some((n) => n.status === 'FAILED' && n.attempts === 3));

            await system('PUT', '/chaos', { notificationFailureRate: 0 });
            const redrive = await system('POST', '/queue/redrive');
            run.step(`Provider is healthy again. Redrove ${redrive.data.redriven} messages.`);
            await sleep(900);
            const sent = (await api('GET', '/notifications?consistency=strong', { user: payer.id })).data;
            run.check(
              'The same notifications are now SENT, with no duplicates',
              count(sent, (n) => n.transactionId === payment.data.transaction.id && n.status === 'SENT') === 2 &&
                count(sent, (n) => n.transactionId === payment.data.transaction.id) === 2,
            );
          } finally {
            await system('PUT', '/chaos', { notificationFailureRate: 0 });
          }
        },
      },
      {
        id: 'node-down',
        title: 'An app server dies',
        expect: 'App nodes hold no state, so the load balancer simply routes around a dead one.',
        async run(run) {
          const servedBy = async () => {
            const nodes = new Set();
            for (let i = 0; i < 6; i += 1) nodes.add((await api('GET', '/users/resolve?upiId=alice@miniupi', { user: null })).meta.servedBy);
            return [...nodes].sort();
          };
          try {
            const healthy = await servedBy();
            run.check('Requests rotate across all three nodes', healthy.length === 3, healthy.join(', '));
            await system('PUT', '/nodes/app-node-2', { healthy: false });
            const degraded = await servedBy();
            run.check('With app-node-2 down, nobody notices', degraded.length === 2 && !degraded.includes('app-node-2'), degraded.join(', '));
          } finally {
            await system('PUT', '/nodes/app-node-2', { healthy: true });
          }
          const recovered = await servedBy();
          run.check('It rejoins the rotation when it is back', recovered.includes('app-node-2'), recovered.join(', '));
        },
      },
    ],
  },
  {
    title: 'Scaling reads and background work',
    scenarios: [
      {
        id: 'replica-lag',
        title: 'Read replica lag and read-your-writes',
        expect: 'History is read from a replica that trails the primary. The payer still sees their own payment at once.',
        async run(run) {
          const payer = await funded('payer', 500);
          const payee = await newUser('payee');
          await sleep(900); // let the replica catch up with the set-up before slowing it down
          try {
            await system('PUT', '/chaos', { replicaLagMs: 3000 });
            run.step('The replica now trails the primary by 3 seconds.');
            const payment = await must(await pay(payer, payee, 50), 'Payment');
            const id = payment.data.transaction.id;
            const has = (result) => result.data.some((txn) => txn.id === id);

            const payeeNow = await historyOf(payee);
            run.check('Payee reads from the replica and does not see it yet', payeeNow.meta.dataSource === 'replica' && !has(payeeNow), `read from ${payeeNow.meta.dataSource}`);
            const payerNow = await historyOf(payer);
            run.check('Payer is routed to the primary and sees it at once', payerNow.meta.dataSource === 'primary' && has(payerNow), `read from ${payerNow.meta.dataSource}`);
            run.spotlight(payerNow, "The payer's history read");
            const strong = await historyOf(payee, '&consistency=strong');
            run.check('Payee can ask for a strong read when it matters', strong.meta.dataSource === 'primary' && has(strong));
            run.step('Waiting 3.4 seconds for replication.');
            await sleep(3400);
            const payeeLater = await historyOf(payee);
            run.check('The replica has caught up: payee now sees the payment', payeeLater.meta.dataSource === 'replica' && has(payeeLater), `read from ${payeeLater.meta.dataSource}`);
          } finally {
            await system('PUT', '/chaos', { replicaLagMs: 400 });
          }
        },
      },
      {
        id: 'cache',
        title: 'Cache-aside on the wallet balance',
        expect: 'Balance reads are served from the cache. A payment invalidates it, so nobody sees a stale balance.',
        async run(run) {
          const payer = await funded('payer', 300);
          const payee = await newUser('payee');
          const first = await api('GET', '/me', { user: payer.id });
          run.check('First balance read misses the cache', (await traceText(first)).includes('MISS wallet:'));
          const second = await api('GET', '/me', { user: payer.id });
          run.check('Second read is a cache hit: no database query', (await traceText(second)).includes('HIT wallet:'));
          run.spotlight(second, 'The cached read');
          const payment = await must(await pay(payer, payee, 120), 'Payment');
          run.check('The payment invalidates both cached wallets', (await traceText(payment)).split('Invalidated wallet:').length === 3);
          const third = await api('GET', '/me', { user: payer.id });
          run.check('The next read reloads and shows the new balance', (await traceText(third)).includes('MISS wallet:') && third.data.wallet.balance === 180, rupees(third.data.wallet.balance));
        },
      },
      {
        id: 'rate-limit',
        title: 'Rate limiting a noisy client',
        expect: 'Each caller has a token bucket. A burst beyond it gets 429 with a Retry-After, then service resumes.',
        async run(run) {
          const user = await newUser('client');
          run.step('Sending 70 requests at once as one user.');
          const results = await Promise.all(Array.from({ length: 70 }, () => api('GET', '/me', { user: user.id })));
          const allowed = count(results, (r) => r.status === 200);
          const limited = results.filter((r) => r.status === 429);
          run.check('Roughly one bucket of requests is served', allowed >= 25 && allowed <= 50, `${allowed} served`);
          run.check('The rest get 429 RATE_LIMIT_EXCEEDED', limited.length === 70 - allowed && limited.length > 0, `${limited.length} rejected`);
          run.check('Rejections say when to retry', limited.every((r) => r.meta.retryAfter !== null), `Retry-After: ${limited[0]?.meta.retryAfter}s`);
          if (limited[0]) run.spotlight(limited[0], 'A rejected request');
          await sleep(1500);
          const later = await api('GET', '/me', { user: user.id });
          run.check('After the bucket refills, requests are served again', later.status === 200);
        },
      },
      {
        id: 'scheduled',
        title: 'A scheduled payment runs by itself',
        expect: 'Scheduling was added without touching the payment flow: the scheduler calls the same transfer service.',
        async run(run) {
          const payer = await funded('payer', 200);
          const payee = await newUser('payee');
          const scheduled = await api('POST', '/scheduled-payments', {
            user: payer.id,
            body: { receiverUpiId: payee.upiId, amount: 50, pin: PIN, delaySeconds: 3 },
          });
          run.check('Payment scheduled for three seconds from now', scheduled.status === 201 && scheduled.data.status === 'PENDING');
          run.check('Nothing has moved yet', (await balanceOf(payee)) === 0);
          let item;
          for (let waited = 0; waited < 12; waited += 1) {
            await sleep(700);
            item = (await api('GET', '/scheduled-payments', { user: payer.id })).data.find((s) => s.id === scheduled.data.id);
            if (item.status !== 'PENDING') break;
          }
          run.check('The scheduler executed it', item.status === 'EXECUTED', item.status);
          run.check('Payee received the money', (await balanceOf(payee)) === 50);
          const details = await api('GET', `/transactions/${item.transactionId}?consistency=strong`, { user: payer.id });
          run.check('It went through the normal lifecycle', details.data.timeline.map((e) => e.to).join(' › ') === 'INITIATED › PROCESSING › SUCCESS');
        },
      },
    ],
  },
  {
    title: 'Audit',
    scenarios: [
      {
        id: 'tamper',
        title: 'Try to rewrite the ledger',
        expect: 'The ledger is append-only at the database level. Even direct SQL cannot change history.',
        async run(run) {
          const attempt = (await must(await system('POST', '/ledger/tamper-test'), 'Tamper test')).data;
          run.check('UPDATE on a ledger entry is refused by the database', attempt.update.blocked, attempt.update.databaseSaid);
          run.check('DELETE of a ledger entry is refused by the database', attempt.delete.blocked, attempt.delete.databaseSaid);
          run.check('INSERT OR REPLACE over an entry is refused too', attempt.replace.blocked, attempt.replace.databaseSaid);
          const audit = (await system('GET', '/ledger/verify')).data;
          run.check('Hash chain is unbroken', audit.chainIntact, `${audit.entries} entries`);
          run.check('Every transaction has equal debits and credits', audit.unbalancedTransactions.length === 0);
          run.check('Every wallet balance equals the sum of its ledger entries', audit.walletMismatches.length === 0);
        },
      },
    ],
  },
];

// ---------- Rendering and running ----------

const log = $('#console-log');
const consoleRail = $('#console-rail');
const consoleRailMeta = $('#console-rail-meta');
let running = false;

function setRunning(state) {
  running = state;
  document.querySelectorAll('#scenarios button').forEach((button) => (button.disabled = state));
}

async function runScenario(scenario, card) {
  const verdict = card.querySelector('.verdict');
  document.querySelectorAll('.scenario.active').forEach((el) => el.classList.remove('active'));
  card.classList.add('active');
  $('#console-title').textContent = scenario.title;
  const consoleVerdict = $('#console-verdict');
  consoleVerdict.textContent = 'Running';
  consoleVerdict.className = 'verdict running';
  verdict.textContent = 'Running';
  verdict.className = 'verdict running';
  fill(log);
  $('#console-rail-box').hidden = true;
  clearRail(consoleRail, consoleRailMeta, '');

  const run = new Run(log);
  try {
    await scenario.run(run);
  } catch (error) {
    run.check('Scenario ran to completion', false, error instanceof Error ? error.message : String(error));
  }
  const passed = run.failed === 0;
  const summary = passed ? `Passed ${run.passed} checks` : `${run.failed} of ${run.passed + run.failed} checks failed`;
  for (const target of [verdict, consoleVerdict]) {
    target.textContent = summary;
    target.className = `verdict ${passed ? 'pass' : 'fail'}`;
  }
  if (run.keyResult) {
    $('#console-rail-box').hidden = false;
    watchTrace(run.keyResult, consoleRail, consoleRailMeta, { title: run.keyTitle });
  }
  return passed;
}

export function showLab() {
  const box = $('#scenarios');
  if (box.childElementCount > 0) return;

  const cards = [];
  const runAll = h('button', { class: 'primary', type: 'button' }, 'Run every scenario');
  const tally = h('span', { class: 'verdict' });
  runAll.addEventListener('click', async () => {
    if (running) return;
    setRunning(true);
    let passed = 0;
    for (const { scenario, card } of cards) {
      tally.textContent = `Running ${cards.findIndex((c) => c.card === card) + 1} of ${cards.length}`;
      tally.className = 'verdict running';
      if (await runScenario(scenario, card)) passed += 1;
    }
    tally.textContent = `${passed} of ${cards.length} scenarios passed`;
    tally.className = `verdict ${passed === cards.length ? 'pass' : 'fail'}`;
    setRunning(false);
  });
  box.append(h('div', { class: 'pay-actions' }, runAll, tally, h('span', { class: 'hint' }, 'Takes about a minute.')));

  for (const group of GROUPS) {
    const section = h('section', { class: 'scenario-group' }, h('h2', {}, group.title));
    for (const scenario of group.scenarios) {
      const button = h('button', { type: 'button', class: 'small' }, 'Run');
      const card = h(
        'div',
        { class: 'scenario' },
        h('h3', {}, scenario.title),
        h('p', {}, scenario.expect),
        h('div', { class: 'run' }, h('span', { class: 'verdict' }), button),
      );
      button.addEventListener('click', async () => {
        if (running) return;
        setRunning(true);
        await runScenario(scenario, card);
        setRunning(false);
      });
      cards.push({ scenario, card });
      section.append(card);
    }
    box.append(section);
  }
}
