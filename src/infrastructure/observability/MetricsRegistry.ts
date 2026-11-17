/**
 * PATTERN: Singleton. One process-wide set of named counters, the in-process stand-in for a
 * Prometheus/StatsD client.
 */
export class MetricsRegistry {
  static #instance: MetricsRegistry | undefined;
  readonly #counters = new Map<string, number>();

  private constructor() {}

  static getInstance(): MetricsRegistry {
    return (MetricsRegistry.#instance ??= new MetricsRegistry());
  }

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.#counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  reset(): void {
    this.#counters.clear();
  }
}
