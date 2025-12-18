// Simple in-memory cache for AI responses to reduce API costs
// Cache similar queries to avoid redundant API calls

interface CacheEntry {
    response: string;
    timestamp: number;
}

const cache: Map<string, CacheEntry> = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour cache
const MAX_CACHE_SIZE = 500; // Maximum entries

// Generate cache key from query (normalize to catch similar queries)
function generateCacheKey(query: string, context?: string): string {
    const normalized = query
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .substring(0, 200); // First 200 chars

    const contextHash = context ?
        context.substring(0, 100).replace(/\s+/g, ' ') : '';

    return `${normalized}|${contextHash}`;
}

// Get cached response if exists and not expired
export function getCached(query: string, context?: string): string | null {
    const key = generateCacheKey(query, context);
    const entry = cache.get(key);

    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > CACHE_TTL) {
        cache.delete(key);
        return null;
    }

    console.log('[Cache] HIT for query');
    return entry.response;
}

// Store response in cache
export function setCache(query: string, response: string, context?: string): void {
    // Evict old entries if cache is too large
    if (cache.size >= MAX_CACHE_SIZE) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
    }

    const key = generateCacheKey(query, context);
    cache.set(key, {
        response,
        timestamp: Date.now()
    });

    console.log(`[Cache] Stored response (${cache.size} entries)`);
}

// Clear entire cache
export function clearCache(): void {
    cache.clear();
    console.log('[Cache] Cleared');
}

// Get cache stats
export function getCacheStats(): { size: number; maxSize: number; ttlMinutes: number } {
    return {
        size: cache.size,
        maxSize: MAX_CACHE_SIZE,
        ttlMinutes: CACHE_TTL / 60000
    };
}
