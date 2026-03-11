/**
 * Semantic Cache with LRU Eviction
 *
 * Uses embedding similarity (cosine similarity) instead of exact string matching
 * to detect similar queries and reuse cached results.
 *
 * Expected impact:
 * - 40-60% cache hit rate for similar queries
 * - 50% cost reduction (fewer API calls)
 * - 80%+ latency improvement on cache hits
 */

import { LRUCache } from 'lru-cache';
import computeSimilarity from '../utils/computeSimilarity';
import type { CacheConfig, CacheEntry, CacheStats, CacheType } from './types';

export class SemanticCache<T> {
  private cache: LRUCache<string, CacheEntry<T>>;
  private config: CacheConfig;
  private stats: CacheStats;
  private cacheType: CacheType;

  constructor(cacheType: CacheType, config: Partial<CacheConfig> = {}) {
    this.cacheType = cacheType;
    this.config = {
      max: config.max || 1000,
      ttl: config.ttl || this.getDefaultTTL(cacheType),
      similarityThreshold: config.similarityThreshold || 0.95,
    };

    this.cache = new LRUCache({
      max: this.config.max,
      ttl: this.config.ttl,
      updateAgeOnGet: true, // Reset TTL on cache hit
    });

    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      hitRate: 0,
    };
  }

  private getDefaultTTL(cacheType: CacheType): number {
    switch (cacheType) {
      case 'query':
        return 60 * 60 * 1000; // 1 hour for search results
      case 'response':
        return 24 * 60 * 60 * 1000; // 24 hours for LLM responses
      case 'embedding':
        return 7 * 24 * 60 * 60 * 1000; // 7 days for embeddings
      default:
        return 60 * 60 * 1000;
    }
  }

  /**
   * Get cached value by semantic similarity
   * @param key - Query text or input
   * @param embedding - Embedding vector for similarity search
   * @returns Cached value if similar entry found, null otherwise
   */
  get(key: string, embedding: number[]): T | null {
    // Try exact match first (fast path)
    const exactMatch = this.cache.get(key);
    if (exactMatch) {
      this.stats.hits++;
      this.updateStats();
      return exactMatch.value;
    }

    // Semantic search: find most similar cached entry
    let bestMatch: CacheEntry<T> | null = null;
    let bestSimilarity = 0;

    for (const [, entry] of this.cache.entries()) {
      const similarity = computeSimilarity(embedding, entry.embedding);
      if (
        similarity > this.config.similarityThreshold &&
        similarity > bestSimilarity
      ) {
        bestSimilarity = similarity;
        bestMatch = entry;
      }
    }

    if (bestMatch) {
      this.stats.hits++;
      this.updateStats();
      console.log(
        `[SemanticCache:${this.cacheType}] Hit! similarity=${bestSimilarity.toFixed(3)} key="${key.slice(0, 50)}..."`,
      );
      return bestMatch.value;
    }

    this.stats.misses++;
    this.updateStats();
    return null;
  }

  /**
   * Store value in cache with embedding
   * @param key - Query text or input
   * @param value - Value to cache
   * @param embedding - Embedding vector for similarity search
   */
  set(key: string, value: T, embedding: number[]): void {
    const entry: CacheEntry<T> = {
      value,
      embedding,
      key,
      timestamp: Date.now(),
    };

    this.cache.set(key, entry);
    this.stats.size = this.cache.size;
  }

  /**
   * Check if similar entry exists without retrieving it
   * @param key - Query text
   * @param embedding - Embedding vector
   * @returns true if cache hit, false otherwise
   */
  has(key: string, embedding: number[]): boolean {
    return this.get(key, embedding) !== null;
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      hitRate: 0,
    };
  }

  /**
   * Get current cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get current cache size
   */
  size(): number {
    return this.cache.size;
  }

  private updateStats(): void {
    this.stats.size = this.cache.size;
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}

// Global cache instances (singleton pattern)
let queryCache: SemanticCache<any> | null = null;
let responseCache: SemanticCache<any> | null = null;
let embeddingCache: SemanticCache<number[]> | null = null;

/**
 * Get or create query cache instance
 */
export const getQueryCache = <T>(): SemanticCache<T> => {
  if (!queryCache) {
    queryCache = new SemanticCache<T>('query', {
      max: 1000,
      ttl: 60 * 60 * 1000, // 1 hour
      similarityThreshold: 0.95,
    });
  }
  return queryCache as SemanticCache<T>;
};

/**
 * Get or create response cache instance
 */
export const getResponseCache = <T>(): SemanticCache<T> => {
  if (!responseCache) {
    responseCache = new SemanticCache<T>('response', {
      max: 500,
      ttl: 24 * 60 * 60 * 1000, // 24 hours
      similarityThreshold: 0.98, // Higher threshold for responses
    });
  }
  return responseCache as SemanticCache<T>;
};

/**
 * Get or create embedding cache instance
 */
export const getEmbeddingCache = (): SemanticCache<number[]> => {
  if (!embeddingCache) {
    embeddingCache = new SemanticCache<number[]>('embedding', {
      max: 2000,
      ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
      similarityThreshold: 0.99, // Very high threshold for embeddings
    });
  }
  return embeddingCache;
};

/**
 * Get aggregated stats from all caches
 */
export const getAllCacheStats = () => {
  return {
    query: queryCache?.getStats() || null,
    response: responseCache?.getStats() || null,
    embedding: embeddingCache?.getStats() || null,
  };
};
