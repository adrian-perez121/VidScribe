import { randomUUID } from 'node:crypto'
import type { Flashcard, FlashcardGrade } from '@vid-mark/shared'
import { anthropic, textFrom, extractJson } from './anthropic.js'
import { collectContent } from './contentCollector.js'
import { getFlashcardsCollection } from './mongo.js'
import { initialSr, applyGrade } from './sm2.js'

// Flashcard generation + spaced-repetition review. Cards are generated from the
// same material as the study guide (notes + lens + research + transcript), then
// persisted so SM-2 scheduling survives across sessions.

const DEFAULT_COUNT = 12
const MAX_COUNT = 30

const SYSTEM_PROMPT = `You are a study assistant creating flashcards from a student's lecture material: their notes, AI explanations, web-research summaries, and the lecture transcript.

Write clear question/answer flashcards that test the key concepts. The front is a question or prompt; the back is a concise, self-contained answer. Base everything STRICTLY on the provided material — do not invent facts.

Respond with ONLY valid JSON in exactly this shape, no prose, no markdown fences:
{ "cards": [ { "front": "question", "back": "answer" } ] }`

interface RawCards {
  cards?: { front?: string; back?: string }[]
}

/**
 * Generate and persist flashcards. Returns [] when there's no material. For a
 * scoped video this replaces that video's existing cards (regenerate semantics);
 * whole-library generation appends.
 */
export async function generateFlashcards(videoId?: string, count = DEFAULT_COUNT): Promise<Flashcard[]> {
  const content = await collectContent(videoId)
  if (content.count === 0) return []

  const n = Math.min(Math.max(Math.floor(count) || DEFAULT_COUNT, 1), MAX_COUNT)
  const msg = await anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Study material:\n\n${content.text}\n\nCreate up to ${n} flashcards.` }],
  })

  const raw = extractJson<RawCards>(textFrom(msg))
  const now = new Date()
  const cards: Flashcard[] = (raw.cards ?? [])
    .filter(
      (c) =>
        c && typeof c.front === 'string' && typeof c.back === 'string' && c.front.trim() && c.back.trim(),
    )
    .slice(0, n)
    .map((c) => ({
      id: randomUUID(),
      ...(videoId ? { videoId } : {}),
      front: (c.front as string).trim(),
      back: (c.back as string).trim(),
      createdAt: now.toISOString(),
      ...initialSr(now),
    }))

  const col = await getFlashcardsCollection()
  if (videoId) await col.deleteMany({ videoId }) // regenerate semantics for a scoped video
  if (cards.length) await col.insertMany(cards.map((c) => ({ _id: c.id, ...c })))
  return cards
}

/** List stored cards, optionally scoped to a video and/or only those due now. */
export async function listFlashcards(opts: { videoId?: string; dueOnly?: boolean } = {}): Promise<Flashcard[]> {
  const col = await getFlashcardsCollection()
  const query: Record<string, unknown> = {}
  if (opts.videoId) query.videoId = opts.videoId
  // dueAt is an ISO-8601 UTC string, so lexicographic <= equals chronological <=.
  if (opts.dueOnly) query.dueAt = { $lte: new Date().toISOString() }
  const docs = await col.find(query).sort({ dueAt: 1 }).toArray()
  return docs.map(({ _id: _drop, ...card }) => card)
}

/** Apply an SM-2 review grade to a card and persist the new schedule. Null if not found. */
export async function reviewFlashcard(id: string, grade: FlashcardGrade): Promise<Flashcard | null> {
  const col = await getFlashcardsCollection()
  const doc = await col.findOne({ _id: id })
  if (!doc) return null

  const sr = applyGrade(
    { ease: doc.ease, intervalDays: doc.intervalDays, repetitions: doc.repetitions },
    grade,
  )
  await col.updateOne({ _id: id }, { $set: sr })

  const { _id: _drop, ...card } = doc
  return { ...card, ...sr }
}
