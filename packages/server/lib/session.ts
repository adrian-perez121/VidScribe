import { redis, connectRedis } from './redis.js'

// Per-session chat memory in Redis. Each session is a list `sess:{id}` of JSON
// turns, newest-first (lPush). We cap the list (lTrim) and expire it so old
// sessions clean themselves up. POST /chat loads the last few turns to give
// Claude conversational context, then appends the new user + assistant turns.

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

const MAX_TURNS = 16 // keep at most this many messages per session
const TTL_SECONDS = 60 * 60 * 24 // sessions expire after 24h of inactivity

const key = (sessionId: string) => `sess:${sessionId}`

/**
 * Load the most recent turns in chronological order (oldest first), trimmed so
 * the sequence starts with a `user` turn (Anthropic requires the first message
 * to be from the user and roles to alternate).
 */
export async function loadHistory(sessionId: string, lastNMessages = 8): Promise<ChatTurn[]> {
  await connectRedis()
  const raw = await redis.lRange(key(sessionId), 0, lastNMessages - 1) // newest-first
  const turns = raw.map((s) => JSON.parse(s) as ChatTurn).reverse() // -> chronological
  while (turns.length && turns[0].role !== 'user') turns.shift()
  return turns
}

/** Append one turn (newest-first), then cap and refresh the TTL. */
export async function appendTurn(sessionId: string, turn: ChatTurn): Promise<void> {
  await connectRedis()
  const k = key(sessionId)
  await redis.lPush(k, JSON.stringify(turn))
  await redis.lTrim(k, 0, MAX_TURNS - 1)
  await redis.expire(k, TTL_SECONDS)
}
