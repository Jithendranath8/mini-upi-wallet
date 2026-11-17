/**
 * Relational schema. Applied identically to the primary and to the read replica.
 * Money is INTEGER paise; timestamps are ISO-8601 TEXT (sortable as strings).
 */
export const TABLES_IN_DEPENDENCY_ORDER = [
  'users',
  'wallets',
  'payment_sources',
  'transactions',
  'transaction_events',
  'ledger_entries',
  'idempotency_keys',
  'notifications',
  'scheduled_payments',
] as const;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  upi_id                TEXT NOT NULL UNIQUE,
  phone                 TEXT NOT NULL UNIQUE,
  email                 TEXT,
  pin_hash              TEXT NOT NULL,
  pin_salt              TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ACTIVE','BLOCKED')),
  daily_limit_paise     INTEGER NOT NULL CHECK (daily_limit_paise >= 0),
  notification_channels TEXT NOT NULL,
  is_blacklisted        INTEGER NOT NULL DEFAULT 0 CHECK (is_blacklisted IN (0,1)),
  created_at            TEXT NOT NULL
) STRICT;

-- One wallet per user (UNIQUE user_id). The CHECK is the last line of defence against overdraft.
CREATE TABLE IF NOT EXISTS wallets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id),
  balance_paise INTEGER NOT NULL CHECK (balance_paise >= 0),
  version       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('ACTIVE','FROZEN')),
  updated_at    TEXT NOT NULL
) STRICT;

-- Single-table inheritance: 'type' is the discriminator, 'details' holds subclass attributes.
CREATE TABLE IF NOT EXISTS payment_sources (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL CHECK (type IN ('WALLET','BANK_ACCOUNT','CARD')),
  details    TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sources_user ON payment_sources(user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('P2P','TOPUP')),
  sender_id       TEXT NOT NULL REFERENCES users(id),
  receiver_id     TEXT NOT NULL REFERENCES users(id),
  source_id       TEXT NOT NULL REFERENCES payment_sources(id),
  source_type     TEXT NOT NULL CHECK (source_type IN ('WALLET','BANK_ACCOUNT','CARD')),
  amount_paise    INTEGER NOT NULL CHECK (amount_paise > 0),
  note            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('INITIATED','PROCESSING','SUCCESS','FAILED','REFUNDED')),
  failure_code    TEXT,
  failure_reason  TEXT,
  funds_captured  INTEGER NOT NULL DEFAULT 0 CHECK (funds_captured IN (0,1)),
  gateway_ref     TEXT,
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- Second line of defence for idempotency: one transaction per (sender, key), enforced by the DB.
  UNIQUE (sender_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_txn_sender_time   ON transactions(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_receiver_time ON transactions(receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_status        ON transactions(status);
-- "Has this payer ever paid this payee?" (fraud rule) without scanning every successful payment.
CREATE INDEX IF NOT EXISTS idx_txn_pair_success  ON transactions(sender_id, receiver_id) WHERE status = 'SUCCESS';

-- Audit trail of every state change.
CREATE TABLE IF NOT EXISTS transaction_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  detail         TEXT NOT NULL,
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_events_txn ON transaction_events(transaction_id, id);

-- Append-only double-entry ledger with a hash chain.
CREATE TABLE IF NOT EXISTS ledger_entries (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  transaction_id      TEXT NOT NULL REFERENCES transactions(id),
  account_id          TEXT NOT NULL,
  entry_type          TEXT NOT NULL CHECK (entry_type IN ('DEBIT','CREDIT')),
  amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
  balance_after_paise INTEGER,
  description         TEXT NOT NULL,
  prev_hash           TEXT NOT NULL,
  hash                TEXT NOT NULL,
  created_at          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_ledger_txn     ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, seq);

CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: DELETE is not allowed');
END;

-- The PRIMARY KEY is what makes concurrent retries safe: only one INSERT can win.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_body TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  PRIMARY KEY (user_id, idem_key)
) STRICT;

CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  transaction_id TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('SMS','PUSH','EMAIL')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('SENT','FAILED')),
  attempts       INTEGER NOT NULL,
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_payments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  receiver_upi_id TEXT NOT NULL,
  source_id       TEXT,
  amount_paise    INTEGER NOT NULL CHECK (amount_paise > 0),
  note            TEXT NOT NULL DEFAULT '',
  execute_at      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','EXECUTED','FAILED','CANCELLED')),
  transaction_id  TEXT,
  failure_reason  TEXT,
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_scheduled_due  ON scheduled_payments(status, execute_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_payments(user_id, execute_at DESC);
`;

/**
 * Schema migrations, applied in order. The database remembers the last version it applied
 * (PRAGMA user_version), so an existing database file is upgraded in place instead of being
 * recreated. A change to the schema is a NEW entry here, never an edit to an old one.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; description: string; sql: string }> = [
  { version: 1, description: 'Initial schema', sql: SCHEMA_SQL },
  {
    version: 2,
    description: 'Transactional outbox: remember which state-change events were published',
    sql: `
      ALTER TABLE transaction_events ADD COLUMN published_at TEXT;
      -- Events that existed before the outbox were already announced the old way.
      UPDATE transaction_events SET published_at = created_at;
      CREATE INDEX IF NOT EXISTS idx_events_unpublished
        ON transaction_events(transaction_id, id) WHERE published_at IS NULL;
    `,
  },
];
