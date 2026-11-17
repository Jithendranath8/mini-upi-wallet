// Live system: the components a payment passes through, their counters, and fault injection.
import { system } from './api.js';
import { $, clock, fill, h, toast } from './dom.js';

let timer = null;
let controlsBuilt = false;
let onDataReset = () => {};

export function startSystem(afterReset) {
  onDataReset = afterReset ?? onDataReset;
  if (!controlsBuilt) buildControls();
  loadDesign();
  tick();
  timer = setInterval(tick, 1000);
}

export function stopSystem() {
  clearInterval(timer);
  timer = null;
}

async function tick() {
  const [metrics, feed] = await Promise.all([system('GET', '/metrics'), system('GET', '/feed?limit=50')]);
  if (metrics.ok) {
    drawArchitecture(metrics.data);
    syncControls(metrics.data.chaos);
  }
  if (feed.ok) drawFeed(feed.data);
}

// ---------- Architecture tiles ----------

const stat = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));

function tile({ title, sub, state, tone, span = '', body }) {
  return h(
    'div',
    { class: `tile ${span} ${tone ?? ''}` },
    h('div', { class: 'tile-head' }, h('h3', {}, title), state && h('span', { class: `pill ${state}` }, state.replace('_', ' '))),
    body,
    sub && h('p', { class: 'tile-sub' }, sub),
  );
}

function tier(label, ...tiles) {
  return h('div', { class: 'tier' }, h('div', { class: 'tier-label' }, label), tiles);
}

function drawArchitecture(m) {
  const { loadBalancer, rateLimiter, cache, database, locks, idempotency, circuitBreakers, transactions } = m;
  const queue = m.queue.notifications ?? { depth: 0, inFlight: 0, scheduledRetries: 0, processed: 0, retried: 0 };
  const replication = database.replication;
  const behind = replication.primaryLsn - replication.replicaLsn;

  const nodes = h(
    'div',
    { class: 'nodes' },
    loadBalancer.nodes.map((node) =>
      h(
        'div',
        { class: `node ${node.healthy ? '' : 'down'}` },
        h('span', {}, node.id, h('strong', {}, node.served)),
        h(
          'button',
          { class: 'small', type: 'button', onclick: () => setNode(node.id, !node.healthy) },
          node.healthy ? 'Stop' : 'Start',
        ),
      ),
    ),
  );

  const breakerTile = (breaker) =>
    tile({
      title: breaker.name,
      state: breaker.state,
      tone: breaker.state === 'OPEN' ? 'alert' : breaker.state === 'HALF_OPEN' ? 'caution' : '',
      body: h(
        'dl',
        { class: 'stats' },
        stat('Failures in a row', `${breaker.consecutiveFailures}/${breaker.failureThreshold}`),
        stat('Calls refused', breaker.callsRejected),
        stat('Times opened', breaker.timesOpened),
      ),
      sub:
        breaker.state === 'OPEN'
          ? `Failing fast. Trial call allowed in ${Math.ceil(breaker.retryInMs / 1000)} s.`
          : 'Circuit breaker around the external gateway.',
    });

  fill(
    $('#architecture'),
    tier(
      'Edge: every request enters here',
      tile({
        title: 'Rate limiter',
        body: h(
          'dl',
          { class: 'stats' },
          stat('Allowed', rateLimiter.allowed),
          stat('Rejected (429)', rateLimiter.rejected + m.addressRateLimiter.rejected),
        ),
        sub: `Token bucket per signed-in user: ${rateLimiter.capacity} burst, ${rateLimiter.refillPerSecond} per second. A second, larger bucket per client address guards unauthenticated calls.`,
      }),
      tile({
        title: 'Load balancer',
        span: 'span-8',
        tone: loadBalancer.nodes.some((n) => !n.healthy) ? 'caution' : '',
        body: nodes,
        sub: `${loadBalancer.strategy} across stateless app nodes. Stop one and requests route around it.`,
      }),
    ),
    tier(
      'Payment pipeline: inside an app node',
      tile({
        title: 'Idempotency',
        body: h(
          'dl',
          { class: 'stats' },
          stat('Executed', idempotency.executed),
          stat('Replayed', idempotency.replayed),
          stat('Waited', idempotency.waitedForInFlight),
          stat('Key misuse', idempotency.keyReuseRejected),
        ),
        sub: 'Retries get the stored answer instead of a second debit.',
      }),
      tile({
        title: 'Payer locks',
        tone: locks.waitingNow > 0 ? 'caution' : '',
        body: h(
          'dl',
          { class: 'stats' },
          stat('Acquired', locks.acquired),
          stat('Had to wait', locks.contended),
          stat('Timed out', locks.timeouts),
          stat('Held now', locks.heldNow),
        ),
        sub: `One payment at a time per payer stops double spending. Held across a ${m.chaos.databaseLatencyMs} ms database round trip.`,
      }),
      tile({
        title: 'Transactions',
        body: h(
          'div',
          { class: 'status-bar' },
          Object.entries(transactions).map(([status, n]) => h('span', {}, h('span', { class: `pill ${status}` }, status), ` ${n}`)),
        ),
        sub: 'Lifecycle: Initiated, Processing, Success or Failed, Refunded.',
      }),
    ),
    tier(
      'Data',
      tile({
        title: 'Cache',
        body: [
          h(
            'dl',
            { class: 'stats' },
            stat('Hit ratio', `${Math.round(cache.hitRatio * 100)}%`),
            stat('Hits', cache.hits),
            stat('Misses', cache.misses),
            stat('Entries', cache.size),
          ),
          h('div', { class: 'meter' }, h('span', { style: `width:${Math.round(cache.hitRatio * 100)}%` })),
        ],
        sub: `Wallet balances and finished idempotency keys. ${cache.invalidations} invalidations.`,
      }),
      tile({
        title: 'Primary database',
        body: h(
          'dl',
          { class: 'stats' },
          stat('Commit LSN', database.primary.lsn),
          stat('Writes', database.primary.writes),
          stat('Rollbacks', database.primary.rollbacks),
        ),
        sub: 'All writes. Ships every commit to the replica.',
      }),
      tile({
        title: 'Read replica',
        tone: behind > 0 ? 'caution' : '',
        body: h(
          'dl',
          { class: 'stats' },
          stat('Applied LSN', replication.replicaLsn),
          stat('Commits behind', behind),
          stat('Reads here', database.readRouting.toReplica),
          stat('Sent to primary', database.readRouting.toPrimary),
        ),
        sub: `Trails the primary by ${replication.configuredLagMs} ms. Recent writers read the primary.`,
      }),
    ),
    tier(
      'Background work and the outside world',
      tile({
        title: 'Notification queue',
        tone: m.deadLetters + m.stuckCompensations > 0 ? 'alert' : queue.scheduledRetries > 0 ? 'caution' : '',
        body: [
          h(
            'dl',
            { class: 'stats' },
            stat('Waiting', queue.depth + queue.scheduledRetries),
            stat('In flight', queue.inFlight),
            stat('Delivered', queue.processed),
            stat('Retries', queue.retried),
            stat('Dead letters', m.deadLetters),
            m.stuckCompensations > 0 && stat('Stuck refunds', m.stuckCompensations),
          ),
          m.deadLetters + m.stuckCompensations > 0 &&
            h(
              'button',
              { class: 'small', type: 'button', onclick: redrive },
              `Retry ${m.deadLetters + m.stuckCompensations} parked messages`,
            ),
        ],
        sub: 'SMS, push and email are sent by workers, never by the payment request.',
      }),
      circuitBreakers.map(breakerTile),
    ),
  );
}

// ---------- Live feed ----------

function drawFeed(items) {
  fill(
    $('#feed'),
    items.length === 0
      ? h('li', {}, h('span', {}), h('span', {}), h('span', { class: 'said' }, 'Quiet. Make a payment in the Wallet tab.'))
      : items.map((item) =>
          h(
            'li',
            { class: item.level },
            h('time', {}, clock(item.timestamp)),
            h('span', { class: 'who-said' }, item.component),
            h('span', { class: 'said' }, item.message),
          ),
        ),
  );
}

// ---------- Fault injection ----------

const controls = {};

function slider(key, title, hint, { max, step, format, toPatch, fromState }) {
  const output = h('output', {}, '');
  const input = h('input', { type: 'range', min: '0', max: String(max), step: String(step), 'aria-label': title });
  input.addEventListener('input', () => (output.textContent = format(Number(input.value))));
  input.addEventListener('change', () => patchChaos(toPatch(Number(input.value))));
  controls[key] = { input, sync: (state) => {
    if (document.activeElement === input) return;
    input.value = String(fromState(state));
    output.textContent = format(Number(input.value));
  } };
  return h('div', { class: 'control' }, h('div', { class: 'control-title' }, h('span', {}, title), output), input, h('p', { class: 'hint' }, hint));
}

function toggle(key, title, hint, { toPatch, fromState }) {
  const input = h('input', { type: 'checkbox', 'aria-label': title });
  input.addEventListener('change', () => patchChaos(toPatch(input.checked)));
  controls[key] = { input, sync: (state) => (input.checked = fromState(state)) };
  return h('div', { class: 'control' }, h('label', { class: 'switch-row inline' }, h('span', { class: 'control-title' }, title), input), h('p', { class: 'hint' }, hint));
}

const percent = (value) => `${Math.round(value * 100)}%`;
const millis = (value) => `${value} ms`;

function buildControls() {
  controlsBuilt = true;
  const resetBreakers = h('button', { type: 'button' }, 'Close circuit breakers');
  resetBreakers.addEventListener('click', async () => {
    await system('POST', '/breakers/reset');
    toast('Circuit breakers closed.');
  });
  const resetData = h('button', { type: 'button', class: 'danger' }, 'Reset demo data');
  resetData.addEventListener('click', async () => {
    if (!confirm('Delete every user, payment and ledger entry and load the demo data again?')) return;
    resetData.disabled = true;
    const result = await system('POST', '/reset');
    resetData.disabled = false;
    toast(result.ok ? 'Demo data restored.' : 'Reset failed.', !result.ok);
    if (result.ok) onDataReset();
  });

  fill(
    $('#chaos-controls'),
    toggle('bankDown', 'Bank network is down', 'Bank-funded payments fail. After 3 failures the breaker opens.', {
      toPatch: (down) => ({ bank: { down } }),
      fromState: (s) => s.bank.down,
    }),
    slider('bankFail', 'Bank failure rate', 'Chance that one bank call times out.', {
      max: 1, step: 0.1, format: percent,
      toPatch: (failureRate) => ({ bank: { failureRate } }),
      fromState: (s) => s.bank.failureRate,
    }),
    slider('bankLatency', 'Bank response time', 'How long one call to the bank takes.', {
      max: 2000, step: 50, format: millis,
      toPatch: (latencyMs) => ({ bank: { latencyMs } }),
      fromState: (s) => s.bank.latencyMs,
    }),
    slider('dbLatency', 'Database round trip', 'Time one payment spends talking to the database while holding the payer lock.', {
      max: 200, step: 5, format: millis,
      toPatch: (databaseLatencyMs) => ({ databaseLatencyMs }),
      fromState: (s) => s.databaseLatencyMs,
    }),
    slider('replicaLag', 'Replica lag', 'How far the read replica trails the primary.', {
      max: 5000, step: 100, format: millis,
      toPatch: (replicaLagMs) => ({ replicaLagMs }),
      fromState: (s) => s.replicaLagMs,
    }),
    slider('notifyFail', 'Notification failure rate', 'Chance that an SMS, push or email delivery fails.', {
      max: 1, step: 0.1, format: percent,
      toPatch: (notificationFailureRate) => ({ notificationFailureRate }),
      fromState: (s) => s.notificationFailureRate,
    }),
    toggle('failCredit', 'Fail the next wallet credit', 'The next bank or card payment is charged, fails to credit, and is refunded.', {
      toPatch: (failNextCredit) => ({ failNextCredit }),
      fromState: (s) => s.failNextCredit,
    }),
    resetBreakers,
    resetData,
  );
}

function syncControls(state) {
  Object.values(controls).forEach((control) => control.sync(state));
}

async function patchChaos(patch) {
  const result = await system('PUT', '/chaos', patch);
  if (!result.ok) toast(result.error?.message ?? 'Could not apply that setting.', true);
  tick();
}

async function setNode(id, healthy) {
  await system('PUT', `/nodes/${id}`, { healthy });
  tick();
}

async function redrive() {
  const result = await system('POST', '/queue/redrive');
  if (result.ok) toast(`Put ${result.data.redriven} messages back on the queue.`);
  tick();
}

async function loadDesign() {
  const result = await system('GET', '/design');
  if (!result.ok) return;
  const d = result.data;
  const entry = (title, items) => [h('dt', {}, title), h('dd', {}, items.join(' › '))];
  fill(
    $('#plugged-in'),
    entry('Validation chain, in order', d.validationChain),
    entry('Fraud rules', d.fraudRules),
    entry('Payment strategies', d.paymentStrategies),
    entry('Observers of payment events', d.observers),
  );
}
