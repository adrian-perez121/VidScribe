import type { FlashcardGrade } from '@vid-mark/shared'

// SM-2 spaced-repetition scheduler (the SuperMemo-2 / Anki-style algorithm).
// Maps the four review buttons to SM-2 quality scores and updates the card's
// ease factor, interval, and next due date.

export interface SrCore {
  ease: number
  intervalDays: number
  repetitions: number
}

export interface SrUpdate extends SrCore {
  dueAt: string
  lastReviewedAt: string
}

const QUALITY: Record<FlashcardGrade, number> = { again: 1, hard: 3, good: 4, easy: 5 }
const DAY_MS = 24 * 60 * 60 * 1000
const AGAIN_DELAY_MS = 10 * 60 * 1000 // re-show failed cards ~10 minutes later

/** State for a brand-new card: due immediately, default ease. */
export function initialSr(now = new Date()): SrCore & { dueAt: string } {
  return { ease: 2.5, intervalDays: 0, repetitions: 0, dueAt: now.toISOString() }
}

/** Apply a review grade to a card's SM-2 state and compute the next due date. */
export function applyGrade(prev: SrCore, grade: FlashcardGrade, now = new Date()): SrUpdate {
  const q = QUALITY[grade]

  // Ease factor update (SM-2 formula), floored at 1.3.
  let ease = prev.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  if (ease < 1.3) ease = 1.3
  ease = Math.round(ease * 1000) / 1000

  let repetitions = prev.repetitions
  let intervalDays = prev.intervalDays
  let dueMs: number

  if (q < 3) {
    // Failed ("again"): reset the streak and re-show shortly.
    repetitions = 0
    intervalDays = 0
    dueMs = now.getTime() + AGAIN_DELAY_MS
  } else {
    repetitions += 1
    if (repetitions === 1) intervalDays = 1
    else if (repetitions === 2) intervalDays = 6
    else intervalDays = Math.round(prev.intervalDays * ease)
    dueMs = now.getTime() + intervalDays * DAY_MS
  }

  return {
    ease,
    intervalDays,
    repetitions,
    dueAt: new Date(dueMs).toISOString(),
    lastReviewedAt: now.toISOString(),
  }
}
