import type { Wallet } from '../domain/Wallet';
import { tracer } from '../infrastructure/observability/Tracer';
import type { PaymentContext, PaymentStrategy } from '../payment/PaymentStrategy';

/** What every validation step can look at. */
export interface ValidationContext extends PaymentContext {
  /** Read fresh from the primary while the sender's lock is held. */
  senderWallet: Wallet;
  strategy: PaymentStrategy;
  now: Date;
}

/**
 * PATTERN: Chain of Responsibility (with a Template Method inside).
 *
 * Each handler performs exactly one check and then passes the request to the next handler.
 * `handle()` is the fixed template (run my check, trace it, call the next link); subclasses
 * only supply `check()`. A failing check throws a DomainError, which stops the chain.
 *
 * Adding a rule = one new subclass + one line where the chain is assembled.
 */
export abstract class ValidationHandler {
  #next: ValidationHandler | undefined;

  abstract readonly name: string;

  /** Links the next handler and returns it, so calls can be chained: a.setNext(b).setNext(c). */
  setNext(next: ValidationHandler): ValidationHandler {
    this.#next = next;
    return next;
  }

  handle(context: ValidationContext): void {
    try {
      this.check(context);
    } catch (error) {
      tracer.step('Validation', `${this.name}: rejected (${(error as Error).message})`, 'error');
      throw error;
    }
    tracer.step('Validation', `${this.name}: passed`, 'ok');
    this.#next?.handle(context);
  }

  protected abstract check(context: ValidationContext): void;
}

/** Assembles handlers into a chain, in the order given. */
export class ValidationPipeline {
  readonly #head: ValidationHandler | undefined;
  readonly #names: string[];

  constructor(handlers: ValidationHandler[]) {
    this.#head = handlers[0];
    this.#names = handlers.map((handler) => handler.name);
    for (let i = 0; i + 1 < handlers.length; i += 1) handlers[i].setNext(handlers[i + 1]);
  }

  validate(context: ValidationContext): void {
    this.#head?.handle(context);
  }

  steps(): string[] {
    return [...this.#names];
  }
}
