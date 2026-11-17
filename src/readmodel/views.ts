import type { PaymentSource } from '../domain/PaymentSource';
import type { Transaction } from '../domain/Transaction';
import type { User } from '../domain/User';
import type { Wallet } from '../domain/Wallet';
import type { LedgerEntry } from '../domain/LedgerEntry';
import type { Notification } from '../domain/Notification';
import type { ScheduledPayment } from '../domain/ScheduledPayment';

/**
 * Response shapes (DTOs). Domain objects never leave the service layer: they are mapped to
 * these plain structures, so the API contract can stay stable while the domain evolves and
 * secrets such as the PIN hash cannot leak by accident.
 */

export interface PartyView {
  id: string;
  name: string;
  upiId: string;
}

export interface SourceView {
  id: string;
  type: string;
  label: string;
  isExternal: boolean;
  perTransactionLimit: number;
}

export interface TransactionView {
  id: string;
  type: string;
  status: string;
  /** Rupees, for display. */
  amount: number;
  amountPaise: number;
  sender: PartyView;
  receiver: PartyView;
  source: { id: string; type: string; label: string };
  note: string;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserView extends PartyView {
  phone: string;
  email: string | null;
  status: string;
  dailyLimit: number;
  notificationChannels: string[];
  blacklisted: boolean;
}

export interface WalletView {
  id: string;
  userId: string;
  balance: number;
  balancePaise: number;
  status: string;
  version: number;
  updatedAt: string;
}

export interface LedgerEntryView {
  sequence: number | null;
  id: string;
  transactionId: string;
  accountId: string;
  entryType: string;
  amount: number;
  balanceAfter: number | null;
  description: string;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface NotificationView {
  id: string;
  transactionId: string;
  channel: string;
  title: string;
  body: string;
  status: string;
  attempts: number;
  createdAt: string;
}

export interface ScheduledPaymentView {
  id: string;
  receiverUpiId: string;
  amount: number;
  note: string;
  executeAt: string;
  status: string;
  transactionId: string | null;
  failureReason: string | null;
}

export function toPartyView(user: User): PartyView {
  return { id: user.id, name: user.name, upiId: user.upiId };
}

export function toUserView(user: User): UserView {
  return {
    ...toPartyView(user),
    phone: user.phone,
    email: user.email,
    status: user.status,
    dailyLimit: user.dailyLimit.toRupees(),
    notificationChannels: [...user.notificationChannels],
    blacklisted: user.blacklisted,
  };
}

export function toSourceView(source: PaymentSource): SourceView {
  return {
    id: source.id,
    type: source.type,
    label: source.describe(),
    isExternal: source.isExternal(),
    perTransactionLimit: source.perTransactionLimit().toRupees(),
  };
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    userId: wallet.userId,
    balance: wallet.balance.toRupees(),
    balancePaise: wallet.balance.paise,
    status: wallet.status,
    version: wallet.version,
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toTransactionView(
  txn: Transaction,
  sender: PartyView,
  receiver: PartyView,
  source: PaymentSource,
): TransactionView {
  return {
    id: txn.id,
    type: txn.type,
    status: txn.status,
    amount: txn.amount.toRupees(),
    amountPaise: txn.amount.paise,
    sender,
    receiver,
    source: { id: source.id, type: source.type, label: source.describe() },
    note: txn.note,
    failureCode: txn.failureCode,
    failureReason: txn.failureReason,
    createdAt: txn.createdAt.toISOString(),
    updatedAt: txn.updatedAt.toISOString(),
  };
}

export function toLedgerEntryView(entry: LedgerEntry): LedgerEntryView {
  return {
    sequence: entry.sequence,
    id: entry.id,
    transactionId: entry.transactionId,
    accountId: entry.accountId,
    entryType: entry.entryType,
    amount: entry.amount.toRupees(),
    balanceAfter: entry.balanceAfter ? entry.balanceAfter.toRupees() : null,
    description: entry.description,
    prevHash: entry.prevHash,
    hash: entry.hash,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toNotificationView(n: Notification): NotificationView {
  return {
    id: n.id,
    transactionId: n.transactionId,
    channel: n.channel,
    title: n.title,
    body: n.body,
    status: n.status,
    attempts: n.attempts,
    createdAt: n.createdAt.toISOString(),
  };
}

export function toScheduledPaymentView(s: ScheduledPayment): ScheduledPaymentView {
  return {
    id: s.id,
    receiverUpiId: s.receiverUpiId,
    amount: s.amount.toRupees(),
    note: s.note,
    executeAt: s.executeAt.toISOString(),
    status: s.status,
    transactionId: s.transactionId,
    failureReason: s.failureReason,
  };
}

const GENERIC_SOURCE_LABEL: Record<string, string> = {
  WALLET: 'Wallet',
  BANK_ACCOUNT: 'Bank account',
  CARD: 'Card',
};

/**
 * What a transaction looks like to `viewerId`. Only the payer may see which of their accounts
 * funded a payment; the receiver learns the kind of source and nothing else.
 */
export function redactFor(view: TransactionView, viewerId: string): TransactionView {
  if (view.sender.id === viewerId) return view;
  return {
    ...view,
    source: { id: '', type: view.source.type, label: GENERIC_SOURCE_LABEL[view.source.type] ?? 'Payment source' },
  };
}

/**
 * Ledger lines as `viewerId` may see them: their own wallet lines in full, the other side
 * without its account id or running balance (which would reveal the other person's balance).
 */
export function redactLedgerFor(
  entries: LedgerEntryView[],
  ownAccountIds: ReadonlySet<string>,
): LedgerEntryView[] {
  return entries.map((entry) =>
    ownAccountIds.has(entry.accountId)
      ? entry
      : {
          ...entry,
          accountId: entry.accountId.startsWith('WALLET:') ? 'WALLET:(other party)' : 'EXTERNAL:(other party)',
          balanceAfter: null,
          description: entry.entryType === 'DEBIT' ? 'Debited from the other party' : 'Credited to the other party',
        },
  );
}
