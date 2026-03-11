/**
 * Cache configuration and types for semantic caching
 *
 * Semantic caching uses embedding similarity instead of exact string matching
 * to detect similar queries and reuse cached results.
 */

export interface CacheConfig {
  /** Maximum number of entries in the cache */
  max: number;
  /** Time-to-live in milliseconds */
  ttl: number;
  /** Cosine similarity threshold for cache hits (0-1) */
  similarityThreshold: number;
}

export interface CacheEntry<T> {
  /** Cached value */
  value: T;
  /** Embedding vector for similarity search */
  embedding: number[];
  /** Original key (query text) */
  key: string;
  /** Timestamp when cached */
  timestamp: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

export type CacheType = 'query' | 'response' | 'embedding';
