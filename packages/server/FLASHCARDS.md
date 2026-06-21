# Flashcards (SM-2 spaced repetition)

Generates question/answer flashcards from the same material as the study guide
(notes, lens explanations, research summaries, transcript), then **persists** them in
MongoDB so spaced-repetition scheduling survives across sessions. Reviews are graded
Anki-style and rescheduled with the **SM-2** algorithm.

Scope is optional: pass a `video_id` to build a deck for one video, or omit it for the
whole library.

---

## Endpoints

### `POST /api/flashcards/generate`
Generate and persist a deck.

**Body**
```jsonc
{
  "video_id": "6a37e6a8b5d91bd3c3367bd0",  // optional — omit for the whole library
  "count": 12                              // optional — clamped to 1..30 (default 12)
}
```
**Response** `{ cards: Flashcard[] }` — `404` if there's no material to build from.

> Regenerate semantics: a **scoped** (`video_id`) generate first deletes that video's
> existing cards, then inserts the new ones. Whole-library generation **appends**.

### `GET /api/flashcards?video_id=<id>&due=true`
List stored cards, sorted by `dueAt` ascending.
- `video_id` (optional) — scope to one video.
- `due=true` (optional) — only cards due now (`dueAt <= now`).

**Response** `{ cards: Flashcard[] }`

### `POST /api/flashcards/:id/review`
Grade a card and reschedule it via SM-2.

**Body** `{ "grade": "again" | "hard" | "good" | "easy" }`
**Response** `{ card: Flashcard }` — the updated, rescheduled card. `404` if not found,
`400` on an invalid grade.

---

## Flashcard shape

```jsonc
{
  "id": "c32900f6-...",
  "videoId": "6a37e6a8b5d91bd3c3367bd0",   // absent for whole-library cards
  "front": "What does OIL RIG stand for in redox reactions?",
  "back": "Oxidation Is Loss, Reduction Is Gain — ...",
  "ease": 2.5,            // SM-2 ease factor (>= 1.3)
  "intervalDays": 1,      // current inter-review interval in days
  "repetitions": 1,       // consecutive successful reviews
  "dueAt": "2026-06-22T15:03:59.584Z",
  "createdAt": "2026-06-21T15:03:59.181Z",
  "lastReviewedAt": "2026-06-21T15:03:59.584Z"
}
```

---

## SM-2 scheduling (`lib/sm2.ts`)

New cards start at `ease = 2.5`, `intervalDays = 0`, `repetitions = 0`, and are due
immediately. On review, the grade maps to an SM-2 quality score:

| Grade  | Quality | Effect |
|--------|---------|--------|
| again  | 1 | **Fail**: `repetitions → 0`, re-shown in ~10 minutes, ease decreased |
| hard   | 3 | Advance, but ease decreases |
| good   | 4 | Advance, ease ~unchanged |
| easy   | 5 | Advance, ease increases |

On a passing grade (`quality >= 3`):
- `repetitions += 1`
- interval becomes **1 day** (1st rep), **6 days** (2nd rep), then
  `round(previousInterval × ease)` thereafter.
- `dueAt = now + intervalDays`.

Ease updates by the standard SM-2 formula and is floored at `1.3`. `dueAt` is stored as
an ISO-8601 UTC string, so the `due=true` filter is a simple lexicographic `<=`
comparison (which equals chronological order).

---

## Storage

MongoDB collection **`flashcards`**, one document per card (`_id === card.id`), via
`getFlashcardsCollection()` in `lib/mongo.ts`.

---

## Files

| File | Role |
|---|---|
| `src/routes/flashcards.ts` | generate / list / review routes |
| `lib/flashcards.ts` | `generateFlashcards`, `listFlashcards`, `reviewFlashcard` |
| `lib/sm2.ts` | `initialSr`, `applyGrade` — the SM-2 scheduler |
| `lib/contentCollector.ts` | `collectContent(videoId?)` — shared with the study guide |
| `lib/anthropic.ts` | shared Claude client + JSON extraction helpers |
| `packages/shared/src/index.ts` | `Flashcard`, `FlashcardGrade`, `GenerateFlashcardsRequest`, `FlashcardsResponse`, `ReviewFlashcardRequest`, `ReviewFlashcardResponse` |

---

## Requirements
- `ANTHROPIC_API_KEY`, `MONGODB_URI` in `packages/server/.env`.
- Notes and/or a transcript stored in Mongo for the requested scope.
- Does **not** use Redis — material is read directly from Mongo.

---

## Try it

```bash
# generate a small scoped deck
GEN=$(curl -s -X POST http://localhost:3000/api/flashcards/generate \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"6a37e6a8b5d91bd3c3367bd0","count":4}')
echo "$GEN"

# grab the first card id and review it
ID=$(echo "$GEN" | grep -oP '"id":"\K[^"]+' | head -1)
curl -s -X POST "http://localhost:3000/api/flashcards/$ID/review" \
  -H 'Content-Type: application/json' -d '{"grade":"good"}'

# list what's due now for that video
curl -s "http://localhost:3000/api/flashcards?video_id=6a37e6a8b5d91bd3c3367bd0&due=true"
```

See [STUDY_GUIDE.md](STUDY_GUIDE.md) for the companion guide generator and
[STUDY_CHATBOT.md](STUDY_CHATBOT.md) for the RAG chatbot.
