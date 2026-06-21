import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import type { NoteDoc } from './mongo.js'
import { getDb, getNotesCollection, VIDEO_BUCKET } from './mongo.js'
import { generateStudyGuide } from './studyGuide.js'

// Builds .docx files (Word documents) straight from MongoDB — notes with their
// summaries + timestamps, and the generated study guide. Reads source data live
// from Mongo (no Redis), so exports always reflect the latest notes.

/** Format seconds as m:ss / h:mm:ss for note timestamps. */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** videoId -> title lookup from the GridFS files metadata. */
async function titleLookup(): Promise<Map<string, string>> {
  const db = await getDb()
  const files = await db
    .collection(`${VIDEO_BUCKET}.files`)
    .find({}, { projection: { filename: 1, metadata: 1 } })
    .toArray()
  const map = new Map<string, string>()
  for (const f of files) {
    map.set(f._id.toString(), f.metadata?.title ?? f.filename ?? 'Untitled video')
  }
  return map
}

function labeled(label: string, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(text)],
  })
}

/**
 * All notes (grouped by video, sorted by timestamp) with their note text, lens
 * explanation, and research summary + links. Scope to one video with `videoId`.
 */
export async function buildNotesDocx(videoId?: string): Promise<Buffer> {
  const notes = await (await getNotesCollection()).find(videoId ? { videoId } : {}).toArray()
  const titleById = await titleLookup()

  // Group by video so the document reads video-by-video.
  const byVideo = new Map<string, NoteDoc[]>()
  for (const n of notes) {
    const arr = byVideo.get(n.videoId) ?? []
    arr.push(n)
    byVideo.set(n.videoId, arr)
  }

  const children: Paragraph[] = [
    new Paragraph({
      text: videoId ? `Notes — ${titleById.get(videoId) ?? 'Untitled video'}` : 'All notes',
      heading: HeadingLevel.TITLE,
    }),
  ]

  if (notes.length === 0) {
    children.push(new Paragraph('No notes yet.'))
  }

  for (const [vid, vidNotes] of byVideo) {
    if (!videoId) {
      children.push(new Paragraph({ text: titleById.get(vid) ?? 'Untitled video', heading: HeadingLevel.HEADING_1 }))
    }
    vidNotes.sort((a, b) => (a.timestampSec ?? 0) - (b.timestampSec ?? 0))
    for (const note of vidNotes) {
      const ts = typeof note.timestampSec === 'number' ? formatTime(note.timestampSec) : ''
      const head = [ts, note.title].filter(Boolean).join(' — ') || 'Note'
      children.push(new Paragraph({ text: head, heading: HeadingLevel.HEADING_2 }))
      if (note.text?.trim()) children.push(labeled('Note', note.text.trim()))
      if (note.aiExplanation?.trim()) children.push(labeled('AI explanation', note.aiExplanation.trim()))
      if (note.researchSummary?.trim()) children.push(labeled('Research summary', note.researchSummary.trim()))
      if (note.researchLinks?.length) children.push(labeled('Sources', note.researchLinks.join('   ')))
    }
  }

  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}

/** The generated study guide as a .docx. Returns null when there's no material. */
export async function buildStudyGuideDocx(videoId?: string): Promise<Buffer | null> {
  const guide = await generateStudyGuide(videoId)
  if (!guide) return null

  const children: Paragraph[] = [new Paragraph({ text: guide.title, heading: HeadingLevel.TITLE })]
  if (guide.overview) children.push(new Paragraph({ text: guide.overview, spacing: { after: 160 } }))

  for (const section of guide.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }))
    for (const point of section.points) {
      children.push(new Paragraph({ text: point, bullet: { level: 0 } }))
    }
  }

  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc)
}
