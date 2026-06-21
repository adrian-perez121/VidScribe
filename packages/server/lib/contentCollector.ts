import { getDb, getNotesCollection, getTranscriptsCollection, VIDEO_BUCKET } from './mongo.js'

// Gathers a student's study material straight from Mongo (no vector search) for
// whole-corpus tasks like building a study guide or a flashcard deck. Pulls the
// three note fields plus the lecture transcript, labeled by source, scoped to one
// video or across the whole library.

const NOTE_SOURCES = [
  { source: 'note', field: 'text' },
  { source: 'browserbase', field: 'researchSummary' },
  { source: 'lens', field: 'aiExplanation' },
] as const

/** Cap transcript text per video so a huge lecture doesn't blow the prompt. */
const MAX_TRANSCRIPT_CHARS = 12000

export interface CollectedContent {
  videoId?: string
  /** Display title: the video's title when scoped, else "all videos". */
  title: string
  /** Labeled material, ready to drop into a prompt. */
  text: string
  /** How many distinct pieces of material were gathered (0 = nothing to work with). */
  count: number
}

export async function collectContent(videoId?: string): Promise<CollectedContent> {
  // Title lookup.
  const db = await getDb()
  const files = await db
    .collection(`${VIDEO_BUCKET}.files`)
    .find({}, { projection: { filename: 1, metadata: 1 } })
    .toArray()
  const titleById = new Map<string, string>()
  for (const f of files) {
    titleById.set(f._id.toString(), f.metadata?.title ?? f.filename ?? 'Untitled video')
  }

  const blocks: string[] = []
  let count = 0

  // Notes (three sources each).
  const notes = await (await getNotesCollection()).find(videoId ? { videoId } : {}).toArray()
  for (const note of notes) {
    const vTitle = titleById.get(note.videoId) ?? 'Untitled video'
    for (const { source, field } of NOTE_SOURCES) {
      const value = note[field]
      if (typeof value === 'string' && value.trim()) {
        blocks.push(`[${source} | video=${vTitle}] ${value.trim()}`)
        count++
      }
    }
  }

  // Transcripts (one block per video, capped).
  const transcripts = await (await getTranscriptsCollection()).find(videoId ? { videoId } : {}).toArray()
  for (const t of transcripts) {
    const vTitle = titleById.get(t.videoId) ?? 'Untitled video'
    const full = (t.segments ?? []).map((s) => s.text?.trim()).filter(Boolean).join(' ')
    if (full) {
      blocks.push(`[transcript | video=${vTitle}] ${full.slice(0, MAX_TRANSCRIPT_CHARS)}`)
      count++
    }
  }

  const title = videoId ? (titleById.get(videoId) ?? 'Untitled video') : 'all videos'
  return { videoId, title, text: blocks.join('\n\n'), count }
}
