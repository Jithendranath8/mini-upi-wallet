// The wallet screen: balance, payment sources, send money, activity, notifications.
import { api, newKey, session } from './api.js';
import { $, busy, clock, dayAndClock, fill, formValues, h, rupees, sleep, toast } from './dom.js';
import { clearRail, watchTrace } from './trace.js';

const rail = $('#rail');
const railMeta = $('#rail-meta');

let profile = null;
let openTransactionId = null;
/** The last payment request, kept so "Send the same request again" can replay it byte for byte. */
let lastPayment = null;
let scheduleWatcher = null;
/** Cursor of the next (older) page of history, or null when everything is shown. */
let olderCursor = null;

export async function showWallet({ resetTrace = false } = {}) {
  if (resetTrace) {
    lastPayment = null;
    openTransactionId = null;
    $('#retry-button').hidden = true;
    setMessage('');
    clearRail(rail, railMeta, 'Make a payment or press Refresh to see its path through the system.');
  }
  await Promise.all([loadProfile(), loadHistory(), loadNotifications(), loadScheduled()]);
}

// ---------- Account ----------

async function loadProfile({ trace = false } = {}) {
  const result = await api('GET', '/me');
  if (!result.ok) return toast(result.error?.message ?? 'Could not load your account.', true);
  profile = result.data;
  $('#balance').textContent = rupees(profile.wallet.balance);
  $('#upi-id').textContent = profile.user.upiId;
  $('#daily-limit').textContent = `Daily limit ${rupees(profile.user.dailyLimit)}`;

  fill(
    $('#sources'),
    profile.sources.map((source) =>
      h(
        'li',
        {},
        h('span', {}, source.label),
        h('span', { class: 'source-kind' }, source.isExternal ? `up to ${rupees(source.perTransactionLimit)}` : 'default'),
      ),
    ),
  );
  const option = (source) => h('option', { value: source.id }, source.label);
  fill($('#pay-form [name=sourceId]'), profile.sources.map(option));
  const external = profile.sources.filter((source) => source.isExternal);
  fill($('#topup-form [name=sourceId]'), external.map(option));
  $('#topup-box').hidden = external.length === 0;

  if (trace) watchTrace(result, rail, railMeta, { title: 'GET /me' });
}

export function setPayees(users) {
  fill(
    $('#payees'),
    users.filter((user) => user.id !== session.userId).map((user) => h('option', { value: user.upiId }, user.name)),
  );
}

// ---------- Activity ----------

async function loadHistory() {
  const result = await api('GET', '/transactions?limit=12');
  if (!result.ok) return;
  const chip = $('#history-source');
  chip.textContent = result.meta.dataSource ? `read from ${result.meta.dataSource}` : '';
  chip.className = `chip ${result.meta.dataSource ?? ''}`;

  const list = $('#history');
  if (result.data.length === 0) {
    return fill(list, h('li', { class: 'empty' }, 'No payments yet. Send money to someone to get started.'));
  }
  fill(list, result.data.map(transactionItem));
  olderCursor = result.page?.nextCursor ?? null;
  $('#older-button').hidden = !olderCursor;
  if (openTransactionId) {
    const open = list.querySelector(`[data-id="${CSS.escape(openTransactionId)}"]`);
    if (open) showDetails(open, openTransactionId);
  }
}

function transactionItem(txn) {
  const outgoing = txn.sender.id === session.userId;
  const topUp = txn.type === 'TOPUP';
  const title = topUp
    ? txn.source.type === 'WALLET' ? 'To yourself' : 'Added to wallet'
    : outgoing ? `To ${txn.receiver.name}` : `From ${txn.sender.name}`;
  const moved = txn.status === 'SUCCESS';
  const incoming = topUp || !outgoing;

  const item = h('li', { 'data-id': txn.id });
  item.append(
    h(
      'button',
      {
        class: 'txn-row',
        type: 'button',
        'aria-expanded': 'false',
        onclick: () => toggleDetails(item, txn.id),
      },
      h('span', { class: 'txn-title' }, title),
      h(
        'span',
        { class: `txn-amount ${!moved ? 'void' : incoming ? 'in' : ''}` },
        moved ? `${incoming ? '+' : '−'} ${rupees(txn.amount)}` : rupees(txn.amount),
      ),
      h(
        'span',
        { class: 'txn-sub' },
        h('span', { class: `pill ${txn.status}` }, txn.status),
        h('span', {}, dayAndClock(txn.createdAt)),
        h('span', {}, `via ${txn.source.label}`),
        txn.note && h('span', {}, `“${txn.note}”`),
      ),
    ),
  );
  return item;
}

function toggleDetails(item, transactionId) {
  if (item.querySelector('.txn-details')) {
    item.querySelector('.txn-details').remove();
    item.querySelector('.txn-row').setAttribute('aria-expanded', 'false');
    openTransactionId = null;
    return;
  }
  showDetails(item, transactionId);
}

async function showDetails(item, transactionId) {
  const result = await api('GET', `/transactions/${transactionId}`);
  if (!result.ok) return toast(result.error?.message ?? 'Could not load that payment.', true);
  openTransactionId = transactionId;
  const { transaction, timeline, ledger } = result.data;

  const box = h(
    'div',
    { class: 'txn-details' },
    h('h3', {}, 'Lifecycle'),
    h(
      'div',
      { class: 'timeline' },
      timeline.flatMap((event, index) => [
        index > 0 && h('span', { class: 'then', 'aria-hidden': 'true' }, '›'),
        h('span', { class: `pill ${event.to}`, title: `${event.detail} (${clock(event.at)})` }, event.to),
      ]),
    ),
    transaction.failureReason && h('p', {}, `Reason: ${transaction.failureReason} (${transaction.failureCode})`),
    h('h3', {}, 'Details'),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Transaction'),
      h('dd', { class: 'mono' }, transaction.id),
      h('dt', {}, 'From'),
      h('dd', {}, `${transaction.sender.name} (${transaction.sender.upiId})`),
      h('dt', {}, 'To'),
      h('dd', {}, `${transaction.receiver.name} (${transaction.receiver.upiId})`),
      h('dt', {}, 'Paid with'),
      h('dd', {}, transaction.source.label),
      h('dt', {}, 'Read from'),
      h('dd', {}, result.meta.dataSource ?? 'primary'),
    ),
    h('h3', {}, `Ledger entries (${ledger.length})`),
    ledger.length === 0
      ? h('p', { class: 'hint' }, 'No money moved, so nothing was written to the ledger.')
      : h(
          'dl',
          { class: 'kv' },
          ledger.flatMap((entry) => [
            h('dt', { class: `entry-${entry.entryType}` }, `${entry.entryType} ${rupees(entry.amount)}`),
            h('dd', {}, `${entry.description} · `, h('span', { class: 'mono' }, entry.accountId)),
          ]),
        ),
    transaction.status === 'SUCCESS' &&
      (transaction.receiver.id === session.userId
        ? refundControls(transaction)
        : h('p', { class: 'hint refund-row' }, `Only ${transaction.receiver.name} can refund this payment.`)),
  );

  item.querySelector('.txn-details')?.remove();
  item.append(box);
  item.querySelector('.txn-row').setAttribute('aria-expanded', 'true');
}

function refundControls(transaction) {
  const pin = h('input', {
    type: 'password',
    inputmode: 'numeric',
    maxlength: '6',
    placeholder: 'UPI PIN',
    'aria-label': 'UPI PIN to confirm the refund',
    value: session.pin,
  });
  const button = h('button', { class: 'small danger', type: 'button' }, `Refund ${rupees(transaction.amount)}`);
  button.addEventListener('click', () =>
    busy(button, async () => {
      const result = await api('POST', `/transactions/${transaction.id}/refund`, { body: { pin: pin.value } });
      watchTrace(result, rail, railMeta, { title: 'Refund' });
      if (!result.ok) return toast(result.error?.message ?? 'Refund failed.', true);
      session.pin = pin.value;
      toast(`Refunded ${rupees(transaction.amount)}.`);
      await refreshSoon();
    }),
  );
  return h('div', { class: 'refund-row' }, pin, button, h('span', { class: 'hint' }, 'You received this money, so only you can send it back. It can be refunded once.'));
}

// ---------- Notifications and scheduled payments ----------

async function loadNotifications() {
  const result = await api('GET', '/notifications?limit=8');
  if (!result.ok) return;
  const list = $('#notifications');
  if (result.data.length === 0) {
    return fill(list, h('li', { class: 'empty' }, 'Nothing yet. Notifications arrive a moment after each payment.'));
  }
  fill(
    list,
    result.data.map((n) =>
      h(
        'li',
        {},
        h(
          'div',
          { class: 'notification-head' },
          h('strong', {}, n.title),
          h('span', {}, `${n.channel} `, h('span', { class: `pill ${n.status}` }, n.status), n.attempts > 1 && ` after ${n.attempts} tries`),
        ),
        h('div', {}, n.body),
      ),
    ),
  );
}

async function loadScheduled() {
  const result = await api('GET', '/scheduled-payments');
  if (!result.ok) return;
  const panel = $('#scheduled-panel');
  panel.hidden = result.data.length === 0;
  fill(
    $('#scheduled'),
    result.data.map((item) =>
      h(
        'li',
        {},
        h(
          'span',
          {},
          `${rupees(item.amount)} to ${item.receiverUpiId} at ${clock(item.executeAt)} `,
          h('span', { class: `pill ${item.status}` }, item.status),
          item.failureReason && h('span', { class: 'hint' }, ` ${item.failureReason}`),
        ),
        item.status === 'PENDING' &&
          h('button', { class: 'small', type: 'button', onclick: () => cancelScheduled(item.id) }, 'Cancel'),
      ),
    ),
  );

  // Keep watching only while something is waiting to run.
  const pending = result.data.some((item) => item.status === 'PENDING' || item.status === 'RUNNING');
  if (pending && !scheduleWatcher) {
    scheduleWatcher = setInterval(async () => {
      await Promise.all([loadScheduled(), loadProfile(), loadHistory(), loadNotifications()]);
    }, 2000);
  } else if (!pending && scheduleWatcher) {
    clearInterval(scheduleWatcher);
    scheduleWatcher = null;
    refreshSoon();
  }
}

async function cancelScheduled(id) {
  const result = await api('DELETE', `/scheduled-payments/${id}`);
  if (!result.ok) toast(result.error?.message ?? 'Could not cancel.', true);
  await loadScheduled();
}

// ---------- Actions ----------

/** Refresh now, and again once queue workers and the replica have had time to catch up. */
async function refreshSoon() {
  await showWallet();
  await sleep(1500);
  await showWallet();
}

function setMessage(text, kind = '') {
  const message = $('#pay-message');
  message.textContent = text;
  message.className = `form-message ${kind}`;
}

async function sendPayment(request, { isRetry = false } = {}) {
  const result = await api('POST', '/transfers', { body: request.body, key: request.key });
  watchTrace(result, rail, railMeta, { title: isRetry ? 'Same request again' : 'Send money' });

  const txn = result.data?.transaction;
  if (result.meta.replayed) {
    setMessage(`Same Idempotency-Key: the server replayed the stored result (${txn.status}). No second debit.`, 'note');
  } else if (result.ok) {
    setMessage(`Paid ${rupees(txn.amount)} to ${txn.receiver.name}.`, 'good');
  } else {
    setMessage(result.error?.message ?? 'Payment failed.', 'bad');
  }
  if (txn) session.pin = request.body.pin;
  $('#retry-button').hidden = !txn; // only requests that reached the payment pipeline can be replayed
  refreshSoon();
}

/** Keyset pagination: asks for the page that comes after the last row on screen. */
async function loadOlder() {
  if (!olderCursor) return;
  const result = await api('GET', `/transactions?limit=12&before=${encodeURIComponent(olderCursor)}`);
  if (!result.ok) return toast(result.error?.message ?? 'Could not load older payments.', true);
  $('#history').append(...result.data.map(transactionItem));
  olderCursor = result.page?.nextCursor ?? null;
  $('#older-button').hidden = !olderCursor;
}

export function wireWallet() {
  $('#older-button').addEventListener('click', (event) => busy(event.currentTarget, loadOlder));

  const registerForm = $('#register-form');
  registerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(registerForm.querySelector('button'), async () => {
      const values = formValues(registerForm);
      const result = await api('POST', '/users', {
        user: null,
        body: { name: values.name, phone: values.phone, pin: values.pin, upiHandle: values.upiHandle || undefined },
      });
      if (!result.ok) return toast(result.error?.message ?? 'Could not create the user.', true);
      registerForm.reset();
      registerForm.closest('details').open = false;
      toast(`Created ${result.data.user.upiId}. You are now signed in as ${result.data.user.name}.`);
      // main.js owns the sign-in picker: tell it a new user exists and should be selected.
      document.dispatchEvent(new CustomEvent('miniupi:user-created', { detail: { id: result.data.user.id } }));
    });
  });

  $('#refresh-balance').addEventListener('click', (event) => busy(event.currentTarget, () => loadProfile({ trace: true })));

  const payForm = $('#pay-form');
  payForm.addEventListener('submit', (event) => {
    event.preventDefault();
    busy($('#pay-button'), async () => {
      const values = formValues(payForm);
      const body = {
        receiverUpiId: values.receiverUpiId,
        amount: Number(values.amount),
        sourceId: values.sourceId,
        note: values.note || undefined,
        pin: values.pin,
      };
      if (values.later) {
        const result = await api('POST', '/scheduled-payments', {
          body: { ...body, delaySeconds: Number(values.delaySeconds) },
        });
        watchTrace(result, rail, railMeta, { title: 'Schedule payment' });
        if (!result.ok) return setMessage(result.error?.message ?? 'Could not schedule.', 'bad');
        session.pin = values.pin;
        setMessage(`Scheduled for ${clock(result.data.executeAt)}. It will run on its own.`, 'good');
        return loadScheduled();
      }
      lastPayment = { body, key: newKey() };
      await sendPayment(lastPayment);
    });
  });
  payForm.elements.later.addEventListener('change', (event) => {
    $('#pay-button').textContent = event.currentTarget.checked ? 'Schedule payment' : 'Pay now';
  });

  $('#retry-button').addEventListener('click', (event) =>
    busy(event.currentTarget, async () => {
      if (lastPayment) await sendPayment(lastPayment, { isRetry: true });
    }),
  );

  const topUpForm = $('#topup-form');
  topUpForm.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(topUpForm.querySelector('button'), async () => {
      const values = formValues(topUpForm);
      const result = await api('POST', '/wallet/topup', {
        body: { sourceId: values.sourceId, amount: Number(values.amount), pin: values.pin },
        key: newKey(),
      });
      watchTrace(result, rail, railMeta, { title: 'Add money' });
      if (!result.ok) return toast(result.error?.message ?? 'Could not add money.', true);
      session.pin = values.pin;
      toast(`Added ${rupees(values.amount)} to your wallet.`);
      topUpForm.elements.amount.value = '';
      refreshSoon();
    });
  });

  const linkForm = (selector, path, toBody, done) => {
    const form = $(selector);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      busy(form.querySelector('button'), async () => {
        const result = await api('POST', path, { body: toBody(formValues(form)) });
        if (!result.ok) return toast(result.error?.message ?? 'Could not link.', true);
        toast(`${done}: ${result.data.label}`);
        form.reset();
        form.closest('details').open = false;
        await loadProfile();
      });
    });
  };
  linkForm('#link-bank-form', '/payment-sources/bank-accounts', (v) => v, 'Linked');
  linkForm(
    '#link-card-form',
    '/payment-sources/cards',
    (v) => ({ ...v, expiryMonth: Number(v.expiryMonth), expiryYear: Number(v.expiryYear) }),
    'Linked',
  );
}
