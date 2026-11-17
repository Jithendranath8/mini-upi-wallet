import { createHash } from 'node:crypto';
import { LedgerEntryType } from './enums';
import { Money } from './Money';

export interface LedgerEntryProps {
  /** Position in the ledger. Assigned by the database; null until the entry is stored. */
  sequence: number | null;
  id: string;
  transactionId: string;
  accountId: string;
  entryType: LedgerEntryType;
  amount: Money;
  /** Wallet balance right after this entry. Null for external accounts we do not hold. */
  balanceAfter: Money | null;
  description: string;
  prevHash: string;
  hash: string;
  createdAt: Date;
}

/**
 * One line of the double-entry ledger. Immutable by construction (all fields readonly, the
 * object is frozen) and by storage (the table rejects UPDATE and DELETE).
 *
 * Each entry stores the hash of the entry before it, so rewriting history anywhere breaks
 * the chain from that point on and is detectable.
 */
export class LedgerEntry {
  static readonly GENESIS_HASH = '0'.repeat(64);

  readonly sequence: number | null;
  readonly id: string;
  readonly transactionId: string;
  readonly accountId: string;
  readonly entryType: LedgerEntryType;
  readonly amount: Money;
  readonly balanceAfter: Money | null;
  readonly description: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly createdAt: Date;

  constructor(props: LedgerEntryProps) {
    this.sequence = props.sequence;
    this.id = props.id;
    this.transactionId = props.transactionId;
    this.accountId = props.accountId;
    this.entryType = props.entryType;
    this.amount = props.amount;
    this.balanceAfter = props.balanceAfter;
    this.description = props.description;
    this.prevHash = props.prevHash;
    this.hash = props.hash;
    this.createdAt = props.createdAt;
    Object.freeze(this);
  }

  static computeHash(fields: {
    prevHash: string;
    id: string;
    transactionId: string;
    accountId: string;
    entryType: LedgerEntryType;
    amountPaise: number;
    balanceAfterPaise?: number | null;
    description?: string;
    createdAt: string;
  }): string {
    // Every stored field is part of the hash, so no column can be altered unnoticed.
    const material = JSON.stringify([
      fields.prevHash,
      fields.id,
      fields.transactionId,
      fields.accountId,
      fields.entryType,
      fields.amountPaise,
      fields.balanceAfterPaise ?? null,
      fields.description ?? '',
      fields.createdAt,
    ]);
    return createHash('sha256').update(material).digest('hex');
  }

  /** Recomputes this entry's hash from its own contents. */
  expectedHash(): string {
    return LedgerEntry.computeHash({
      prevHash: this.prevHash,
      id: this.id,
      transactionId: this.transactionId,
      accountId: this.accountId,
      entryType: this.entryType,
      amountPaise: this.amount.paise,
      balanceAfterPaise: this.balanceAfter ? this.balanceAfter.paise : null,
      description: this.description,
      createdAt: this.createdAt.toISOString(),
    });
  }
}
