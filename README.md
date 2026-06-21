# Vidscribe

A video annotation tool that lets you take notes on video lectures and automatically research concepts from the transcript using live web sources. Notes are timestamped to the exact moment in the video, giving you a study notebook that remembers where every idea came from.

## Features

**Text notes** — write a note at any playback position; the timestamp is saved automatically.

**Voice notes** — record a quick observation via microphone; Deepgram transcribes it and the text is saved as a note.

**Visual notes** — draw a crop box over any frame; Claude explains what is in that region in plain language.

**AI research** — highlight a chunk of transcript; the server distills keywords, searches the web via Browserbase, and returns a teacher-style summary plus the source links. The summary is explicitly tied back to what is on screen.

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
| Visual explain | Anthropic Claude (multimodal) |
| Web research | Browserbase + Stagehand + Gemini |

## Requirements

- Node.js 20+ (22 recommended)
- MongoDB Atlas cluster (or any MongoDB 6+ instance)
- API keys: Anthropic, Deepgram, Browserbase, Gemini (see below)

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
DEEPGRAM_API_KEY="..."
GEMINI_API_KEY="..."
BROWSERBASE_API_KEY="..."
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

## License

MIT
