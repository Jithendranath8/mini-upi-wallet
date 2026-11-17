import { setTimeout as sleep } from 'node:timers/promises';
import { GatewayUnavailableError, NotFoundError, PaymentDeclinedError } from '../../domain/errors';
import { Money } from '../../domain/Money';
import type { GatewayFaults } from '../../infrastructure/chaos/ChaosController';
import { tracer } from '../../infrastructure/observability/Tracer';
import { CircuitBreaker, type CircuitBreakerStats } from '../../infrastructure/resilience/CircuitBreaker';

export interface ChargeRequest {
  /** Our transaction id. The gateway treats it as an idempotency key. */
  reference: string;
  sourceId: string;
  amount: Money;
}

export interface ChargeReceipt {
  reference: string;
  gatewayTransactionId: string;
}

/**
 * Port to an external money network (a bank's IMPS switch, a card network).
 * Both operations are idempotent on `reference`, so we can safely retry them.
 */
export interface PaymentGateway {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeReceipt>;
  refund(reference: string): Promise<void>;
  /**
   * "What happened to the charge with this reference?" The only safe way to resolve a call
   * whose outcome we never saw (a timeout, or a crash on our side).
   */
  statusOf(reference: string): Promise<ChargeStatus>;
}

export type ChargeStatus =
  | { state: 'NOT_FOUND' }
  | { state: 'CAPTURED' | 'REFUNDED'; gatewayTransactionId: string };

interface RecordedCharge {
  receipt: ChargeReceipt;
  sourceId: string;
  amount: Money;
  refunded: boolean;
}

/**
 * A stand-in for a real bank / card network. Holds a balance per linked account, takes time
 * to answer, and can be made flaky or taken down through the ChaosController.
 */
export class SimulatedGateway implements PaymentGateway {
  readonly #balances = new Map<string, Money>();
  readonly #charges = new Map<string, RecordedCharge>();
  readonly #refundsInFlight = new Map<string, Promise<void>>();
  #sequence = 0;

  constructor(
    readonly name: string,
    private readonly faults: () => GatewayFaults,
    private readonly openingBalance: Money,
  ) {}

  async charge(request: ChargeRequest): Promise<ChargeReceipt> {
    const earlier = this.#charges.get(request.reference);
    if (earlier) return earlier.receipt; // retry of a charge we already performed

    await this.simulateNetwork('charge');

    const balance = this.balanceOf(request.sourceId);
    if (request.amount.isGreaterThan(balance)) {
      throw new PaymentDeclinedError(this.name, 'insufficient funds in the linked account');
    }
    this.#balances.set(request.sourceId, balance.minus(request.amount));
    this.#sequence += 1;
    const receipt: ChargeReceipt = {
      reference: request.reference,
      gatewayTransactionId: `${this.name.replace(/\s+/g, '').toUpperCase()}-${String(this.#sequence).padStart(6, '0')}`,
    };
    this.#charges.set(request.reference, {
      receipt,
      sourceId: request.sourceId,
      amount: request.amount,
      refunded: false,
    });
    return receipt;
  }

  async refund(reference: string): Promise<void> {
    const charge = this.#charges.get(reference);
    if (!charge) throw new NotFoundError('CHARGE_NOT_FOUND', `${this.name} has no charge for ${reference}.`);
    if (charge.refunded) return; // already refunded: repeating is a no-op

    // Two callers refunding the same charge at once share ONE refund instead of both paying out.
    const inFlight = this.#refundsInFlight.get(reference);
    if (inFlight) return inFlight;

    const refund = (async () => {
      await this.simulateNetwork('refund');
      this.#balances.set(charge.sourceId, this.balanceOf(charge.sourceId).plus(charge.amount));
      charge.refunded = true;
    })().finally(() => this.#refundsInFlight.delete(reference));
    this.#refundsInFlight.set(reference, refund);
    return refund;
  }

  async statusOf(reference: string): Promise<ChargeStatus> {
    await this.simulateNetwork('status query');
    const charge = this.#charges.get(reference);
    if (!charge) return { state: 'NOT_FOUND' };
    return { state: charge.refunded ? 'REFUNDED' : 'CAPTURED', gatewayTransactionId: charge.receipt.gatewayTransactionId };
  }

  /**
   * Rebuilds the simulator's memory of past charges after a restart, from our own records.
   * (A real bank remembers on its own; the simulator lives in this process.)
   */
  restore(charges: Array<{ reference: string; sourceId: string; amount: Money; gatewayTransactionId: string; refunded: boolean }>): void {
    for (const charge of charges) {
      if (this.#charges.has(charge.reference)) continue;
      this.#sequence += 1;
      this.#charges.set(charge.reference, {
        receipt: { reference: charge.reference, gatewayTransactionId: charge.gatewayTransactionId },
        sourceId: charge.sourceId,
        amount: charge.amount,
        refunded: charge.refunded,
      });
      if (!charge.refunded) {
        const balance = this.balanceOf(charge.sourceId);
        this.#balances.set(charge.sourceId, balance.isAtLeast(charge.amount) ? balance.minus(charge.amount) : Money.zero());
      }
    }
  }

  balanceOf(sourceId: string): Money {
    return this.#balances.get(sourceId) ?? this.openingBalance;
  }

  reset(): void {
    this.#balances.clear();
    this.#charges.clear();
    this.#refundsInFlight.clear();
    this.#sequence = 0;
  }

  private async simulateNetwork(operation: string): Promise<void> {
    const { latencyMs, failureRate, down } = this.faults();
    if (latencyMs > 0) await sleep(latencyMs);
    if (down) throw new GatewayUnavailableError(this.name, `${operation} failed, network is down`);
    if (Math.random() < failureRate) throw new GatewayUnavailableError(this.name, `${operation} timed out`);
  }
}

/**
 * PATTERN: Decorator.
 *
 * Adds circuit-breaker protection to any PaymentGateway. Strategies depend on the
 * PaymentGateway interface and cannot tell (and do not care) whether they hold the raw
 * gateway or the protected one.
 */
export class CircuitBreakerGateway implements PaymentGateway {
  constructor(
    private readonly inner: PaymentGateway,
    private readonly breaker: CircuitBreaker,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  charge(request: ChargeRequest): Promise<ChargeReceipt> {
    return this.breaker.execute(() => this.inner.charge(request));
  }

  refund(reference: string): Promise<void> {
    return this.breaker.execute(() => this.inner.refund(reference));
  }

  statusOf(reference: string): Promise<ChargeStatus> {
    return this.breaker.execute(() => this.inner.statusOf(reference));
  }

  breakerStats(): CircuitBreakerStats {
    return this.breaker.stats();
  }

  resetBreaker(): void {
    this.breaker.reset();
    tracer.step('CircuitBreaker', `${this.name}: manually reset to CLOSED`);
  }
}
