import { ChaosController } from '../chaos/ChaosController';
import { tracer } from '../observability/Tracer';
import type { PrimaryDatabase, ReplicaDatabase, ReplicationCommit, SqlReader } from './Database';

/**
 * Asynchronous replication: commits leave the primary immediately and reach the replica
 * `replicaLagMs` later, strictly in order. This is what makes the replica eventually consistent.
 */
export class ReplicationStream {
  #pending: ReplicationCommit[] = [];
  #timer: NodeJS.Timeout | undefined;
  #resyncs = 0;

  constructor(
    private readonly primary: PrimaryDatabase,
    private readonly replica: ReplicaDatabase,
    private readonly chaos: ChaosController,
  ) {
    this.primary.onCommit((commit) => this.enqueue(commit));
    // A changed lag setting must take effect for commits that are already waiting.
    this.chaos.onChange(() => this.reschedule());
  }

  /** Applies everything that is waiting, right now. */
  flush(): void {
    this.cancelTimer();
    while (this.#pending.length > 0) this.applyHead();
  }

  /** Forgets waiting commits without applying them (used when both databases are rebuilt). */
  discardPending(): void {
    this.cancelTimer();
    this.#pending = [];
  }

  stats(): {
    primaryLsn: number;
    replicaLsn: number;
    pendingCommits: number;
    lagMs: number;
    configuredLagMs: number;
    resyncs: number;
  } {
    const oldest = this.#pending[0];
    return {
      primaryLsn: this.primary.lastLsn,
      replicaLsn: this.replica.appliedLsn,
      pendingCommits: this.#pending.length,
      lagMs: oldest ? Date.now() - oldest.committedAt : 0,
      configuredLagMs: this.chaos.state.replicaLagMs,
      resyncs: this.#resyncs,
    };
  }

  private enqueue(commit: ReplicationCommit): void {
    this.#pending.push(commit);
    this.schedule();
  }

  private schedule(): void {
    if (this.#timer || this.#pending.length === 0) return;
    const dueAt = this.#pending[0].committedAt + this.chaos.state.replicaLagMs;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.applyDue();
      this.schedule();
    }, Math.max(0, dueAt - Date.now()));
    this.#timer.unref();
  }

  private reschedule(): void {
    this.cancelTimer();
    this.schedule();
  }

  private applyDue(): void {
    const lag = this.chaos.state.replicaLagMs;
    const applied: ReplicationCommit[] = [];
    while (this.#pending.length > 0 && this.#pending[0].committedAt + lag <= Date.now()) {
      const commit = this.applyHead();
      if (commit) applied.push(commit);
    }
    this.traceApplied(applied);
  }

  private applyHead(): ReplicationCommit | undefined {
    const commit = this.#pending.shift()!;
    try {
      this.replica.apply(commit);
      return commit;
    } catch {
      // With statement-based replication a skipped commit means permanent divergence.
      // Never skip: throw the replica away and rebuild it from a snapshot of the primary,
      // which already contains everything that was still waiting to be shipped.
      this.#resyncs += 1;
      this.#pending = [];
      this.replica.bootstrapFrom(this.primary);
      tracer.step('Replica', `Could not apply LSN ${commit.lsn}: rebuilt from a primary snapshot`, 'warn', commit.trace);
      return undefined;
    }
  }

  /** One trace line per request for a batch of commits, instead of one line per commit. */
  private traceApplied(commits: ReplicationCommit[]): void {
    const byTrace = new Map<NonNullable<ReplicationCommit['trace']>, ReplicationCommit[]>();
    for (const commit of commits) {
      if (!commit.trace) continue;
      byTrace.set(commit.trace, [...(byTrace.get(commit.trace) ?? []), commit]);
    }
    for (const [trace, group] of byTrace) {
      const first = group[0];
      const last = group[group.length - 1];
      const range = first.lsn === last.lsn ? `LSN ${first.lsn}` : `LSN ${first.lsn} to ${last.lsn}`;
      const behind = Date.now() - first.committedAt;
      tracer.step('Replica', `Caught up: applied ${group.length} commit(s) (${range}), ${behind} ms after the primary`, 'ok', trace);
    }
  }

  private cancelTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * Decides which node serves a read.
 *
 * Default: the replica (keeps read load off the primary).
 * Read-your-writes: after a user writes, their reads are pinned to the primary until the
 * replica has applied that write's LSN, so a user never sees their own payment "disappear".
 */
export class ReadRouter {
  readonly #pinnedUntilLsn = new Map<string, number>();
  #toPrimary = 0;
  #toReplica = 0;

  constructor(
    private readonly primary: PrimaryDatabase,
    private readonly replica: ReplicaDatabase,
  ) {}

  /** Call after a commit made on behalf of `userId`. */
  recordWrite(userId: string): void {
    this.#pinnedUntilLsn.set(userId, this.primary.lastLsn);
  }

  route(userId?: string, options: { strong?: boolean } = {}): SqlReader {
    if (options.strong) {
      this.#toPrimary += 1;
      tracer.step('ReadRouter', 'Strong consistency requested: reading from the primary');
      return this.primary;
    }
    const pinnedLsn = userId ? this.#pinnedUntilLsn.get(userId) : undefined;
    if (pinnedLsn !== undefined) {
      if (this.replica.appliedLsn < pinnedLsn) {
        this.#toPrimary += 1;
        tracer.step(
          'ReadRouter',
          `Read-your-writes: replica is at LSN ${this.replica.appliedLsn}, user wrote LSN ${pinnedLsn}, reading from the primary`,
          'warn',
        );
        return this.primary;
      }
      this.#pinnedUntilLsn.delete(userId!);
    }
    this.#toReplica += 1;
    tracer.step('ReadRouter', `Reading from the replica (LSN ${this.replica.appliedLsn})`);
    return this.replica;
  }

  stats(): { toPrimary: number; toReplica: number; pinnedUsers: number } {
    return { toPrimary: this.#toPrimary, toReplica: this.#toReplica, pinnedUsers: this.#pinnedUntilLsn.size };
  }

  clear(): void {
    this.#pinnedUntilLsn.clear();
  }
}
