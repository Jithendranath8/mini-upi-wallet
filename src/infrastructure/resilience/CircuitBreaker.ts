import { CircuitOpenError } from '../../domain/errors';
import { tracer } from '../observability/Tracer';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  timesOpened: number;
  callsRejected: number;
  retryInMs: number;
}

/**
 * Stops calling a dependency that keeps failing.
 *
 *   CLOSED     calls pass through; consecutive infrastructure failures are counted
 *   OPEN       calls fail instantly (no waiting on a dead dependency) until the cool-down ends
 *   HALF_OPEN  one trial call is let through: success closes the circuit, failure re-opens it
 */
export class CircuitBreaker {
  #state: CircuitState = 'CLOSED';
  #consecutiveFailures = 0;
  #openedAt = 0;
  #trialInFlight = false;
  #timesOpened = 0;
  #callsRejected = 0;
  /** Bumped on every state change. */
  #epoch = 0;

  constructor(
    readonly name: string,
    private readonly failureThreshold: number,
    private readonly openMs: number,
    /** Only failures of the dependency itself count; a business "no" must not trip the breaker. */
    private readonly countsAsFailure: (error: unknown) => boolean,
  ) {}

  async execute<T>(call: () => Promise<T>): Promise<T> {
    this.admit();
    // A slow call may finish after the breaker has changed state. Its outcome belongs to the
    // state it was admitted in and must not move the current one (e.g. close an OPEN circuit).
    const admittedIn = this.#epoch;
    try {
      const result = await call();
      if (admittedIn === this.#epoch) this.onSuccess();
      return result;
    } catch (error) {
      if (admittedIn === this.#epoch) {
        if (this.countsAsFailure(error)) this.onFailure();
        else this.onSuccess(); // the dependency answered, so it is healthy
      }
      throw error;
    }
  }

  stats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.currentState(),
      consecutiveFailures: this.#consecutiveFailures,
      failureThreshold: this.failureThreshold,
      timesOpened: this.#timesOpened,
      callsRejected: this.#callsRejected,
      retryInMs: this.#state === 'OPEN' ? Math.max(0, this.#openedAt + this.openMs - Date.now()) : 0,
    };
  }

  reset(): void {
    this.transitionTo('CLOSED');
    this.#consecutiveFailures = 0;
    this.#trialInFlight = false;
  }

  private transitionTo(state: CircuitState): void {
    if (state !== this.#state) this.#epoch += 1;
    this.#state = state;
  }

  /** OPEN turns into HALF_OPEN lazily, the first time anyone looks after the cool-down. */
  private currentState(): CircuitState {
    if (this.#state === 'OPEN' && Date.now() >= this.#openedAt + this.openMs) {
      this.transitionTo('HALF_OPEN');
      this.#trialInFlight = false;
      tracer.step('CircuitBreaker', `${this.name}: cool-down over, HALF_OPEN (one trial call allowed)`, 'warn');
    }
    return this.#state;
  }

  private admit(): void {
    const state = this.currentState();
    if (state === 'OPEN') {
      this.#callsRejected += 1;
      const retryIn = this.#openedAt + this.openMs - Date.now();
      tracer.step('CircuitBreaker', `${this.name}: OPEN, failing fast without calling the gateway`, 'error');
      throw new CircuitOpenError(this.name, retryIn);
    }
    if (state === 'HALF_OPEN') {
      if (this.#trialInFlight) {
        this.#callsRejected += 1;
        throw new CircuitOpenError(this.name, 1_000);
      }
      this.#trialInFlight = true;
      this.#epoch += 1; // only the trial call may decide what happens next
    }
  }

  private onSuccess(): void {
    if (this.#state === 'HALF_OPEN') {
      tracer.step('CircuitBreaker', `${this.name}: trial call succeeded, circuit CLOSED`, 'ok');
    }
    this.transitionTo('CLOSED');
    this.#consecutiveFailures = 0;
    this.#trialInFlight = false;
  }

  private onFailure(): void {
    this.#consecutiveFailures += 1;
    const trialFailed = this.#state === 'HALF_OPEN';
    if (trialFailed || this.#consecutiveFailures >= this.failureThreshold) {
      this.transitionTo('OPEN');
      this.#openedAt = Date.now();
      this.#trialInFlight = false;
      this.#timesOpened += 1;
      tracer.step(
        'CircuitBreaker',
        `${this.name}: ${trialFailed ? 'trial call failed' : `${this.#consecutiveFailures} failures in a row`}, circuit OPEN for ${this.openMs} ms`,
        'error',
      );
    } else {
      tracer.step(
        'CircuitBreaker',
        `${this.name}: failure ${this.#consecutiveFailures} of ${this.failureThreshold} before opening`,
        'warn',
      );
    }
  }
}
