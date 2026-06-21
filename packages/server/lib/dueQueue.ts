import type { Flashcard } from '@vid-mark/shared'
import { redis, connectRedis } from './redis.js'
import { getFlashcardsCollection } from './mongo.js'

// Redis sorted-set index of flashcard due dates: member = card id, score = dueAt
// (epoch ms). "Due now" is a range query (score <= now) in O(log n), instead of
// scanning Mongo. Mongo stays the source of truth for card content + SM-2 state;
// this index is kept in sync on generate/review, with a rebuild for drift.
//
// A global queue holds every card; a per-video queue holds that video's cards so
// "due for this video" is just as cheap.

const GLOBAL_KEY = 'due:cards'
const videoKey = (videoId: string) => `due:cards:${videoId}`
const dueScore = (dueAtIso: string) => new Date(dueAtIso).getTime()

type Schedulable = Pick<Flashcard, 'id' | 'dueAt'> & { videoId?: string }

/** Add or re-score a card in the global (and per-video) queue. Best-effort. */
export async function dueQueueUpsert(card: Schedulable): Promise<void> {
  try {
    await connectRedis()
    const score = dueScore(card.dueAt)
    await redis.zAdd(GLOBAL_KEY, { score, value: card.id })
    if (card.videoId) await redis.zAdd(videoKey(card.videoId), { score, value: card.id })
  } catch (err) {
    console.error('dueQueueUpsert failed (ignored):', err)
  }
}

/** Remove cards from the queues (e.g. when a video's deck is regenerated). */
export async function dueQueueRemove(cards: Schedulable[]): Promise<void> {
  try {
    await connectRedis()
    if (!cards.length) return
    await redis.zRem(
      GLOBAL_KEY,
      cards.map((c) => c.id),
    )
    const byVideo = new Map<string, string[]>()
    for (const c of cards) {
      if (!c.videoId) continue
      const arr = byVideo.get(c.videoId) ?? []
      arr.push(c.id)
      byVideo.set(c.videoId, arr)
    }
    for (const [vid, ids] of byVideo) await redis.zRem(videoKey(vid), ids)
  } catch (err) {
    console.error('dueQueueRemove failed (ignored):', err)
  }
}

/** Ids of cards due at/before `now` (default: now), soonest first. */
export async function dueQueueDueIds(
  opts: { videoId?: string; limit?: number; now?: number } = {},
): Promise<string[]> {
  await connectRedis()
  const key = opts.videoId ? videoKey(opts.videoId) : GLOBAL_KEY
  const max = opts.now ?? Date.now()
  return redis.zRange(key, 0, max, {
    BY: 'SCORE',
    ...(opts.limit ? { LIMIT: { offset: 0, count: opts.limit } } : {}),
  })
}

/** Number of cards in the global queue (0 ⇒ needs a rebuild/backfill). */
export async function dueQueueSize(): Promise<number> {
  await connectRedis()
  return redis.zCard(GLOBAL_KEY)
}

/** Wipe and rebuild every queue from Mongo (one-time backfill / drift recovery). */
export async function dueQueueRebuild(): Promise<number> {
  await connectRedis()
  const keys: string[] = []
  for await (const entry of redis.scanIterator({ MATCH: 'due:cards*', COUNT: 200 })) {
    if (Array.isArray(entry)) keys.push(...entry)
    else keys.push(entry as string)
  }
  if (keys.length) await redis.del(keys)

  const cards = await (await getFlashcardsCollection()).find({}).toArray()
  for (const c of cards) await dueQueueUpsert({ id: c.id, videoId: c.videoId, dueAt: c.dueAt })
  return cards.length
}
