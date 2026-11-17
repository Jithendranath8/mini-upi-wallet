import { randomUUID } from 'node:crypto';
import { LedgerEntryType } from '../domain/enums';
import { LedgerEntry } from '../domain/LedgerEntry';
import type { Money } from '../domain/Money';
import type { Transaction } from '../domain/Transaction';
import type { SqlReader } from '../infrastructure/db/Database';
import { tracer } from '../infrastructure/observability/Tracer';
import type { LedgerRepository, WalletRepository } from '../repository/interfaces';
import { toLedgerEntryView, type LedgerEntryView } from '../readmodel/views';

/** One side of a posting. The amount is always the transaction amount. */
export interface LedgerLine {
  accountId: string;
  entryType: LedgerEntryType;
  balanceAfter: Money | null;
  description: string;
}

export interface LedgerVerification {
  healthy: boolean;
  entries: number;
  chainIntact: boolean;
  brokenAtSequence: number | null;
  unbalancedTransactions: string[];
  walletMismatches: Array<{ walletId: string; ledgerPaise: number; balancePaise: number }>;
}

/**
 * The immutable, double-entry ledger: the source of truth for "where did the money go".
 *
 *  - Append only. Corrections are new reversing entries, never edits.
 *  - Double entry. Every posting has equal debits and credits, so money is never created or lost.
 *  - Hash chained. Each entry commits to the one before it, making tampering evident.
 */
export class LedgerService {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly wallets: WalletRepository,
  ) {}

  /** Must be called inside the unit of work that moves the money, so both commit together. */
  record(transaction: Transaction, lines: LedgerLine[]): void {
    const debits = lines.filter((line) => line.entryType === LedgerEntryType.DEBIT).length;
    const credits = lines.length - debits;
    if (debits === 0 || debits !== credits) {
      throw new Error(`Unbalanced ledger posting for ${transaction.id}: ${debits} debit(s), ${credits} credit(s)`);
    }

    let prevHash = this.ledger.lastHash();
    const createdAt = new Date();
    for (const line of lines) {
      const id = `led_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const hash = LedgerEntry.computeHash({
        prevHash,
        id,
        transactionId: transaction.id,
        accountId: line.accountId,
        entryType: line.entryType,
        amountPaise: transaction.amount.paise,
        balanceAfterPaise: line.balanceAfter ? line.balanceAfter.paise : null,
        description: line.description,
        createdAt: createdAt.toISOString(),
      });
      this.ledger.append(
        new LedgerEntry({
          sequence: null,
          id,
          transactionId: transaction.id,
          accountId: line.accountId,
          entryType: line.entryType,
          amount: transaction.amount,
          balanceAfter: line.balanceAfter,
          description: line.description,
          prevHash,
          hash,
          createdAt,
        }),
      );
      prevHash = hash;
    }
    tracer.step('Ledger', `Appended ${lines.length} entries (debits = credits), chained to the previous hash`);
  }

  recent(reader: SqlReader, limit: number): LedgerEntryView[] {
    return this.ledger.findRecent(reader, limit).map(toLedgerEntryView);
  }

  forTransaction(reader: SqlReader, transactionId: string): LedgerEntryView[] {
    return this.ledger.findByTransaction(reader, transactionId).map(toLedgerEntryView);
  }

  /**
   * Full audit, always against the primary:
   *  1. the hash chain is unbroken,
   *  2. every transaction's debits equal its credits,
   *  3. every wallet balance equals the sum of its ledger entries.
   */
  verify(primary: SqlReader): LedgerVerification {
    const entries = this.ledger.findAllInOrder(primary);

    let expectedPrev = LedgerEntry.GENESIS_HASH;
    let brokenAtSequence: number | null = null;
    const netByTransaction = new Map<string, number>();
    const netByAccount = new Map<string, number>();

    for (const entry of entries) {
      if (brokenAtSequence === null && (entry.prevHash !== expectedPrev || entry.expectedHash() !== entry.hash)) {
        brokenAtSequence = entry.sequence;
      }
      expectedPrev = entry.hash;

      const signed = entry.entryType === LedgerEntryType.CREDIT ? entry.amount.paise : -entry.amount.paise;
      netByTransaction.set(entry.transactionId, (netByTransaction.get(entry.transactionId) ?? 0) + signed);
      netByAccount.set(entry.accountId, (netByAccount.get(entry.accountId) ?? 0) + signed);
    }

    const unbalancedTransactions = [...netByTransaction].filter(([, net]) => net !== 0).map(([id]) => id);
    const walletMismatches = this.wallets
      .findAll()
      .map((wallet) => ({
        walletId: wallet.id,
        ledgerPaise: netByAccount.get(`WALLET:${wallet.id}`) ?? 0,
        balancePaise: wallet.balance.paise,
      }))
      .filter((row) => row.ledgerPaise !== row.balancePaise);

    const chainIntact = brokenAtSequence === null;
    return {
      healthy: chainIntact && unbalancedTransactions.length === 0 && walletMismatches.length === 0,
      entries: entries.length,
      chainIntact,
      brokenAtSequence,
      unbalancedTransactions,
      walletMismatches,
    };
  }
}
