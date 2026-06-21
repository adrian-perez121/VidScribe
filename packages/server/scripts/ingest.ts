import 'dotenv/config'
import OpenAI from 'openai'
import type { VidscribeNote } from '@vid-mark/shared'
import { redis, connectRedis, ensureIndex, dropIndex } from '../lib/redis.js'
import { getDb, getNotesCollection, VIDEO_BUCKET } from '../lib/mongo.js'

// Batch reindex: pull every note from Mongo and (re)build the Redis vector index
// from scratch. We index THREE kinds of content per note, each as its own doc so
// the chatbot can retrieve and label them independently:
//
//   source=note        -> the student's own note text        (note.text)
//   source=browserbase -> the web-research summary           (note.researchSummary)
//   source=lens        -> the Claude screenshot explanation  (note.aiExplanation)
//
// Transcripts are intentionally NOT indexed yet (coming later). Re-running this
// is safe: we drop the index + its docs first, so edits/deletes don't leave
// stale vectors behind.

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

/** The note fields we embed, paired with the `source` tag they're stored under. */
const SOURCES: { source: string; field: keyof VidscribeNote }[] = [
  { source: 'note', field: 'text' },
  { source: 'browserbase', field: 'researchSummary' },
  { source: 'lens', field: 'aiExplanation' },
]

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
}

async function main() {
  // 1. Pull all notes from Mongo.
  const notesCol = await getNotesCollection()
  const notes = await notesCol.find({}).toArray()

  // 2. Build a videoId -> title lookup from the GridFS files metadata.
  const db = await getDb()
  const files = await db
    .collection(`${VIDEO_BUCKET}.files`)
    .find({}, { projection: { filename: 1, metadata: 1 } })
    .toArray()
  const titleById = new Map<string, string>()
  for (const f of files) {
    titleById.set(f._id.toString(), f.metadata?.title ?? f.filename ?? 'Untitled video')
  }

  // 3. Flatten notes into indexable items (one per non-empty source field).
  const items: IndexItem[] = []
  for (const note of notes) {
    const videoTitle = titleById.get(note.videoId) ?? 'Untitled video'
    for (const { source, field } of SOURCES) {
      const value = note[field]
      if (typeof value === 'string' && value.trim()) {
        items.push({
          key: `doc:${source}:${note.id}`,
          videoId: note.videoId,
          videoTitle,
          source,
          text: value.trim(),
        })
      }
    }
  }

  console.log(`${notes.length} notes -> ${items.length} indexable chunks. Embedding (no Redis yet)...`)

  // 4. Embed everything first (before touching Redis, so the connection never idles).
  const embeddings: number[][] = []
  for (let i = 0; i < items.length; i++) {
    process.stdout.write(`\r  embedding ${i + 1}/${items.length}...`)
    embeddings.push(await embed(items[i].text))
  }
  console.log(items.length ? '\nEmbeddings done.' : 'Nothing to embed.')

  // 5. Connect, clean-slate the index, then store back-to-back.
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
      text: it.text,
      embedding: buf,
    })
  }
  console.log(items.length ? '\nDone.' : 'Index is empty.')

  // Checkpoint: total indexed + a per-source breakdown + one sample dump.
  const total = (await redis.ft.search('idx:study', '*', { LIMIT: { from: 0, size: 0 } })).total
  console.log(`\nIndexed docs: ${total}`)
  for (const { source } of SOURCES) {
    const n = (await redis.ft.search('idx:study', `@source:{${source}}`, { LIMIT: { from: 0, size: 0 } })).total
    console.log(`  ${source}: ${n}`)
  }

  if (items.length) {
    const sample = await redis.hGetAll(items[0].key)
    // Read the true binary length with HSTRLEN — hGetAll decodes the embedding as
    // a UTF-8 string, which mangles its byte count, so don't measure it directly.
    const embeddingBytes = await redis.hStrLen(items[0].key, 'embedding')
    console.log(`\nSample ${items[0].key}:`)
    console.log(`  source: ${sample.source}  video_title: "${sample.video_title}"`)
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
