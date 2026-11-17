// Entry point: sign-in picker and hash routing between the five screens.
import { api, session, signInAs } from './api.js';
import { $, fill, h, toast } from './dom.js';
import { showDesign } from './docs.js';
import { showLab } from './lab.js';
import { showLedger, wireLedger } from './ledger.js';
import { startSystem, stopSystem } from './system.js';
import { setPayees, showWallet, wireWallet } from './wallet.js';

const VIEWS = ['wallet', 'lab', 'system', 'ledger', 'design'];
const userSelect = $('#user-select');

/** Lab scenarios create throwaway users; they stay out of the sign-in picker. */
const isLabUser = (user) => user.upiId.startsWith('lab.');

async function loadUsers() {
  const result = await api('GET', '/users', { user: null });
  if (!result.ok) {
    toast(result.error?.message ?? 'Could not load users.', true);
    return false;
  }
  const users = result.data.filter((user) => !isLabUser(user));
  if (!users.some((user) => user.id === session.userId)) signInAs(users[0]?.id ?? null);
  fill(
    userSelect,
    users.map((user) => h('option', { value: user.id, selected: user.id === session.userId }, `${user.name} (${user.upiId})`)),
  );
  setPayees(users);
  return true;
}

async function route() {
  const [name, argument] = location.hash.replace(/^#/, '').split('/');
  const view = VIEWS.includes(name) ? name : 'wallet';

  for (const candidate of VIEWS) $(`#view-${candidate}`).hidden = candidate !== view;
  document.querySelectorAll('.tabs a').forEach((tab) => {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  $('.who').hidden = view !== 'wallet';

  stopSystem();
  if (view === 'wallet') await showWallet();
  else if (view === 'lab') showLab();
  else if (view === 'system') startSystem(afterDataReset);
  else if (view === 'ledger') await showLedger();
  else if (view === 'design') await showDesign(argument ? decodeURIComponent(argument) : undefined);
}

/** After "Reset demo data" every id is new: sign in again as the first user. */
async function afterDataReset() {
  signInAs(null);
  await loadUsers();
}

userSelect.addEventListener('change', async () => {
  signInAs(userSelect.value);
  await loadUsers();
  await showWallet({ resetTrace: true });
});

document.addEventListener('miniupi:user-created', async (event) => {
  signInAs(event.detail.id);
  await loadUsers();
  await showWallet({ resetTrace: true });
});

wireWallet();
wireLedger();
window.addEventListener('hashchange', route);

if (await loadUsers()) {
  await showWallet({ resetTrace: true });
  await route();
}
