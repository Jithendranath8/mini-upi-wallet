import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { NotFoundError } from '../src/domain/errors';
import { ChaosController } from '../src/infrastructure/chaos/ChaosController';
import { PrimaryDatabase, ReplicaDatabase } from '../src/infrastructure/db/Database';
import { ReadRouter, ReplicationStream } from '../src/infrastructure/db/Replication';
import {
  closeApp,
  createTestApp,
  eventually,
  fund,
  pay,
  primaryOf,
  registerUser,
  replicaOf,
} from './helpers';

const COUNT_USERS = 'SELECT COUNT(*) AS n FROM users';

function insertUser(primary: PrimaryDatabase, id: string): void {
  primary.run(
    `INSERT INTO users (id, name, upi_id, phone, pin_hash, pin_salt, status, daily_limit_paise, notification_channels, created_at)
     VALUES (?, ?, ?, ?, 'hash', 'salt', 'ACTIVE', 0, '[]', ?)`,
    id,
    `User ${id}`,
    `${id}@miniupi`,
    `phone-${id}`,
    new Date().toISOString(),
  );
}

/** node:sqlite returns rows without a prototype; copy them so they compare with object literals. */
const plain = (rows: unknown[]): unknown[] => rows.map((row) => ({ ...(row as object) }));

const usersOn = (node: PrimaryDatabase | ReplicaDatabase): number => node.get<{ n: number }>(COUNT_USERS)!.n;

// ---------------------------------------------------------------------------------------------
describe('PrimaryDatabase and ReplicationStream', () => {
  let primary: PrimaryDatabase;
  let replica: ReplicaDatabase;
  let chaos: ChaosController;
  let stream: ReplicationStream;

  const wire = (replicaLagMs: number) => {
    chaos = new ChaosController({ gatewayLatencyMs: 0, replicaLagMs });
    stream = new ReplicationStream(primary, replica, chaos);
  };

  beforeEach(() => {
    primary = new PrimaryDatabase(':memory:');
    replica = new ReplicaDatabase(':memory:');
  });

  afterEach(() => {
    stream?.discardPending();
    primary.close();
    replica.close();
  });

  test('the replica lags behind a commit and then catches up on its own', async () => {
    wire(40);
    const committedAt = Date.now();
    insertUser(primary, 'u1');

    assert.equal(usersOn(primary), 1);
    assert.equal(usersOn(replica), 0, 'the write is not on the replica yet');
    assert.equal(primary.lastLsn, 1);
    assert.equal(replica.appliedLsn, 0);
    const lagging = stream.stats();
    assert.equal(lagging.pendingCommits, 1);
    assert.equal(lagging.primaryLsn, 1);
    assert.equal(lagging.replicaLsn, 0);
    assert.equal(lagging.configuredLagMs, 40);

    await eventually(() => replica.appliedLsn === 1);
    assert.ok(Date.now() - committedAt >= 38, 'the commit was held back for the configured lag');
    assert.equal(usersOn(replica), 1);
    assert.equal(stream.stats().pendingCommits, 0);
    assert.equal(stream.stats().lagMs, 0);
  });

  test('flush applies everything that is waiting, in commit order', () => {
    wire(60_000);
    for (const id of ['u1', 'u2', 'u3', 'u4', 'u5']) insertUser(primary, id);
    assert.equal(usersOn(replica), 0);
    assert.equal(stream.stats().pendingCommits, 5);

    stream.flush();
    assert.equal(replica.appliedLsn, 5);
    assert.equal(stream.stats().pendingCommits, 0);
    assert.deepEqual(
      replica.all<{ id: string }>('SELECT id FROM users ORDER BY rowid').map((row) => row.id),
      ['u1', 'u2', 'u3', 'u4', 'u5'],
    );
    assert.deepEqual(replica.stats().appliedCommits, 5);
  });

  test('a lowered lag takes effect for commits that are already waiting', async () => {
    wire(60_000);
    insertUser(primary, 'u1');
    assert.equal(usersOn(replica), 0);
    chaos.update({ replicaLagMs: 0 });
    await eventually(() => usersOn(replica) === 1);
    assert.equal(stream.stats().configuredLagMs, 0);
  });

  test('discardPending forgets waiting commits without applying them', () => {
    wire(60_000);
    insertUser(primary, 'u1');
    stream.discardPending();
    stream.flush();
    assert.equal(usersOn(replica), 0);
    assert.equal(replica.appliedLsn, 0);
  });

  test('a unit of work is shipped as one commit; the replica sees all of it or none of it', () => {
    wire(60_000);
    const result = primary.runInTransaction(() => {
      insertUser(primary, 'u1');
      insertUser(primary, 'u2');
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.equal(primary.lastLsn, 1, 'two statements, one log sequence number');
    assert.equal(stream.stats().pendingCommits, 1);
    stream.flush();
    assert.equal(usersOn(replica), 2);
  });

  test('a unit of work that throws is rolled back and never reaches the replica', () => {
    wire(60_000);
    assert.throws(
      () =>
        primary.runInTransaction(() => {
          insertUser(primary, 'u1');
          throw new Error('abort');
        }),
      /abort/,
    );
    assert.equal(usersOn(primary), 0);
    assert.equal(primary.lastLsn, 0);
    assert.equal(primary.stats().rollbacks, 1);
    stream.flush();
    assert.equal(usersOn(replica), 0);

    // The connection is usable again afterwards.
    insertUser(primary, 'u2');
    assert.equal(usersOn(primary), 1);
  });

  test('a database constraint violation rolls the whole unit of work back', () => {
    wire(60_000);
    insertUser(primary, 'u1');
    assert.throws(() =>
      primary.runInTransaction(() => {
        insertUser(primary, 'u2');
        insertUser(primary, 'u1'); // duplicate primary key
      }),
    );
    assert.equal(usersOn(primary), 1);
    assert.equal(primary.lastLsn, 1);
  });

  test('nested units of work join the outer one', () => {
    wire(60_000);
    assert.throws(() =>
      primary.runInTransaction(() => {
        primary.runInTransaction(() => insertUser(primary, 'u1'));
        assert.equal(usersOn(primary), 1, 'visible inside the open transaction');
        throw new Error('outer fails after inner finished');
      }),
    );
    assert.equal(usersOn(primary), 0, 'the inner work was part of the outer transaction');

    primary.runInTransaction(() => {
      primary.runInTransaction(() => insertUser(primary, 'u2'));
      insertUser(primary, 'u3');
    });
    assert.equal(primary.lastLsn, 1);
  });

  test('async work is refused: a transaction must not stay open across an await', () => {
    wire(60_000);
    assert.throws(
      () =>
        primary.runInTransaction(async () => {
          insertUser(primary, 'u1');
        }),
      /must not span an await/,
    );
    assert.equal(usersOn(primary), 0);
  });

  test('the wallet CHECK constraint is the last line of defence against a negative balance', () => {
    wire(60_000);
    insertUser(primary, 'u1');
    assert.throws(
      () =>
        primary.run(
          `INSERT INTO wallets (id, user_id, balance_paise, version, status, updated_at) VALUES ('w1', 'u1', -1, 0, 'ACTIVE', 'now')`,
        ),
      /CHECK constraint failed/,
    );
  });

  test('a commit the replica cannot apply triggers a rebuild from the primary instead of being skipped', () => {
    wire(60_000);
    insertUser(primary, 'u1');
    stream.discardPending(); // the replica never hears about u1: it has diverged
    primary.run(
      `INSERT INTO wallets (id, user_id, balance_paise, version, status, updated_at) VALUES ('w1', 'u1', 500, 0, 'ACTIVE', 'now')`,
    );
    insertUser(primary, 'u2');
    assert.equal(stream.stats().resyncs, 0);

    stream.flush(); // the wallet insert violates the replica's foreign key (no user u1 there)

    assert.equal(stream.stats().resyncs, 1);
    assert.equal(stream.stats().pendingCommits, 0);
    assert.equal(usersOn(replica), 2, 'nothing was lost: the snapshot contains every commit');
    assert.deepEqual(plain(replica.all('SELECT id, balance_paise FROM wallets')), [{ id: 'w1', balance_paise: 500 }]);
    assert.equal(replica.appliedLsn, primary.lastLsn);

    insertUser(primary, 'u3');
    stream.flush();
    assert.equal(usersOn(replica), 3, 'replication carries on after the rebuild');
    assert.equal(stream.stats().resyncs, 1);
  });

  test('the ledger triggers refuse UPDATE, DELETE and INSERT OR REPLACE on both nodes', () => {
    wire(60_000);
    insertUser(primary, 'u1');
    primary.run(`INSERT INTO payment_sources (id, user_id, type, details, created_at) VALUES ('s1', 'u1', 'WALLET', '{}', 'now')`);
    primary.run(
      `INSERT INTO transactions (id, idempotency_key, type, sender_id, receiver_id, source_id, source_type, amount_paise, status, created_at, updated_at)
       VALUES ('t1', 'key-12345678', 'P2P', 'u1', 'u1', 's1', 'WALLET', 100, 'SUCCESS', 'now', 'now')`,
    );
    const insertEntry = `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount_paise, description, prev_hash, hash, created_at)
                         VALUES ('l1', 't1', 'WALLET:w1', 'DEBIT', 100, 'd', 'p', 'h', 'now')`;
    primary.run(insertEntry);

    assert.throws(() => primary.run(`UPDATE ledger_entries SET amount_paise = 1 WHERE id = 'l1'`), /append-only/);
    assert.throws(() => primary.run(`DELETE FROM ledger_entries WHERE id = 'l1'`), /append-only/);
    assert.throws(() => primary.run(insertEntry.replace('INSERT INTO', 'INSERT OR REPLACE INTO')), /append-only/);
    assert.deepEqual(plain(primary.all('SELECT id, amount_paise FROM ledger_entries')), [{ id: 'l1', amount_paise: 100 }]);

    stream.flush();
    assert.deepEqual(plain(replica.all('SELECT id, amount_paise FROM ledger_entries')), [{ id: 'l1', amount_paise: 100 }]);
    assert.equal(stream.stats().resyncs, 0, 'the refused statements were never shipped');
  });

  test('tables are STRICT: a value of the wrong type is refused instead of being stored as text', () => {
    wire(60_000);
    insertUser(primary, 'u1');
    assert.throws(() =>
      primary.run(
        `INSERT INTO wallets (id, user_id, balance_paise, version, status, updated_at) VALUES ('w1', 'u1', 'lots', 0, 'ACTIVE', 'now')`,
      ),
    );
    assert.deepEqual(primary.all('SELECT id FROM wallets'), []);
  });

  test('bootstrapFrom copies a snapshot of the primary and continues from its LSN', () => {
    wire(60_000);
    insertUser(primary, 'u1');
    insertUser(primary, 'u2');
    stream.discardPending();

    replica.bootstrapFrom(primary);
    assert.equal(usersOn(replica), 2);
    assert.equal(replica.appliedLsn, primary.lastLsn);

    insertUser(primary, 'u3');
    stream.flush();
    assert.equal(usersOn(replica), 3);
  });
});

// ---------------------------------------------------------------------------------------------
describe('ReadRouter', () => {
  let primary: PrimaryDatabase;
  let replica: ReplicaDatabase;
  let stream: ReplicationStream;
  let router: ReadRouter;

  beforeEach(() => {
    primary = new PrimaryDatabase(':memory:');
    replica = new ReplicaDatabase(':memory:');
    stream = new ReplicationStream(primary, replica, new ChaosController({ gatewayLatencyMs: 0, replicaLagMs: 60_000 }));
    router = new ReadRouter(primary, replica);
  });

  afterEach(() => {
    stream.discardPending();
    primary.close();
    replica.close();
  });

  test('reads go to the replica by default', () => {
    assert.equal(router.route().role, 'replica');
    assert.equal(router.route('usr_1').role, 'replica');
    assert.deepEqual(router.stats(), { toPrimary: 0, toReplica: 2, pinnedUsers: 0 });
  });

  test('the strong option always reads from the primary', () => {
    assert.equal(router.route(undefined, { strong: true }).role, 'primary');
    assert.equal(router.route('usr_1', { strong: true }).role, 'primary');
    assert.equal(router.route('usr_1', { strong: false }).role, 'replica');
    assert.deepEqual(router.stats(), { toPrimary: 2, toReplica: 1, pinnedUsers: 0 });
  });

  test('read-your-writes: the writer is pinned to the primary until the replica has their write', () => {
    insertUser(primary, 'u1');
    router.recordWrite('usr_writer');

    assert.equal(router.route('usr_writer').role, 'primary');
    assert.equal(router.route('usr_writer').role, 'primary', 'still pinned on the next read');
    assert.equal(router.route('usr_other').role, 'replica', 'other users are not pinned');
    assert.equal(router.route().role, 'replica');
    assert.equal(router.stats().pinnedUsers, 1);

    stream.flush();
    assert.equal(router.route('usr_writer').role, 'replica', 'the replica caught up');
    assert.equal(router.stats().pinnedUsers, 0, 'the pin is dropped once it is no longer needed');
  });

  test('the pin tracks the LSN of the write, not later unrelated commits', () => {
    insertUser(primary, 'u1');
    router.recordWrite('usr_writer'); // pinned until LSN 1
    stream.flush(); // replica at LSN 1
    insertUser(primary, 'u2'); // LSN 2, written by someone else, not replicated yet

    assert.equal(router.route('usr_writer').role, 'replica', "the writer's own commit is on the replica");
  });

  test('a write made while the replica is already up to date does not pin', () => {
    insertUser(primary, 'u1');
    stream.flush();
    router.recordWrite('usr_writer');
    assert.equal(router.route('usr_writer').role, 'replica');
  });

  test('clear removes every pin', () => {
    insertUser(primary, 'u1');
    router.recordWrite('usr_a');
    router.recordWrite('usr_b');
    assert.equal(router.stats().pinnedUsers, 2);
    router.clear();
    assert.equal(router.stats().pinnedUsers, 0);
    assert.equal(router.route('usr_a').role, 'replica');
  });
});

// ---------------------------------------------------------------------------------------------
describe('read replica in the running application', () => {
  let app: Application;

  before(async () => {
    // A lag far longer than the test: the replica only moves when settle() flushes it.
    app = await createTestApp({ replicaLagMs: 60_000 });
  });

  after(() => closeApp(app));

  test('the sender reads their own payment from the primary; everyone else sees the stale replica', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const { result } = await pay(app, alice, bob, 100);
    const transactionId = result.transaction.id;

    const own = app.queries.history(alice.id, 10);
    assert.equal(own.servedBy, 'primary');
    assert.ok(own.data.some((txn) => txn.id === transactionId && txn.status === 'SUCCESS'));

    const stale = app.queries.history(bob.id, 10);
    assert.equal(stale.servedBy, 'replica');
    assert.deepEqual(stale.data, [], 'the replica has not received the payment yet');

    const strong = app.queries.history(bob.id, 10, true);
    assert.equal(strong.servedBy, 'primary');
    assert.deepEqual(
      strong.data.map((txn) => txn.id),
      [transactionId],
    );
  });

  test('after settle() the replica has caught up and serves the same answer', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const { result } = await pay(app, alice, bob, 100);

    await app.settle();

    const fromReplica = app.queries.history(alice.id, 10);
    assert.equal(fromReplica.servedBy, 'replica', 'the read-your-writes pin is released');
    assert.deepEqual(fromReplica.data, app.queries.history(alice.id, 10, true).data);

    const bobsView = app.queries.history(bob.id, 10);
    assert.equal(bobsView.servedBy, 'replica');
    assert.deepEqual(
      bobsView.data.map((txn) => [txn.id, txn.status]),
      [[result.transaction.id, 'SUCCESS']],
    );
  });

  test('a lookup that misses on the replica falls back to the primary before saying "not found"', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const { result } = await pay(app, alice, bob, 100);

    const details = app.queries.details(result.transaction.id, bob.id);
    assert.equal(details.servedBy, 'primary');
    assert.equal(details.data.transaction.status, 'SUCCESS');
    assert.equal(details.data.timeline.length, 3);
    assert.equal(details.data.ledger.length, 2);

    assert.throws(() => app.queries.details('txn_does_not_exist', bob.id), NotFoundError);
  });

  test('once settled, the replica holds the same ledger, timeline and notifications as the primary', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 2_000);
    const paid = await pay(app, alice, bob, 250);
    await pay(app, alice, bob, 5_000); // fails: insufficient balance
    await app.refunds.refund(paid.result.transaction.id, bob); // the receiver gives the money back
    await app.settle();

    const primary = primaryOf(app);
    const replica = replicaOf(app);
    assert.deepEqual(app.ledger.recent(replica, 200), app.ledger.recent(primary, 200));
    assert.ok(app.ledger.recent(replica, 200).length >= 6);
    for (const user of [alice, bob]) {
      assert.deepEqual(app.notifications.listFor(replica, user.id, 50), app.notifications.listFor(primary, user.id, 50));
    }
    const fromReplica = app.queries.details(paid.result.transaction.id, bob.id);
    assert.equal(fromReplica.servedBy, 'replica');
    assert.deepEqual(fromReplica.data, app.queries.details(paid.result.transaction.id, bob.id, true).data);
    assert.equal(fromReplica.data.transaction.status, 'REFUNDED');

    for (const table of ['users', 'wallets', 'payment_sources', 'transactions', 'transaction_events', 'ledger_entries', 'idempotency_keys', 'notifications']) {
      assert.deepEqual(
        replica.all(`SELECT * FROM ${table} ORDER BY 1, 2`),
        primary.all(`SELECT * FROM ${table} ORDER BY 1, 2`),
        `table ${table} differs between primary and replica`,
      );
    }
  });

  test('the receiver who refunds a payment reads the refund from the primary at once', async () => {
    const alice = registerUser(app);
    const bob = registerUser(app);
    await fund(app, alice, 1_000);
    const { result } = await pay(app, alice, bob, 100);
    await app.settle();
    assert.equal(app.queries.history(bob.id, 10).servedBy, 'replica', 'bob has written nothing yet');

    await app.refunds.refund(result.transaction.id, bob);

    const own = app.queries.history(bob.id, 10);
    assert.equal(own.servedBy, 'primary', 'read-your-writes applies to whoever asked for the refund');
    assert.equal(own.data[0].status, 'REFUNDED');
    await app.settle();
    const settled = app.queries.history(bob.id, 10);
    assert.equal(settled.servedBy, 'replica');
    assert.equal(settled.data[0].status, 'REFUNDED');
  });

  test('the operator snapshot reports replication progress', async () => {
    const alice = registerUser(app);
    await fund(app, alice, 100);
    const lagging = app.system.snapshot().database.replication;
    assert.ok(lagging.pendingCommits > 0);
    assert.ok(lagging.primaryLsn > lagging.replicaLsn);
    assert.equal(lagging.configuredLagMs, 60_000);

    await app.settle();
    const caughtUp = app.system.snapshot().database.replication;
    assert.equal(caughtUp.pendingCommits, 0);
    assert.equal(caughtUp.replicaLsn, caughtUp.primaryLsn);
  });
});
