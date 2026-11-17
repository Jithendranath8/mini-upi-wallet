import type { PaymentSource } from '../domain/PaymentSource';
import type { StateTransition, Transaction } from '../domain/Transaction';
import type { User } from '../domain/User';
import { MetricsRegistry } from '../infrastructure/observability/MetricsRegistry';
import { tracer } from '../infrastructure/observability/Tracer';

/** "This transaction just moved from one state to another." */
export interface TransactionEvent {
  transaction: Transaction;
  transition: StateTransition;
  sender: User;
  receiver: User;
  source: PaymentSource;
}

/**
 * PATTERN: Observer.
 *
 * TransferService announces state changes to the publisher and knows nothing about who is
 * listening. Notifications, metrics, tracing and the retry of stuck refunds are observers; a new
 * reaction (cashback, analytics, a webhook) is a new observer that subscribes at start-up.
 */
export interface TransactionObserver {
  readonly name: string;
  onTransactionEvent(event: TransactionEvent): void;
}

export class TransactionEventPublisher {
  readonly #observers: TransactionObserver[] = [];

  subscribe(observer: TransactionObserver): void {
    this.#observers.push(observer);
  }

  unsubscribe(observer: TransactionObserver): void {
    const index = this.#observers.indexOf(observer);
    if (index >= 0) this.#observers.splice(index, 1);
  }

  publish(event: TransactionEvent): void {
    for (const observer of this.#observers) {
      try {
        observer.onTransactionEvent(event);
      } catch (error) {
        // A broken observer must never fail or roll back a payment. Record it loudly and move on.
        const message = error instanceof Error ? error.message : String(error);
        tracer.step('Observer', `${observer.name} failed on ${event.transition.to}: ${message}`, 'error');
        console.error(`[observer:${observer.name}]`, error);
      }
    }
  }

  observerNames(): string[] {
    return this.#observers.map((observer) => observer.name);
  }
}

/** Shows every state change on the request trace (the "State" stops in the UI). */
export class LifecycleTraceObserver implements TransactionObserver {
  readonly name = 'LifecycleTrace';

  onTransactionEvent({ transition }: TransactionEvent): void {
    tracer.step('State', `${transition.from ?? 'NEW'} -> ${transition.to}: ${transition.detail}`);
  }
}

/** Counts transactions by outcome. */
export class MetricsObserver implements TransactionObserver {
  readonly name = 'Metrics';

  constructor(private readonly metrics: MetricsRegistry) {}

  onTransactionEvent({ transition, transaction }: TransactionEvent): void {
    this.metrics.increment(`transactions.${transition.to.toLowerCase()}`);
    if (transition.to === 'SUCCESS') this.metrics.increment('money.moved_paise', transaction.amount.paise);
  }
}
