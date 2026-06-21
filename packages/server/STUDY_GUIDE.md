# Study guide generator

Generates a structured study guide on demand from a student's collected material —
their notes, AI ("lens") explanations, web-research summaries, and the lecture
transcript. Built fresh on every request and returned; **not persisted**.

Scope is optional: pass a `video_id` to build a guide for one video, or omit it to
build one across the whole library.

---

## Endpoint

### `POST /api/study-guide`

**Body**
```jsonc
{ "video_id": "6a37e6a8b5d91bd3c3367bd0" }  // optional — omit for the whole library
```

**Response** `{ guide }`
```jsonc
{
  "guide": {
    "title": "Study guide: videoplayback (1) (1)",   // or "Study guide: all videos"
    "overview": "A 2-4 sentence summary of what the material covers.",
    "sections": [
      { "heading": "Energy Storage and ATP", "points": ["...", "..."] },
      { "heading": "Redox Reactions",        "points": ["...", "..."] }
    ],
    "videoId": "6a37e6a8b5d91bd3c3367bd0"            // present only when scoped
  }
}
```

**Errors**
- `404` — no notes or transcript exist yet to build from.
- `500` — generation failed (see server logs).

---

## How it works

1. **Collect material** (`lib/contentCollector.ts → collectContent`): pulls straight
   from MongoDB (no vector search), aggregating per source and labeling each block:
   - `note` ← `note.text`
   - `browserbase` ← `note.researchSummary`
   - `lens` ← `note.aiExplanation`
   - `transcript` ← the video's stored transcript (joined segments, capped at
     `MAX_TRANSCRIPT_CHARS = 12000` per video so a long lecture can't blow the prompt)
2. **Generate** (`lib/studyGuide.ts → generateStudyGuide`): sends the labeled material
   to Claude (`claude-sonnet-4-6`) with a system prompt that requires **JSON-only**
   output (`overview` + `sections[]`), grounded strictly in the material — no invented
   facts. The response is parsed with a tolerant JSON extractor.
3. **Return** the normalized guide. Empty/invalid sections are filtered out.

Returns `null` (→ `404`) when there's no material for the requested scope.

---

## Files

| File | Role |
|---|---|
| `src/routes/studyGuide.ts` | `POST /api/study-guide` route |
| `lib/studyGuide.ts` | `generateStudyGuide(videoId?)` |
| `lib/contentCollector.ts` | `collectContent(videoId?)` — shared with flashcards |
| `lib/anthropic.ts` | shared Claude client + JSON extraction helpers |
| `packages/shared/src/index.ts` | `StudyGuide`, `StudyGuideSection`, `StudyGuideRequest`, `StudyGuideResponse` |

---

## Requirements
- `ANTHROPIC_API_KEY`, `MONGODB_URI` in `packages/server/.env`.
- Notes and/or a transcript stored in Mongo for the requested scope. (Transcripts are
  created via `POST /api/videos/:id/transcript`.)
- Does **not** use Redis — it reads source material directly from Mongo.

---

## Try it

```bash
# whole library
curl -s -X POST http://localhost:3000/api/study-guide \
  -H 'Content-Type: application/json' -d '{}'

# one video
curl -s -X POST http://localhost:3000/api/study-guide \
  -H 'Content-Type: application/json' \
  -d '{"video_id":"6a37e6a8b5d91bd3c3367bd0"}'
```

See [FLASHCARDS.md](FLASHCARDS.md) for the companion deck generator and
[STUDY_CHATBOT.md](STUDY_CHATBOT.md) for the RAG chatbot.
