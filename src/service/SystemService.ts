import type { TransactionEventPublisher } from '../events/TransactionEvents';
import type { Cache } from '../infrastructure/cache/Cache';
import type { ChaosController, ChaosPatch, ChaosState } from '../infrastructure/chaos/ChaosController';
import type { PrimaryDatabase, ReplicaDatabase } from '../infrastructure/db/Database';
import type { ReadRouter, ReplicationStream } from '../infrastructure/db/Replication';
import type { LoadBalancer } from '../infrastructure/loadbalancer/LoadBalancer';
import type { LockManager } from '../infrastructure/lock/LockManager';
import type { MetricsRegistry } from '../infrastructure/observability/MetricsRegistry';
import type { MessageQueue } from '../infrastructure/queue/MessageQueue';
import type { RateLimiter } from '../infrastructure/ratelimit/RateLimiter';
import { NOTIFICATIONS_TOPIC } from '../notification/NotificationService';
import { COMPENSATIONS_TOPIC } from './RefundService';
import type { CircuitBreakerGateway } from '../payment/gateway/PaymentGateway';
import type { PaymentStrategyFactory } from '../payment/PaymentStrategy';
import type { TransactionRepository } from '../repository/interfaces';
import type { FraudEngine } from '../validation/fraud';
import type { ValidationPipeline } from '../validation/ValidationHandler';
import type { IdempotencyService } from './IdempotencyService';

export interface SystemComponents {
  loadBalancer: LoadBalancer;
  rateLimiter: RateLimiter;
  addressRateLimiter: RateLimiter;
  cache: Cache;
  queue: MessageQueue;
  primary: PrimaryDatabase;
  replica: ReplicaDatabase;
  replication: ReplicationStream;
  readRouter: ReadRouter;
  locks: LockManager;
  idempotency: IdempotencyService;
  gateways: CircuitBreakerGateway[];
  chaos: ChaosController;
  metrics: MetricsRegistry;
  transactions: TransactionRepository;
  validation: ValidationPipeline;
  fraud: FraudEngine;
  strategies: PaymentStrategyFactory;
  events: TransactionEventPublisher;
}

/**
 * Operator view of the running system: one snapshot of every component's counters, plus the
 * fault-injection controls. This is what the "Live system" screen polls.
 */
export class SystemService {
  constructor(private readonly c: SystemComponents) {}

  snapshot() {
    return {
      loadBalancer: this.c.loadBalancer.stats(),
      rateLimiter: this.c.rateLimiter.stats(),
      addressRateLimiter: this.c.addressRateLimiter.stats(),
      cache: this.c.cache.stats(),
      queue: this.c.queue.stats(),
      deadLetters: this.c.queue.deadLetters(NOTIFICATIONS_TOPIC).length,
      /** Refunds of captured charges that exhausted their retries and need attention. */
      stuckCompensations: this.c.queue.deadLetters(COMPENSATIONS_TOPIC).length,
      database: {
        primary: this.c.primary.stats(),
        replica: this.c.replica.stats(),
        replication: this.c.replication.stats(),
        readRouting: this.c.readRouter.stats(),
      },
      locks: this.c.locks.stats(),
      idempotency: this.c.idempotency.stats(),
      circuitBreakers: this.c.gateways.map((gateway) => gateway.breakerStats()),
      transactions: this.c.transactions.countByStatus(),
      counters: this.c.metrics.snapshot(),
      chaos: this.c.chaos.state,
    };
  }

  /** What is plugged into each extension point right now. */
  design() {
    return {
      validationChain: this.c.validation.steps(),
      fraudRules: this.c.fraud.ruleNames(),
      paymentStrategies: this.c.strategies.supportedTypes(),
      observers: this.c.events.observerNames(),
    };
  }

  updateChaos(patch: ChaosPatch): ChaosState {
    return this.c.chaos.update(patch);
  }

  setNodeHealth(nodeId: string, healthy: boolean) {
    return this.c.loadBalancer.setHealth(nodeId, healthy);
  }

  resetBreakers(): void {
    this.c.gateways.forEach((gateway) => gateway.resetBreaker());
  }

  /** Puts every dead letter (notifications and stuck refunds) back on its queue. */
  redriveDeadLetters(): number {
    return this.c.queue.redrive(NOTIFICATIONS_TOPIC) + this.c.queue.redrive(COMPENSATIONS_TOPIC);
  }

  /**
   * Proves the ledger is append-only: tries to rewrite, delete and REPLACE the latest entry,
   * straight on the primary. All three must be refused by the database itself.
   */
  attemptLedgerTamper(): { update: TamperResult; delete: TamperResult; replace: TamperResult } {
    const attempt = (sql: string): TamperResult => {
      try {
        const { changes } = this.c.primary.run(sql);
        return { blocked: changes === 0, databaseSaid: changes === 0 ? 'no rows to change' : 'statement succeeded' };
      } catch (error) {
        return { blocked: true, databaseSaid: error instanceof Error ? error.message : String(error) };
      }
    };
    return {
      update: attempt(
        'UPDATE ledger_entries SET amount_paise = amount_paise + 100000 WHERE seq = (SELECT MAX(seq) FROM ledger_entries)',
      ),
      delete: attempt('DELETE FROM ledger_entries WHERE seq = (SELECT MAX(seq) FROM ledger_entries)'),
      // The sneaky one: REPLACE deletes and re-inserts the row, which plain triggers would miss.
      replace: attempt(
        `INSERT OR REPLACE INTO ledger_entries
           (seq, id, transaction_id, account_id, entry_type, amount_paise, balance_after_paise,
            description, prev_hash, hash, created_at)
         SELECT seq, id, transaction_id, account_id, entry_type, amount_paise + 100000, balance_after_paise,
                description, prev_hash, hash, created_at
           FROM ledger_entries ORDER BY seq DESC LIMIT 1`,
      ),
    };
  }
}

export interface TamperResult {
  blocked: boolean;
  databaseSaid: string;
}
