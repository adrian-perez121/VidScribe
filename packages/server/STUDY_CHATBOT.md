# Study Chatbot (Redis vector search + OpenAI embeddings + Claude)

A RAG chatbot endpoint for the Vid-Mark study app. Given a student's question, it
finds the most relevant content across their videos via vector search, answers in
natural language with Claude grounded in that content, and returns structured
`sources` so the UI can show which video(s) the answer came from.

> Transcripts are **intentionally not indexed yet** (planned later). For now the
> searchable corpus is built from the notes a student creates against each video.

---

## What gets indexed

All content hangs off a `VidscribeNote` in MongoDB (the `notes` collection) and is
associated with a `videoId`. Each note contributes up to **three** indexable docs,
one per non-empty field:

| `source` tag | Field on `VidscribeNote` | Produced by |
|---|---|---|
| `note` | `text` | the student's own typed/voice notes |
| `browserbase` | `researchSummary` | the web-research route (Browserbase scrape) |
| `lens` | `aiExplanation` | the "lens" screenshot explainer — Claude API (`routes/explain.ts`) |

`video_id` is the Mongo GridFS file id; `video_title` is looked up from the GridFS
`videos.files` metadata.

---

## Architecture

```
                 ┌─────────────────────────── batch reindex (scripts/ingest.ts) ──┐
 MongoDB notes   │  read notes  ->  embed (OpenAI text-embedding-3-small, 1536d)   │
 + GridFS files  │            ->  hSet into Redis vector index (idx:study)         │
                 └────────────────────────────────────────────────────────────────┘

 POST /chat  ->  embed question  ->  KNN search idx:study  ->  build context block
             ->  Claude (claude-sonnet-4-6) grounded answer  ->  { answer, sources }
```

- **Embeddings:** OpenAI `text-embedding-3-small`, 1536 dims, stored as Float32
  buffers (`Buffer.from(new Float32Array(vec).buffer)` = 6144 bytes).
- **Vector store:** Redis 8 (`redis-server`, with the `search`/RediSearch module
  built into core — no separate Redis Stack needed). One `FLAT` / `FLOAT32` /
  `COSINE` index named `idx:study`, key prefix `doc:`.
- **LLM:** Anthropic `claude-sonnet-4-6` (swap to `claude-haiku-4-5-20251001` for
  cheaper/faster). `system` is top-level, `max_tokens` required, guard
  `block.type === "text"` before reading `.text`.
- If retrieval finds nothing relevant, the bot says it doesn't know and returns
  empty `sources` — it must not invent a video.

### Redis index `idx:study`

| field | type | notes |
|---|---|---|
| key | — | `doc:{source}:{noteId}` (stable -> idempotent re-runs) |
| `video_id` | tag | filterable |
| `video_title` | text | shown in `sources` |
| `source` | tag | `note` \| `browserbase` \| `lens` |
| `text` | text | the indexed content |
| `embedding` | vector | 1536 float32, cosine, flat |

---

## Requirements to run

### Infrastructure
- **Redis 8** (`redis-server`) running locally on `:6379`. Redis 8 ships the
  `search` module in core, so `ft.create`/KNN work out of the box (Redis Stack is
  not available for Ubuntu 24.04 "noble"). Verify: `redis-cli ping` -> `PONG`, and
  `redis-cli MODULE LIST` shows `search`. ✅ installed & verified.
- **MongoDB** reachable, containing the notes to index (local `mongod` or the
  team's Atlas cluster).

### Environment (`packages/server/.env`)
| var | purpose | status |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | ✅ set (local) |
| `OPENAI_API_KEY` | embeddings | ✅ set |
| `ANTHROPIC_API_KEY` | Claude answers | ✅ set |
| `MONGODB_URI` (+ `MONGODB_DB`, optional `MONGODB_USERNAME`/`PASSWORD`) | read notes/videos | ⛔ **missing — required for ingest** |

---

## Current state

**Done**
- `lib/redis.ts` — client + `ensureIndex()` (creates `idx:study`) + `dropIndex()`
  (drops index and its docs for clean reindex).
- `scripts/ingest.ts` — batch reindex: reads all Mongo notes, flattens to the
  three sources above, embeds, drops + recreates the index, stores, and prints a
  checkpoint (total + per-source counts + a sample dump; expect 6144 embedding
  bytes).
- `scripts/healthcheck.ts` — pings Redis, embeds one string, makes a one-line
  Claude call. ✅ **Phase 0 passes** (`Redis: OK`, `embedding dims: 1536`, Claude
  replies).
- Redis Cloud fully removed; everything points at local Redis 8 (installed &
  verified, `search` module loaded).

**Not done yet**
- `MONGODB_URI` not set — ingest can't run until it is (the only remaining
  blocker).
- Retrieval helper `search(question, topK, opts?)`.
- `POST /chat` route (context block + Claude + deduped `sources`).
- Session memory (`sess:{session_id}` list in Redis).
- Transcript ingestion (future).

---

## Build phases (remaining)

0. **Connections** — `healthcheck.ts` prints `Redis: OK`, `embedding dims: 1536`,
   and a Claude sentence. *(blocked on Redis Stack install)*
1. **Ingest** — `scripts/ingest.ts` indexes notes (built; needs `MONGODB_URI`).
   Checkpoint: per-source counts > 0 and a sample with a 6144-byte embedding.
2. **Retrieval** — `search()` via KNN; right video / relevant chunk on a known
   question, clearly worse scores on an off-topic one.
3. **Chat endpoint** — `POST /chat` `{ message, session_id }` -> `{ answer,
   sources }`; `sources` deduped from retrieved metadata (not parsed from prose).
4. **Notes already covered** — all three sources are indexed from phase 1.
5. **Session memory** — persist turns per `session_id`, replay last ~8.
6. **(Optional) Semantic cache** in front of the LLM call.

### Acceptance test
1. Index a couple of videos' worth of notes.
2. "Which video covers [concept]?" -> answer names the right video; `sources`
   lists it.
3. Follow-up with a pronoun -> resolved via history.
4. Something not covered -> graceful "I don't know," empty `sources`.

---

## How to run

```bash
# 1. Redis 8 (Ubuntu 24.04, one-time) — run in a real terminal (sudo needs a TTY).
#    redis-stack-server has no noble package; redis-server 8.x bundles `search`.
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor --yes -o /usr/share/keyrings/redis-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb noble main" | sudo tee /etc/apt/sources.list.d/redis.list \
  && sudo apt-get update && sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping            # -> PONG
redis-cli MODULE LIST     # -> includes `search`

# 2. Set MONGODB_URI in packages/server/.env

# 3. Sanity check, then index:
cd packages/server
npx tsx scripts/healthcheck.ts
npx tsx scripts/ingest.ts
```
