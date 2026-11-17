export interface AppSettings {
  port: number;
  /** Interface to listen on. Loopback by default so the demo is not reachable from the network. */
  host: string;
  /** Directory for the SQLite files, or ':memory:' for a throwaway database (tests). */
  dataDir: string;
  seedDemoData: boolean;

  upiHandle: string;
  defaultDailyLimitRupees: number;

  appNodeCount: number;

  /** Per signed-in user. */
  rateLimitCapacity: number;
  rateLimitRefillPerSecond: number;
  /** Per client address, applied before the caller is identified. */
  ipRateLimitCapacity: number;
  ipRateLimitRefillPerSecond: number;

  pinMaxAttempts: number;
  pinLockMs: number;

  /** How long a session token from POST /auth/login stays valid. */
  sessionTtlMs: number;
  /** Secret that signs session tokens. Empty: a random one per process. */
  sessionSecret: string;
  /**
   * Demo convenience: accept an `X-User-Id` header instead of a session token, so the UI can
   * switch between seeded users. Set to false and only `Authorization: Bearer` is accepted.
   */
  allowHeaderIdentity: boolean;
  /** When set, state-changing operator endpoints require it in `X-Operator-Key`. */
  operatorKey: string;
  /** Demo switch: wrap the wallet repository so "fail the next wallet credit" can be armed. */
  faultInjection: boolean;

  cacheTtlMs: number;
  cacheMaxEntries: number;

  lockTimeoutMs: number;

  idempotencyPollIntervalMs: number;
  idempotencyMaxPolls: number;
  idempotencyCacheTtlMs: number;

  replicaLagMs: number;

  queueMaxAttempts: number;
  queueBackoffBaseMs: number;
  queueConcurrency: number;

  breakerFailureThreshold: number;
  breakerOpenMs: number;

  gatewayLatencyMs: number;
  notificationLatencyMs: number;
  /** Simulated network round trip to the database inside the payment critical section. */
  databaseLatencyMs: number;

  fraudMaxTransfersPerMinute: number;
  fraudNewPayeeThresholdRupees: number;

  schedulerIntervalMs: number;
}

const DEFAULTS: AppSettings = {
  port: 3000,
  host: '127.0.0.1',
  dataDir: 'data',
  seedDemoData: true,

  upiHandle: 'miniupi',
  defaultDailyLimitRupees: 50_000,

  appNodeCount: 3,

  rateLimitCapacity: 30,
  rateLimitRefillPerSecond: 15,
  ipRateLimitCapacity: 300,
  ipRateLimitRefillPerSecond: 150,

  pinMaxAttempts: 5,
  pinLockMs: 60_000,

  sessionTtlMs: 30 * 60_000,
  sessionSecret: '',
  allowHeaderIdentity: true,
  operatorKey: '',
  faultInjection: true,

  cacheTtlMs: 30_000,
  cacheMaxEntries: 1_000,

  lockTimeoutMs: 5_000,

  idempotencyPollIntervalMs: 50,
  idempotencyMaxPolls: 100,
  idempotencyCacheTtlMs: 10 * 60_000,

  replicaLagMs: 400,

  queueMaxAttempts: 3,
  queueBackoffBaseMs: 250,
  queueConcurrency: 4,

  breakerFailureThreshold: 3,
  breakerOpenMs: 8_000,

  gatewayLatencyMs: 250,
  notificationLatencyMs: 60,
  databaseLatencyMs: 5,

  fraudMaxTransfersPerMinute: 6,
  fraudNewPayeeThresholdRupees: 10_000,

  schedulerIntervalMs: 1_000,
};

/**
 * PATTERN: Singleton.
 *
 * Process-wide configuration is read from the environment exactly once. The instance is only
 * fetched at the composition root (main.ts) and then passed down by constructor injection, so
 * no class reads configuration from global state and tests can supply their own via `with()`.
 */
export class AppConfig {
  static #instance: AppConfig | undefined;

  private constructor(readonly settings: Readonly<AppSettings>) {}

  static getInstance(): AppConfig {
    if (!AppConfig.#instance) {
      AppConfig.#instance = new AppConfig(Object.freeze({ ...DEFAULTS, ...AppConfig.fromEnvironment() }));
    }
    return AppConfig.#instance;
  }

  /** A standalone configuration for tests; does not touch the singleton. */
  static with(overrides: Partial<AppSettings>): AppConfig {
    return new AppConfig(Object.freeze({ ...DEFAULTS, ...overrides }));
  }

  private static fromEnvironment(): Partial<AppSettings> {
    const env = process.env;
    const overrides: Partial<AppSettings> = {};
    if (env.PORT) overrides.port = Number(env.PORT);
    if (env.HOST) overrides.host = env.HOST;
    if (env.SESSION_SECRET) overrides.sessionSecret = env.SESSION_SECRET;
    if (env.ALLOW_HEADER_IDENTITY) overrides.allowHeaderIdentity = env.ALLOW_HEADER_IDENTITY !== 'false';
    if (env.OPERATOR_KEY) overrides.operatorKey = env.OPERATOR_KEY;
    if (env.FAULT_INJECTION) overrides.faultInjection = env.FAULT_INJECTION !== 'false';
    if (env.DATA_DIR) overrides.dataDir = env.DATA_DIR;
    if (env.SEED_DEMO_DATA) overrides.seedDemoData = env.SEED_DEMO_DATA !== 'false';
    if (env.REPLICA_LAG_MS) overrides.replicaLagMs = Number(env.REPLICA_LAG_MS);
    if (env.APP_NODE_COUNT) overrides.appNodeCount = Number(env.APP_NODE_COUNT);
    return overrides;
  }
}
