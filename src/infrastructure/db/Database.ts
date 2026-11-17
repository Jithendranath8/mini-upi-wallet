import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { RequestTrace, tracer } from '../observability/Tracer';
import { MIGRATIONS, TABLES_IN_DEPENDENCY_ORDER } from './schema';

export type SqlValue = string | number | null;

/** Read-only view of a database. Both the primary and the replica satisfy it. */
export interface SqlReader {
  readonly role: 'primary' | 'replica';
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
}

/** Read-write access. Only the primary satisfies it. */
export interface SqlWriter extends SqlReader {
  run(sql: string, ...params: SqlValue[]): { changes: number };
}

/** Atomic unit of work: everything inside commits together or not at all. */
export interface UnitOfWork {
  runInTransaction<T>(work: () => T): T;
}

export interface ReplicatedStatement {
  sql: string;
  params: SqlValue[];
}

/** One committed transaction, as shipped from the primary to the replica. */
export interface ReplicationCommit {
  /** Log sequence number: strictly increasing position in the primary's commit log. */
  lsn: number;
  statements: ReplicatedStatement[];
  committedAt: number;
  trace: RequestTrace | undefined;
}

/** Shared plumbing for a SQLite-backed node: connection, statement cache, read methods. */
abstract class SqliteNode implements SqlReader {
  abstract readonly role: 'primary' | 'replica';
  protected readonly db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  protected reads = 0;

  constructor(readonly location: string) {
    this.db = new DatabaseSync(location);
    if (location !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    // Without this, INSERT OR REPLACE would silently bypass the ledger's append-only triggers.
    this.db.exec('PRAGMA recursive_triggers = ON');
    // Another process holding the write lock makes us wait, not fail.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  /** Applies every migration newer than the version stored in the database file. */
  protected migrate(): void {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration ${migration.version} (${migration.description}) failed`, { cause: error });
      }
    }
  }

  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    this.reads += 1;
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    this.reads += 1;
    return this.prepare(sql).all(...params) as T[];
  }

  /** Drops every table and recreates the schema. Used by "reset demo data". */
  rebuild(): void {
    this.#statements.clear();
    this.db.exec('PRAGMA foreign_keys = OFF');
    for (const table of [...TABLES_IN_DEPENDENCY_ORDER].reverse()) {
      this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA user_version = 0');
    this.migrate();
  }

  close(): void {
    this.#statements.clear();
    this.db.close();
  }

  protected prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

/**
 * The primary: the only node that accepts writes. Every committed write is appended to a
 * replication log (statement-based replication) that the ReplicationStream ships to the replica.
 */
export class PrimaryDatabase extends SqliteNode implements SqlWriter, UnitOfWork {
  readonly role = 'primary';
  #inTransaction = false;
  #buffer: ReplicatedStatement[] = [];
  #lsn = 0;
  #writes = 0;
  #commits = 0;
  #rollbacks = 0;
  readonly #commitListeners: Array<(commit: ReplicationCommit) => void> = [];

  get lastLsn(): number {
    return this.#lsn;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.prepare(sql).run(...params);
    this.#writes += 1;
    const statement: ReplicatedStatement = { sql, params };
    if (this.#inTransaction) {
      this.#buffer.push(statement);
    } else {
      this.publish([statement]);
    }
    return { changes: Number(result.changes) };
  }

  /**
   * BEGIN IMMEDIATE takes the write lock up front, so two writers can never interleave.
   * `work` must be synchronous: a transaction never stays open across an await.
   * Calling this inside an open transaction joins it.
   */
  runInTransaction<T>(work: () => T): T {
    if (this.#inTransaction) return work();

    this.db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    this.#buffer = [];
    let result: T;
    try {
      result = work();
      if (result instanceof Promise) {
        throw new Error('runInTransaction received async work; a transaction must not span an await');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite already ended the transaction (disk full, I/O error). Nothing left to undo.
      } finally {
        this.#rollbacks += 1;
        this.#buffer = [];
        this.#inTransaction = false;
      }
      throw error; // always the original failure, never "cannot rollback"
    }
    const statements = this.#buffer;
    this.#buffer = [];
    this.#inTransaction = false;
    if (statements.length > 0) this.publish(statements);
    return result;
  }

  onCommit(listener: (commit: ReplicationCommit) => void): void {
    this.#commitListeners.push(listener);
  }

  stats(): { reads: number; writes: number; commits: number; rollbacks: number; lsn: number } {
    return { reads: this.reads, writes: this.#writes, commits: this.#commits, rollbacks: this.#rollbacks, lsn: this.#lsn };
  }

  private publish(statements: ReplicatedStatement[]): void {
    this.#lsn += 1;
    this.#commits += 1;
    const commit: ReplicationCommit = {
      lsn: this.#lsn,
      statements,
      committedAt: Date.now(),
      trace: tracer.current(),
    };
    this.#commitListeners.forEach((listener) => listener(commit));
  }
}

/** A read replica: serves reads only and applies the primary's commits in LSN order. */
export class ReplicaDatabase extends SqliteNode {
  readonly role = 'replica';
  #appliedLsn = 0;
  #appliedCommits = 0;

  get appliedLsn(): number {
    return this.#appliedLsn;
  }

  apply(commit: ReplicationCommit): void {
    this.db.exec('BEGIN');
    try {
      for (const { sql, params } of commit.statements) {
        this.prepare(sql).run(...params);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      tracer.step('Replica', `Failed to apply LSN ${commit.lsn}: ${(error as Error).message}`, 'error', commit.trace);
      throw error;
    }
    this.#appliedLsn = commit.lsn;
    this.#appliedCommits += 1;
  }

  /** Initial sync: copy a snapshot of the primary, then continue from its current LSN. */
  bootstrapFrom(primary: PrimaryDatabase): void {
    this.rebuild();
    this.db.exec('BEGIN');
    try {
      for (const table of TABLES_IN_DEPENDENCY_ORDER) {
        const rows = primary.all<Record<string, SqlValue>>(`SELECT * FROM ${table}`);
        for (const row of rows) {
          const columns = Object.keys(row);
          const placeholders = columns.map(() => '?').join(', ');
          this.db
            .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
            .run(...columns.map((column) => row[column]));
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.#appliedLsn = primary.lastLsn;
  }

  stats(): { reads: number; appliedLsn: number; appliedCommits: number } {
    return { reads: this.reads, appliedLsn: this.#appliedLsn, appliedCommits: this.#appliedCommits };
  }
}

/** Opens the primary and a fresh replica for the given data directory (or ':memory:'). */
export function openDatabases(dataDir: string): { primary: PrimaryDatabase; replica: ReplicaDatabase } {
  if (dataDir === ':memory:') {
    return { primary: new PrimaryDatabase(':memory:'), replica: new ReplicaDatabase(':memory:') };
  }
  mkdirSync(dataDir, { recursive: true });
  const replicaPath = join(dataDir, 'replica.db');
  // The replica is always rebuilt from a snapshot of the primary at start-up.
  for (const suffix of ['', '-wal', '-shm']) rmSync(replicaPath + suffix, { force: true });
  const primary = new PrimaryDatabase(join(dataDir, 'primary.db'));
  const replica = new ReplicaDatabase(replicaPath);
  replica.bootstrapFrom(primary);
  return { primary, replica };
}
