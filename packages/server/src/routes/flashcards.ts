import { Hono } from 'hono'
import type { FlashcardGrade } from '@vid-mark/shared'
import { generateFlashcards, listFlashcards, reviewFlashcard } from '../../lib/flashcards.js'

// Flashcard endpoints:
//   POST /api/flashcards/generate    { video_id?, count? } -> { cards }
//   GET  /api/flashcards?video_id=&due=true                -> { cards }
//   POST /api/flashcards/:id/review  { grade }             -> { card }

export const flashcardsRoute = new Hono()

const GRADES: FlashcardGrade[] = ['again', 'hard', 'good', 'easy']

// Generate (and persist) a deck.
flashcardsRoute.post('/generate', async (c) => {
  const body = await c.req.json<{ video_id?: unknown; count?: unknown }>().catch(() => null)
  const videoId = typeof body?.video_id === 'string' && body.video_id ? body.video_id : undefined
  const count = typeof body?.count === 'number' ? body.count : undefined

  try {
    const cards = await generateFlashcards(videoId, count)
    if (!cards.length) {
      return c.json({ error: 'No notes or transcript found to build flashcards from yet.' }, 404)
    }
    return c.json({ cards })
  } catch (err) {
    console.error('Flashcard generation failed:', err)
    return c.json({ error: 'Failed to generate flashcards. Check server logs for details.' }, 500)
  }
})

// List stored cards (optionally scoped / only-due).
flashcardsRoute.get('/', async (c) => {
  const videoId = c.req.query('video_id') || undefined
  const dueOnly = c.req.query('due') === 'true'
  const cards = await listFlashcards({ videoId, dueOnly })
  return c.json({ cards })
})

// Review a card → reschedule via SM-2.
flashcardsRoute.post('/:id/review', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ grade?: unknown }>().catch(() => null)
  if (!body || typeof body.grade !== 'string' || !GRADES.includes(body.grade as FlashcardGrade)) {
    return c.json({ error: 'Body must be { grade: "again" | "hard" | "good" | "easy" }' }, 400)
  }

  const card = await reviewFlashcard(id, body.grade as FlashcardGrade)
  if (!card) return c.json({ error: 'Flashcard not found' }, 404)
  return c.json({ card })
})
