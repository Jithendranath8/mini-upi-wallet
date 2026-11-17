import { ValidationError } from '../../domain/errors';

export interface GatewayFaults {
  /** Simulated network + processing time of one call to the bank or card network. */
  latencyMs: number;
  /** Probability (0..1) that a call fails as if the network were unreachable. */
  failureRate: number;
  /** Hard outage: every call fails. */
  down: boolean;
}

export interface ChaosState {
  bank: GatewayFaults;
  card: GatewayFaults;
  /** How far the read replica trails the primary. */
  replicaLagMs: number;
  /** Simulated network round trip to the database while a payer's lock is held. */
  databaseLatencyMs: number;
  /** Probability (0..1) that delivering one notification fails. */
  notificationFailureRate: number;
  /** When armed, the next write that would increase a wallet balance fails once. */
  failNextCredit: boolean;
}

export type ChaosPatch = Partial<Omit<ChaosState, 'bank' | 'card'>> & {
  bank?: Partial<GatewayFaults>;
  card?: Partial<GatewayFaults>;
};

/**
 * Runtime fault injection. Lets the demo show how the system behaves when a dependency is
 * slow, flaky or down, without touching any business code: components read their fault
 * settings from here.
 */
export class ChaosController {
  #state: ChaosState;
  readonly #defaults: ChaosState;
  readonly #listeners: Array<(state: ChaosState) => void> = [];

  constructor(defaults: { gatewayLatencyMs: number; replicaLagMs: number; databaseLatencyMs?: number }) {
    this.#defaults = {
      bank: { latencyMs: defaults.gatewayLatencyMs, failureRate: 0, down: false },
      card: { latencyMs: defaults.gatewayLatencyMs, failureRate: 0, down: false },
      replicaLagMs: defaults.replicaLagMs,
      databaseLatencyMs: defaults.databaseLatencyMs ?? 0,
      notificationFailureRate: 0,
      failNextCredit: false,
    };
    this.#state = structuredClone(this.#defaults);
  }

  get state(): Readonly<ChaosState> {
    return this.#state;
  }

  gateway(name: 'bank' | 'card'): Readonly<GatewayFaults> {
    return this.#state[name];
  }

  update(patch: ChaosPatch): ChaosState {
    // Copy known fields only: the patch may come straight from an HTTP request body.
    const current = this.#state;
    const faults = (base: GatewayFaults, change: Partial<GatewayFaults> | undefined): GatewayFaults => {
      const c = typeof change === 'object' && change !== null ? change : {};
      return {
        latencyMs: c.latencyMs ?? base.latencyMs,
        failureRate: c.failureRate ?? base.failureRate,
        down: c.down ?? base.down,
      };
    };
    const next: ChaosState = {
      bank: faults(current.bank, patch.bank),
      card: faults(current.card, patch.card),
      replicaLagMs: patch.replicaLagMs ?? current.replicaLagMs,
      databaseLatencyMs: patch.databaseLatencyMs ?? current.databaseLatencyMs,
      notificationFailureRate: patch.notificationFailureRate ?? current.notificationFailureRate,
      failNextCredit: patch.failNextCredit ?? current.failNextCredit,
    };
    ChaosController.validate(next);
    this.#state = next;
    this.#listeners.forEach((listener) => listener(next));
    return next;
  }

  reset(): ChaosState {
    this.#state = structuredClone(this.#defaults);
    this.#listeners.forEach((listener) => listener(this.#state));
    return this.#state;
  }

  onChange(listener: (state: ChaosState) => void): void {
    this.#listeners.push(listener);
  }

  /** Returns true exactly once after `failNextCredit` was armed. */
  consumeCreditFailure(): boolean {
    if (!this.#state.failNextCredit) return false;
    this.#state = { ...this.#state, failNextCredit: false };
    return true;
  }

  private static validate(state: ChaosState): void {
    const rates = [state.bank.failureRate, state.card.failureRate, state.notificationFailureRate];
    const delays = [state.bank.latencyMs, state.card.latencyMs, state.replicaLagMs, state.databaseLatencyMs];
    const validRate = (r: unknown) => typeof r === 'number' && r >= 0 && r <= 1;
    const validDelay = (d: unknown) => typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= 60_000;
    if (!rates.every(validRate)) {
      throw new ValidationError('INVALID_CHAOS_SETTING', 'Failure rates must be numbers between 0 and 1.');
    }
    if (!delays.every(validDelay)) {
      throw new ValidationError('INVALID_CHAOS_SETTING', 'Delays must be between 0 and 60000 ms.');
    }
    if (typeof state.bank.down !== 'boolean' || typeof state.card.down !== 'boolean' || typeof state.failNextCredit !== 'boolean') {
      throw new ValidationError('INVALID_CHAOS_SETTING', 'Flags must be true or false.');
    }
  }
}
