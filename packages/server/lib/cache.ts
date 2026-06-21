import { redis, connectRedis } from './redis.js'

// Small best-effort JSON cache on top of Redis. Every call is wrapped so a Redis
// hiccup never breaks the feature that's caching — a failed get/set just behaves
// like a miss / no-op. Values are stored as JSON strings with a TTL.

/** Read and parse a cached value, or null on miss / any error. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    await connectRedis()
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch (err) {
    console.error('cacheGet failed (treating as miss):', err)
    return null
  }
}

/** Store a value as JSON with a TTL (seconds). Best-effort. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await connectRedis()
    await redis.set(key, JSON.stringify(value), { EX: ttlSeconds })
  } catch (err) {
    console.error('cacheSet failed (ignored):', err)
  }
}

/** Delete every key matching a glob pattern (e.g. "cache:guide:*"). Best-effort. */
export async function cacheDeleteByPattern(pattern: string): Promise<number> {
  try {
    await connectRedis()
    const keys: string[] = []
    for await (const entry of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      if (Array.isArray(entry)) keys.push(...entry)
      else keys.push(entry as string)
    }
    if (keys.length) await redis.del(keys)
    return keys.length
  } catch (err) {
    console.error('cacheDeleteByPattern failed (ignored):', err)
    return 0
  }
}
