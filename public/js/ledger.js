// Ledger: the append-only, hash-chained record, plus the audit and the tamper test.
import { system } from './api.js';
import { $, busy, dayAndClock, fill, h, rupees } from './dom.js';

const short = (hash) => `${hash.slice(0, 10)}…`;

export async function showLedger() {
  const result = await system('GET', '/ledger?limit=80&consistency=strong');
  if (!result.ok) return;
  $('#ledger-source').textContent = `${result.data.length} most recent entries, newest first`;

  const rows = result.data;
  fill(
    $('#ledger-rows'),
    rows.length === 0
      ? h('tr', {}, h('td', { colspan: '9' }, 'The ledger is empty.'))
      : rows.map((entry, index) => {
          // Newest first: this entry's previous hash must equal the hash of the row below it.
          const older = rows[index + 1];
          const linked = older && older.hash === entry.prevHash;
          return h(
            'tr',
            {},
            h('td', { class: 'num' }, entry.sequence),
            h('td', {}, dayAndClock(entry.createdAt)),
            h('td', { class: 'hash', title: entry.transactionId }, entry.transactionId.slice(0, 12)),
            h('td', { class: 'hash', title: entry.description }, entry.accountId),
            h('td', { class: `entry-${entry.entryType}` }, entry.entryType),
            h('td', { class: 'num' }, rupees(entry.amount)),
            h('td', { class: 'num' }, entry.balanceAfter === null ? 'external' : rupees(entry.balanceAfter)),
            h('td', { class: `hash ${linked ? 'link' : ''}`, title: entry.prevHash }, short(entry.prevHash)),
            h('td', { class: 'hash link', title: entry.hash }, short(entry.hash)),
          );
        }),
  );
}

const finding = (good, text, detail) => h('div', { class: `finding ${good ? '' : 'bad'}` }, text, detail && h('small', {}, detail));

export function wireLedger() {
  $('#verify-ledger').addEventListener('click', (event) =>
    busy(event.currentTarget, async () => {
      const { ok, data } = await system('GET', '/ledger/verify');
      if (!ok) return;
      fill(
        $('#ledger-result'),
        finding(
          data.chainIntact,
          data.chainIntact ? `Hash chain intact across ${data.entries} entries` : `Hash chain is broken at entry ${data.brokenAtSequence}`,
          'Each entry stores the hash of the one before it, so rewriting any entry would break every hash after it.',
        ),
        finding(
          data.unbalancedTransactions.length === 0,
          data.unbalancedTransactions.length === 0
            ? 'Every transaction balances: debits equal credits'
            : `${data.unbalancedTransactions.length} transactions do not balance`,
          'Double entry: money is only ever moved between accounts, never created or destroyed.',
        ),
        finding(
          data.walletMismatches.length === 0,
          data.walletMismatches.length === 0
            ? 'Every wallet balance equals the sum of its ledger entries'
            : `${data.walletMismatches.length} wallets disagree with the ledger`,
          'The stored balance is a cache of the ledger; this proves they agree.',
        ),
      );
      await showLedger();
    }),
  );

  $('#tamper-ledger').addEventListener('click', (event) =>
    busy(event.currentTarget, async () => {
      const { ok, data } = await system('POST', '/ledger/tamper-test');
      if (!ok) return;
      fill(
        $('#ledger-result'),
        finding(data.update.blocked, data.update.blocked ? 'UPDATE of the latest entry was refused' : 'UPDATE succeeded: the ledger is not protected', `The database said: ${data.update.databaseSaid}`),
        finding(data.delete.blocked, data.delete.blocked ? 'DELETE of the latest entry was refused' : 'DELETE succeeded: the ledger is not protected', `The database said: ${data.delete.databaseSaid}`),
        finding(data.replace.blocked, data.replace.blocked ? 'INSERT OR REPLACE over the latest entry was refused' : 'REPLACE succeeded: the ledger is not protected', `The database said: ${data.replace.databaseSaid}`),
      );
    }),
  );
}
