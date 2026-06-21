import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import type { ChatSource } from '@vid-mark/shared'
import { search, getVideoDocs } from '../../lib/search.js'
import { loadHistory, appendTurn } from '../../lib/session.js'

// POST /api/chat — the study chatbot. Retrieves relevant content from the Redis
// vector index, grounds a Claude answer in it, and returns { answer, sources }
// where `sources` is deduped from the RETRIEVED metadata (not parsed from the
// model's prose). Conversation memory is kept per session_id in Redis.

export const chatRoute = new Hono()

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

const TOP_K = 5

// KNN always returns the nearest TOP_K docs no matter how far away they are, so
// an off-topic question still pulls back the closest (irrelevant) chunks. We drop
// anything beyond this cosine distance so off-topic questions yield no context
// and no sources. Tuned for text-embedding-3-small: on-topic matches land well
// under ~0.5, clearly unrelated ones up near ~0.9-1.0.
const MAX_DISTANCE = 0.6

/** Human-friendly labels for each source tag, used in the context block. */
const SOURCE_LABEL: Record<string, string> = {
  note: 'your note',
  browserbase: 'web research',
  lens: 'AI explanation',
  transcript: 'lecture transcript',
}

/** Format seconds as m:ss (or h:mm:ss) for the context labels. */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const SYSTEM_PROMPT = `You are a study tutor helping a student review their own lecture videos.
You are given context passages retrieved from the student's notes, web-research summaries, AI screenshot explanations, and the lecture transcript. Each passage is labeled with the video it came from, and transcript/note passages also carry a timestamp (the point in the video they come from).

Answer the student's question using ONLY the information in the context passages.
If the answer is not contained in the context, say you don't have anything on that in their videos yet, and do not invent or guess.
When you use information, name which video(s) it came from. If the student asks where in a video something is covered, point them to the timestamp shown on the relevant passage.
Write in plain, clear prose without markdown formatting.`

interface ChatBody {
  message?: unknown
  session_id?: unknown
  video_id?: unknown
}

chatRoute.post('/', async (c) => {
  const body = await c.req.json<ChatBody>().catch(() => null)
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return c.json({ error: 'Body must be { message: string, session_id?: string }' }, 400)
  }
  const message = body.message.trim()
  const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
  // When set (e.g. asking from a video page), scope retrieval to that video.
  const videoId = typeof body.video_id === 'string' && body.video_id ? body.video_id : undefined

  try {
    // 1. Retrieve relevant chunks, then keep only those close enough to count.
    let results = (await search(message, TOP_K, videoId ? { videoId } : undefined)).filter(
      (r) => r.score <= MAX_DISTANCE,
    )

    // Scoped to a video but nothing matched by topic? The question is probably
    // generic ("explain my notes", "summarize this"), so fall back to that
    // video's content directly instead of leaving the model with nothing.
    if (videoId && results.length === 0) {
      results = await getVideoDocs(videoId)
    }

    // 2. Build a labeled context block for grounding (with timestamps when known).
    const contextBlock = results.length
      ? results
          .map((r) => {
            const label = SOURCE_LABEL[r.source] ?? r.source
            const at = r.startSec >= 0 ? ` @ ${formatTime(r.startSec)}` : ''
            return `[${label}${at} | video=${r.video_title}] ${r.text}`
          })
          .join('\n\n')
      : '(no relevant content found)'

    // 3. Load conversation history (if a session was provided).
    const history = sessionId ? await loadHistory(sessionId, 8) : []

    // 4. Ask Claude, grounded in the context.
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        ...history,
        { role: 'user', content: `Context:\n${contextBlock}\n\nQuestion: ${message}` },
      ],
    })
    const block = resp.content[0]
    const answer = block && block.type === 'text' ? block.text : ''

    // 5. Dedupe sources from the RETRIEVED metadata (by video). Results are
    // ordered closest-first, so the first chunk per video gives the most
    // relevant moment to jump to.
    const seen = new Set<string>()
    const sources: ChatSource[] = results
      .filter((r) => {
        if (!r.video_id || seen.has(r.video_id)) return false
        seen.add(r.video_id)
        return true
      })
      .map((r) => ({
        video_id: r.video_id,
        video_title: r.video_title,
        ...(r.startSec >= 0 ? { timestamp_sec: r.startSec } : {}),
      }))

    // 6. Persist this turn for follow-ups.
    if (sessionId) {
      await appendTurn(sessionId, { role: 'user', content: message })
      await appendTurn(sessionId, { role: 'assistant', content: answer })
    }

    return c.json({ answer, sources })
  } catch (err) {
    console.error('Chat request failed:', err)
    return c.json({ error: 'Chat request failed. Check server logs for details.' }, 500)
  }
})
