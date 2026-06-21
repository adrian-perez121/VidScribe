import 'dotenv/config'
import OpenAI from 'openai'
import type { VidscribeNote, TranscriptSegment } from '@vid-mark/shared'
import { redis, connectRedis, ensureIndex, dropIndex } from '../lib/redis.js'
import { getDb, getNotesCollection, getTranscriptsCollection, VIDEO_BUCKET } from '../lib/mongo.js'

// Batch reindex: pull every note AND transcript from Mongo and (re)build the
// Redis vector index from scratch. Each chunk carries a `start_sec` so the
// chatbot can point at the exact moment in the video.
//
//   source=note        -> the student's own note text        (note.text)
//   source=browserbase -> the web-research summary           (note.researchSummary)
//   source=lens        -> the Claude screenshot explanation  (note.aiExplanation)
//   source=transcript  -> chunked Deepgram transcript        (transcripts collection)
//
// Re-running is safe: we drop the index + its docs first, so edits/deletes
// don't leave stale vectors behind.

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

/** Note fields we embed, paired with the `source` tag they're stored under. */
const NOTE_SOURCES: { source: string; field: keyof VidscribeNote }[] = [
  { source: 'note', field: 'text' },
  { source: 'browserbase', field: 'researchSummary' },
  { source: 'lens', field: 'aiExplanation' },
]

/** Every source tag we index, for the checkpoint breakdown. */
const ALL_SOURCES = ['note', 'browserbase', 'lens', 'transcript']

/** Target size (chars) for a transcript chunk — segments are tiny on their own. */
const TRANSCRIPT_CHUNK_CHARS = 700

async function embed(text: string): Promise<number[]> {
  const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
  return r.data[0].embedding
}

interface IndexItem {
  key: string
  videoId: string
  videoTitle: string
  source: string
  text: string
  /** Point in the video, or -1 when there's no meaningful timestamp. */
  startSec: number
}

/** Group tiny transcript segments into ~chunk-sized pieces, keeping each chunk's start time. */
function chunkTranscript(segments: TranscriptSegment[]): { text: string; startSec: number }[] {
  const chunks: { text: string; startSec: number }[] = []
  let buf = ''
  let start = 0
  for (const seg of segments) {
    const t = seg.text?.trim()
    if (!t) continue
    if (buf === '') start = seg.startSec
    buf += (buf ? ' ' : '') + t
    if (buf.length >= TRANSCRIPT_CHUNK_CHARS) {
      chunks.push({ text: buf, startSec: start })
      buf = ''
    }
  }
  if (buf.trim()) chunks.push({ text: buf, startSec: start })
  return chunks
}

async function main() {
  // Title lookup shared by notes + transcripts.
  const db = await getDb()
  const files = await db
    .collection(`${VIDEO_BUCKET}.files`)
    .find({}, { projection: { filename: 1, metadata: 1 } })
    .toArray()
  const titleById = new Map<string, string>()
  for (const f of files) {
    titleById.set(f._id.toString(), f.metadata?.title ?? f.filename ?? 'Untitled video')
  }

  const items: IndexItem[] = []

  // 1a. Notes -> up to three source docs each.
  const notes = await (await getNotesCollection()).find({}).toArray()
  for (const note of notes) {
    const videoTitle = titleById.get(note.videoId) ?? 'Untitled video'
    const startSec = typeof note.timestampSec === 'number' ? note.timestampSec : -1
    for (const { source, field } of NOTE_SOURCES) {
      const value = note[field]
      if (typeof value === 'string' && value.trim()) {
        items.push({
          key: `doc:${source}:${note.id}`,
          videoId: note.videoId,
          videoTitle,
          source,
          text: value.trim(),
          startSec,
        })
      }
    }
  }

  // 1b. Transcripts -> chunked docs, each with its start time.
  const transcripts = await (await getTranscriptsCollection()).find({}).toArray()
  for (const t of transcripts) {
    const videoTitle = titleById.get(t.videoId) ?? 'Untitled video'
    chunkTranscript(t.segments ?? []).forEach((ch, i) => {
      items.push({
        key: `doc:transcript:${t.videoId}:${i}`,
        videoId: t.videoId,
        videoTitle,
        source: 'transcript',
        text: ch.text,
        startSec: ch.startSec,
      })
    })
  }

  console.log(
    `${notes.length} notes + ${transcripts.length} transcripts -> ${items.length} chunks. Embedding (no Redis yet)...`,
  )

  // 2. Embed everything first (before touching Redis, so the connection never idles).
  const embeddings: number[][] = []
  for (let i = 0; i < items.length; i++) {
    process.stdout.write(`\r  embedding ${i + 1}/${items.length}...`)
    embeddings.push(await embed(items[i].text))
  }
  console.log(items.length ? '\nEmbeddings done.' : 'Nothing to embed.')

  // 3. Connect, clean-slate the index, then store back-to-back.
  await connectRedis()
  await dropIndex()
  await ensureIndex()
  console.log(`Storing ${items.length} chunks...`)

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    process.stdout.write(`\r  storing ${i + 1}/${items.length}...`)
    const buf = Buffer.from(new Float32Array(embeddings[i]).buffer)
    await redis.hSet(it.key, {
      video_id: it.videoId,
      video_title: it.videoTitle,
      source: it.source,
      start_sec: String(it.startSec),
      text: it.text,
      embedding: buf,
    })
  }
  console.log(items.length ? '\nDone.' : 'Index is empty.')

  // Checkpoint: total + per-source breakdown + one sample dump.
  const total = (await redis.ft.search('idx:study', '*', { LIMIT: { from: 0, size: 0 } })).total
  console.log(`\nIndexed docs: ${total}`)
  for (const source of ALL_SOURCES) {
    const n = (await redis.ft.search('idx:study', `@source:{${source}}`, { LIMIT: { from: 0, size: 0 } })).total
    console.log(`  ${source}: ${n}`)
  }

  if (items.length) {
    const sample = await redis.hGetAll(items[0].key)
    const embeddingBytes = await redis.hStrLen(items[0].key, 'embedding')
    console.log(`\nSample ${items[0].key}:`)
    console.log(`  source: ${sample.source}  start_sec: ${sample.start_sec}  video_title: "${sample.video_title}"`)
    console.log(`  text: "${sample.text?.slice(0, 80)}..."`)
    console.log(`  embedding bytes: ${embeddingBytes} (expect 6144)`)
  }

  await redis.disconnect()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
