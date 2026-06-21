# Vidscribe

A video annotation tool that lets you take notes on video lectures and automatically research concepts from the transcript using live web sources. Notes are timestamped to the exact moment in the video, giving you a study notebook that remembers where every idea came from. On top of that, a Redis-powered study layer turns your notes and transcripts into a RAG chatbot, study guides, and spaced-repetition flashcards — all exportable to Word.

## Features

**Text notes** — write a note at any playback position; the timestamp is saved automatically.

**Voice notes** — record a quick observation via microphone; Deepgram transcribes it and the text is saved as a note.

**Visual notes** — draw a crop box over any frame; Claude explains what is in that region in plain language.

**AI research** — highlight a chunk of transcript; the server distills keywords, searches the web via Browserbase, and returns a teacher-style summary plus the source links. The summary is explicitly tied back to what is on screen.

**Lecture transcripts** — Deepgram transcribes the full video into timestamped segments, stored once per video and reused by the study tools below.

**Study chatbot** — ask questions across your videos. A Redis vector search (RAG) retrieves the most relevant notes, research summaries, visual explanations, and transcript chunks; Claude answers grounded in them and returns the source video(s) — with a timestamp to jump to when the answer comes from the transcript. Conversation memory and first-turn answers are kept in Redis; if nothing relevant is found it says so instead of inventing an answer.

**Study guide** — generate a structured guide (overview + themed sections) from a single video or your whole library, drawn from notes, visual explanations, research, and transcript. Cached in Redis (invalidated when notes change) with a one-click Regenerate.

**Flashcards with spaced repetition** — auto-generate question/answer cards from the same material and review them with the SM-2 algorithm. Due-date scheduling is backed by a Redis sorted set, so "what's due now" is an O(log n) lookup.

**DOCX export** — download all your notes (with their summaries and timestamps) or the generated study guide as Word documents.

**Video library** — upload MP4 or WebM files to a MongoDB GridFS store. The dashboard shows thumbnails (captured in-browser before upload), durations, and per-video note counts. Videos can be deleted and their notes are removed from both the database and localStorage.

**Demo mode** — a bundled lecture video works with no credentials at all (notes go to localStorage only).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + TypeScript + Tailwind CSS |
| Backend | Hono on Node.js (run with tsx, no compile step) |
| Video storage | MongoDB Atlas + GridFS (streaming, range-request aware) |
| Notes | localStorage (live store) + MongoDB (mirrored for persistence) |
| Speech-to-text | Deepgram Nova |
| Visual explain / chatbot / study guide / flashcards | Anthropic Claude (`claude-sonnet-4-6`) |
| Web research | Browserbase + Stagehand + Gemini |
| Vector search, caching, session memory, due-queue | Redis 8 (RediSearch / sorted sets) |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) |
| Document export | `docx` |

## Requirements

- Node.js 20+ (22 recommended)
- MongoDB Atlas cluster (or any MongoDB 6+ instance)
- Redis 8 with the search module — local `redis-server` 8.x or Redis Stack (powers the chatbot, caching, and flashcard due-queue)
- API keys: Anthropic, OpenAI, Deepgram, Browserbase, Gemini (see below)

## Setup

```sh
npm install
cp packages/server/.env.sample packages/server/.env
```

Fill in `packages/server/.env`:

```
# MongoDB
MONGODB_URI="mongodb+srv://..."
MONGODB_USERNAME="..."
MONGODB_PASSWORD="..."
MONGODB_DB="vidmark"

# AI services
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_API_KEY="sk-proj-..."   # embeddings for the chatbot/study tools
DEEPGRAM_API_KEY="..."
GEMINI_API_KEY="..."
BROWSERBASE_API_KEY="..."

# Redis (vector index, caches, sessions, due-queue)
REDIS_URL="redis://localhost:6379"
```

If you want to run without external API keys during a demo, set the mock flags:

```
MOCK_DEEPGRAM="true"       # voice notes return a canned transcript
MOCK_BROWSERBASE="true"    # research returns a placeholder summary
```

## Running

```sh
# Development (hot reload on both frontend :5173 and server :3000)
npm run dev

# Production (build then serve everything from :3000)
npm run build
npm run start
```

In development the Vite dev server proxies `/api` to the Hono server, so there is no CORS to configure. In production the Hono server serves the built frontend and the API from the same origin.

## Redis & the search index

The study chatbot searches a Redis vector index (`idx:study`) of your notes,
research, visual explanations, and transcript chunks. Caches, chat session
memory, and the flashcard due-queue also live in Redis.

Run Redis 8 locally (Ubuntu example — needs the bundled `search` module):

```sh
redis-cli ping          # PONG
redis-cli MODULE LIST   # should include "search"
```

The chatbot reads from the index, which is built by a batch script. After adding
notes / generating transcripts, (re)build it:

```sh
cd packages/server
npx tsx scripts/ingest.ts      # embeds notes + transcripts into idx:study
npx tsx scripts/healthcheck.ts # checks Redis + OpenAI + Claude connectivity
```

Re-running `ingest.ts` is safe — it drops and rebuilds the index from MongoDB and
clears the dependent caches. The study guide, flashcards, and DOCX exports read
notes from MongoDB directly, so they reflect changes immediately without a
re-ingest; only the chatbot depends on the index.

## Project layout

```
packages/
  web/      React frontend (src/pages, src/components, src/lib)
  server/   Hono API (src/routes, lib/)
  shared/   TypeScript types imported by both (no build step)
```

## API overview

| Method | Path | Description |
|---|---|---|
| GET | /api/health | Server status |
| POST | /api/explain | Explain a cropped video frame (multipart: image + prompt) |
| POST | /api/deepgram/voice-note | Transcribe audio (multipart: audio blob) |
| POST | /api/research | Research a transcript chunk; returns keywords + summary + links |
| GET | /api/videos | List all uploaded videos (metadata + thumbnails) |
| GET | /api/videos/:id | Video metadata + its notes |
| GET | /api/videos/:id/stream | Range-aware video stream (for `<video>` playback) |
| POST | /api/videos | Upload a video (multipart: title + thumbnail + file) |
| DELETE | /api/videos/:id | Delete video and all associated notes |
| POST | /api/notes | Upsert a note |
| DELETE | /api/notes/:id | Delete a note |
| POST | /api/videos/:id/transcript | Transcribe the video via Deepgram and store it |
| GET | /api/videos/:id/transcript | Fetch the stored transcript |
| GET | /api/videos/:id/transcript/window | Transcript segments around a timestamp |
| POST | /api/chat | Study chatbot — `{ message, session_id?, video_id? }` → `{ answer, sources }` |
| POST | /api/study-guide | Generate a study guide — `{ video_id?, refresh? }` |
| POST | /api/flashcards/generate | Generate + persist flashcards — `{ video_id?, count? }` |
| GET | /api/flashcards | List cards (`?video_id=&due=true`; `due` uses the Redis queue) |
| POST | /api/flashcards/:id/review | Review a card (SM-2) — `{ grade }` |
| GET | /api/export/notes.docx | Download all notes (+ summaries + timestamps) as Word |
| GET | /api/export/study-guide.docx | Download the study guide as Word |

## License

MIT
