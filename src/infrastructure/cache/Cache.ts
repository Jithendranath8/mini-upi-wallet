export interface CacheStats {
  hits: number;
  misses: number;
  hitRatio: number;
  sets: number;
  invalidations: number;
  evictions: number;
  size: number;
}

/**
 * Port for a key-value cache. The in-memory implementation below is the prototype's
 * stand-in for Redis; a Redis adapter would implement this same interface.
 */
export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
  stats(): CacheStats;
}

interface Entry {
  /** Values are stored serialised, exactly as a remote cache would hold them. */
  json: string;
  expiresAt: number;
}

/** LRU cache with per-entry TTL. A Map keeps insertion order, which doubles as recency order. */
export class InMemoryCache implements Cache {
  readonly #entries = new Map<string, Entry>();
  #hits = 0;
  #misses = 0;
  #sets = 0;
  #invalidations = 0;
  #evictions = 0;

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries: number,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.#entries.delete(key);
      this.#misses += 1;
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits += 1;
    return JSON.parse(entry.json) as T;
  }

  set<T>(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    this.#entries.delete(key);
    this.#entries.set(key, { json: JSON.stringify(value), expiresAt: Date.now() + ttlMs });
    this.#sets += 1;
    while (this.#entries.size > this.maxEntries) {
      const leastRecentlyUsed = this.#entries.keys().next().value;
      if (leastRecentlyUsed === undefined) break;
      this.#entries.delete(leastRecentlyUsed);
      this.#evictions += 1;
    }
  }

  delete(key: string): void {
    if (this.#entries.delete(key)) this.#invalidations += 1;
  }

  clear(): void {
    this.#entries.clear();
  }

  stats(): CacheStats {
    const lookups = this.#hits + this.#misses;
    return {
      hits: this.#hits,
      misses: this.#misses,
      hitRatio: lookups === 0 ? 0 : this.#hits / lookups,
      sets: this.#sets,
      invalidations: this.#invalidations,
      evictions: this.#evictions,
      size: this.#entries.size,
    };
  }
}
