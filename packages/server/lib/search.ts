import OpenAI from 'openai'
import { redis, connectRedis } from './redis.js'

// Retrieval helper: embed a question and KNN-search the Redis vector index
// (idx:study) for the closest note / research / lens chunks. Pure retrieval —
// no LLM, no conversation. Returns the matches with their source video metadata
// so callers (e.g. POST /chat) can both ground an answer and report sources.

// Lazily created so importing this module doesn't require OPENAI_API_KEY to be
// loaded yet (e.g. in scripts that set up dotenv after imports).
let _openai: OpenAI | null = null
function openaiClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
  return _openai
}

export interface SearchResult {
  video_id: string
  video_title: string
  /** 'note' | 'browserbase' | 'lens' | 'transcript' */
  source: string
  text: string
  /** Point in the video this chunk maps to, in seconds; -1 when none. */
  startSec: number
  /** Cosine distance — LOWER is closer/more relevant. */
  score: number
}

export interface SearchOpts {
  /** Restrict to a single video. */
  videoId?: string
  /** Restrict to one source type ('note' | 'browserbase' | 'lens'). */
  source?: string
}

async function embed(text: string): Promise<number[]> {
  const r = await openaiClient().embeddings.create({ model: 'text-embedding-3-small', input: text })
  return r.data[0].embedding
}

/** Escape RediSearch TAG special characters so exact-match filters are literal. */
function escapeTag(value: string): string {
  return value.replace(/[\s,.<>{}[\]"':;!@#$%^&*()\-+=~|/\\]/g, '\\$&')
}

export async function search(
  question: string,
  topK = 5,
  opts: SearchOpts = {},
): Promise<SearchResult[]> {
  await connectRedis()

  const qbuf = Buffer.from(new Float32Array(await embed(question)).buffer)

  // Optional TAG pre-filter applied before the KNN step.
  const filters: string[] = []
  if (opts.videoId) filters.push(`@video_id:{${escapeTag(opts.videoId)}}`)
  if (opts.source) filters.push(`@source:{${escapeTag(opts.source)}}`)
  const prefilter = filters.length ? `(${filters.join(' ')})` : '*'

  const query = `${prefilter}=>[KNN ${topK} @embedding $BLOB AS score]`

  const res = await redis.ft.search('idx:study', query, {
    PARAMS: { BLOB: qbuf },
    RETURN: ['video_id', 'video_title', 'source', 'start_sec', 'text', 'score'],
    SORTBY: { BY: 'score', DIRECTION: 'ASC' }, // closest first
    DIALECT: 2,
    LIMIT: { from: 0, size: topK },
  })

  return res.documents.map((d) => ({
    video_id: String(d.value.video_id ?? ''),
    video_title: String(d.value.video_title ?? ''),
    source: String(d.value.source ?? ''),
    text: String(d.value.text ?? ''),
    startSec: Number(d.value.start_sec ?? -1),
    score: Number(d.value.score ?? 0),
  }))
}

/**
 * Fetch all indexed chunks for one video directly (no similarity ranking). Used
 * as a fallback when a question is scoped to a video but too generic to match by
 * topic — e.g. "explain my notes" or "summarize this". `score` is 0 (not a
 * distance) since these aren't ranked against the question.
 */
export async function getVideoDocs(videoId: string, limit = 10): Promise<SearchResult[]> {
  await connectRedis()
  const res = await redis.ft.search('idx:study', `@video_id:{${escapeTag(videoId)}}`, {
    RETURN: ['video_id', 'video_title', 'source', 'start_sec', 'text'],
    DIALECT: 2,
    LIMIT: { from: 0, size: limit },
  })
  return res.documents.map((d) => ({
    video_id: String(d.value.video_id ?? ''),
    video_title: String(d.value.video_title ?? ''),
    source: String(d.value.source ?? ''),
    text: String(d.value.text ?? ''),
    startSec: Number(d.value.start_sec ?? -1),
    score: 0,
  }))
}
