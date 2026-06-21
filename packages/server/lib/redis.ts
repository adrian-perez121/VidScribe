import { createClient, SCHEMA_FIELD_TYPE, SCHEMA_VECTOR_FIELD_ALGORITHM } from 'redis'

export const redis = createClient({ url: process.env.REDIS_URL! })
redis.on('error', (err) => console.error('Redis client error:', err))

let connected = false
export async function connectRedis() {
  if (!connected) {
    await redis.connect()
    connected = true
  }
}

const INDEX_NAME = 'idx:study'

/**
 * Drop the index AND every document it covers (DD = delete docs). Used for a
 * clean batch reindex so deleted/edited notes don't leave stale vectors behind.
 * No-op if the index doesn't exist yet.
 */
export async function dropIndex() {
  try {
    await redis.ft.dropIndex(INDEX_NAME, { DD: true })
    console.log('Dropped Redis index idx:study (and its docs)')
  } catch (err: unknown) {
    // Index doesn't exist yet — nothing to drop. Redis versions word this
    // differently ("Unknown index name" vs "Index not found").
    if (err instanceof Error && /unknown index name|index not found/i.test(err.message)) return
    throw err
  }
}

export async function ensureIndex() {
  try {
    await redis.ft.create(
      INDEX_NAME,
      {
        video_id: { type: SCHEMA_FIELD_TYPE.TAG },
        video_title: { type: SCHEMA_FIELD_TYPE.TEXT },
        source: { type: SCHEMA_FIELD_TYPE.TAG },
        text: { type: SCHEMA_FIELD_TYPE.TEXT },
        embedding: {
          type: SCHEMA_FIELD_TYPE.VECTOR,
          ALGORITHM: SCHEMA_VECTOR_FIELD_ALGORITHM.FLAT,
          TYPE: 'FLOAT32',
          DIM: 1536,
          DISTANCE_METRIC: 'COSINE',
        },
      },
      { ON: 'HASH', PREFIX: 'doc:' },
    )
    console.log('Created Redis index idx:study')
  } catch (err: unknown) {
    // Index already exists — that's fine
    if (err instanceof Error && /index already exists/i.test(err.message)) return
    throw err
  }
}
