import { Hono } from 'hono'
import Busboy from 'busboy'
import { Readable } from 'node:stream'
import { ObjectId, type GridFSBucketWriteStream } from 'mongodb'
import type { HttpBindings } from '@hono/node-server'
import type {
  VideoSummary,
  VideoDetail,
  VideoListResponse,
  VidscribeNote,
  VideoTranscript,
  TranscriptSegment,
} from '@vid-mark/shared'
import {
  getDb,
  getVideoBucket,
  getNotesCollection,
  getTranscriptsCollection,
  VIDEO_BUCKET,
} from '../../lib/mongo.js'
import { createDeepgramClient } from '../../lib/deepgram.js'

// Video routes: upload (streamed into GridFS), list (metadata + thumbnail only),
// detail (metadata + the notes taken on that video), and range-aware streaming
// playback. The dashboard never loads video bytes — only the list endpoint,
// which returns just metadata and the small thumbnail.

export const videosRoute = new Hono<{ Bindings: HttpBindings }>()

/** Browser-playable formats we accept, mapped to a fallback extension. */
const ALLOWED_TYPES = new Map<string, string>([
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
])

/** The GridFS files collection (where video metadata lives). */
const FILES_COLLECTION = `${VIDEO_BUCKET}.files`

/** Shape of a GridFS files document we care about. */
interface VideoFileDoc {
  _id: ObjectId
  filename?: string
  length?: number
  uploadDate?: Date
  contentType?: string
  metadata?: {
    title?: string
    thumbnailDataUrl?: string | null
    durationSec?: number
    contentType?: string
  }
}

/** Build the public VideoSummary shape from a GridFS files document. */
function toSummary(doc: VideoFileDoc): VideoSummary {
  const meta = doc.metadata ?? {}
  return {
    id: doc._id.toString(),
    title: meta.title ?? doc.filename ?? 'Untitled video',
    thumbnailDataUrl: meta.thumbnailDataUrl ?? null,
    contentType: meta.contentType ?? doc.contentType ?? 'video/mp4',
    sizeBytes: doc.length ?? 0,
    durationSec: meta.durationSec,
    createdAt: (doc.uploadDate ?? new Date()).toISOString(),
  }
}

/** Parse an :id param into an ObjectId, or null if malformed. */
function toObjectId(id: string): ObjectId | null {
  try {
    return new ObjectId(id)
  } catch {
    return null
  }
}

// GET /api/videos — list all videos (metadata + thumbnail, never the bytes).
videosRoute.get('/', async (c) => {
  const db = await getDb()
  const docs = (await db
    .collection<VideoFileDoc>(FILES_COLLECTION)
    .find({})
    .sort({ uploadDate: -1 })
    .toArray()) as VideoFileDoc[]
  const body: VideoListResponse = { videos: docs.map(toSummary) }
  return c.json(body)
})

// GET /api/videos/:id/stream — stream the video bytes with HTTP Range support
// so the browser can seek without downloading the whole file.
videosRoute.get('/:id/stream', async (c) => {
  const _id = toObjectId(c.req.param('id'))
  if (!_id) return c.json({ error: 'Invalid video id' }, 400)

  const db = await getDb()
  const doc = await db.collection<VideoFileDoc>(FILES_COLLECTION).findOne({ _id })
  if (!doc) return c.json({ error: 'Video not found' }, 404)

  const bucket = await getVideoBucket()
  const size = doc.length ?? 0
  const contentType = doc.metadata?.contentType ?? doc.contentType ?? 'video/mp4'
  const range = c.req.header('range')

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    let start = match && match[1] ? parseInt(match[1], 10) : 0
    let end = match && match[2] ? parseInt(match[2], 10) : size - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= size) end = size - 1
    if (start > end) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
    // GridFS `end` is exclusive, so +1 to include the byte at `end`.
    const stream = bucket.openDownloadStream(_id, { start, end: end + 1 })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    })
  }

  const stream = bucket.openDownloadStream(_id)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
    },
  })
})

// GET /api/videos/:id — one video's metadata plus the notes taken on it.
videosRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  const _id = toObjectId(id)
  if (!_id) return c.json({ error: 'Invalid video id' }, 400)

  const db = await getDb()
  const doc = await db.collection<VideoFileDoc>(FILES_COLLECTION).findOne({ _id })
  if (!doc) return c.json({ error: 'Video not found' }, 404)

  const notesCol = await getNotesCollection()
  const noteDocs = await notesCol
    .find({ videoId: id })
    .sort({ timestampSec: 1 })
    .toArray()
  const notes: VidscribeNote[] = noteDocs.map(({ _id: _drop, ...note }) => note)

  const detail: VideoDetail = { ...toSummary(doc), notes }
  return c.json(detail)
})

/** A short, realistic mock transcript used when MOCK_DEEPGRAM=true. */
function buildMockTranscript(videoId: string): VideoTranscript {
  const segments: TranscriptSegment[] = [
    { startSec: 0, endSec: 4.2, text: 'Welcome back to the lecture on cell physiology.' },
    { startSec: 4.2, endSec: 9.8, text: 'Today we are going to look at how the cell membrane controls what moves in and out of the cell.' },
    { startSec: 9.8, endSec: 16.5, text: 'Pay close attention to the ion channels highlighted in this next diagram.' },
  ]
  return {
    videoId,
    segments,
    model: 'mock',
    createdAt: new Date().toISOString(),
  }
}

// POST /api/videos/:id/transcript — transcribe the video once via Deepgram and
// store the result. The GridFS download stream is piped directly into the
// Deepgram SDK (it accepts a Node Readable), so the video is never buffered
// fully in memory. Re-running this replaces (upserts) the stored transcript.
videosRoute.post('/:id/transcript', async (c) => {
  const id = c.req.param('id')
  const _id = toObjectId(id)
  if (!_id) return c.json({ error: 'Invalid video id' }, 400)

  const db = await getDb()
  const doc = await db.collection<VideoFileDoc>(FILES_COLLECTION).findOne({ _id })
  if (!doc) return c.json({ error: 'Video not found' }, 404)

  const transcriptsCol = await getTranscriptsCollection()

  if (process.env.MOCK_DEEPGRAM === 'true') {
    const transcript = buildMockTranscript(id)
    await transcriptsCol.replaceOne({ _id: id }, transcript, { upsert: true })
    return c.json(transcript)
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    return c.json({ error: 'Missing DEEPGRAM_API_KEY. Add it to packages/server/.env.' }, 500)
  }

  try {
    const bucket = await getVideoBucket()
    const videoStream = bucket.openDownloadStream(_id)

    const client = createDeepgramClient()
    const response = await client.listen.v1.media.transcribeFile(videoStream, {
      model: 'nova-3',
      utterances: true,
    })

    const utterances = 'results' in response ? response.results?.utterances : undefined
    const segments: TranscriptSegment[] = (utterances ?? [])
      .filter((u) => typeof u.start === 'number' && typeof u.end === 'number' && u.transcript)
      .map((u) => ({ startSec: u.start as number, endSec: u.end as number, text: u.transcript as string }))

    if (segments.length === 0) {
      return c.json({ error: 'Deepgram returned no transcript for this video' }, 502)
    }

    const transcript: VideoTranscript = {
      videoId: id,
      segments,
      model: 'nova-3',
      createdAt: new Date().toISOString(),
    }
    await transcriptsCol.replaceOne({ _id: id }, transcript, { upsert: true })
    return c.json(transcript)
  } catch (err) {
    console.error('Deepgram transcription error:', err)
    return c.json(
      {
        error:
          'Deepgram request failed or timed out. Check internet connection, API key, or set MOCK_DEEPGRAM=true for local demo testing.',
      },
      502,
    )
  }
})

// GET /api/videos/:id/transcript — return a previously generated transcript.
videosRoute.get('/:id/transcript', async (c) => {
  const id = c.req.param('id')
  if (!toObjectId(id)) return c.json({ error: 'Invalid video id' }, 400)

  const transcriptsCol = await getTranscriptsCollection()
  const doc = await transcriptsCol.findOne({ _id: id })
  if (!doc) {
    return c.json({ error: 'No transcript exists yet for this video' }, 404)
  }

  const { _id: _drop, ...transcript } = doc
  return c.json(transcript satisfies VideoTranscript)
})

// DELETE /api/videos/:id — remove a video and ALL of its notes from Mongo
// (the GridFS file bytes + every note with this videoId). Idempotent: a
// missing file is treated as already-deleted.
videosRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const _id = toObjectId(id)
  if (!_id) return c.json({ error: 'Invalid video id' }, 400)

  // Remove the notes and transcript first so we never leave orphaned data behind.
  const notesCol = await getNotesCollection()
  const { deletedCount } = await notesCol.deleteMany({ videoId: id })

  const transcriptsCol = await getTranscriptsCollection()
  await transcriptsCol.deleteOne({ _id: id })

  // Then drop the GridFS file (chunks + files doc). delete() throws if the
  // file is already gone — treat that as success so the call is idempotent.
  const bucket = await getVideoBucket()
  try {
    await bucket.delete(_id)
  } catch (err) {
    console.error(`GridFS delete for ${id} (already gone?):`, err)
  }

  return c.json({ ok: true, deletedNotes: deletedCount })
})

// POST /api/videos — upload a video. The multipart body is streamed straight
// into GridFS via busboy so we never buffer the whole (potentially huge) file
// in memory. Expects fields: title, durationSec, thumbnail (data URL), and the
// video file under "video" — sent BEFORE the file so we have them when the
// file stream opens.
videosRoute.post('/', async (c) => {
  const incoming = c.env.incoming
  const contentType = incoming.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    return c.json({ error: 'Expected multipart/form-data' }, 400)
  }

  type UploadResult =
    | { ok: true; id: string }
    | { ok: false; status: 400 | 415 | 500; error: string }

  const result = await new Promise<UploadResult>((resolve) => {
    let title = ''
    let thumbnailDataUrl = ''
    let durationSec: number | undefined
    let uploadStream: GridFSBucketWriteStream | null = null
    let fileHandled = false
    let settled = false
    const done = (r: UploadResult) => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }

    let bb: ReturnType<typeof Busboy>
    try {
      bb = Busboy({ headers: incoming.headers, limits: { files: 1 } })
    } catch {
      done({ ok: false, status: 400, error: 'Invalid upload' })
      return
    }

    bb.on('field', (name, value) => {
      if (name === 'title') title = value
      else if (name === 'thumbnail') thumbnailDataUrl = value
      else if (name === 'durationSec') {
        const n = Number(value)
        if (Number.isFinite(n) && n > 0) durationSec = n
      }
    })

    bb.on('file', (_name, fileStream, info) => {
      const mime = info.mimeType
      const ext = ALLOWED_TYPES.get(mime)
      if (!ext) {
        fileStream.resume() // drain so the request can finish
        done({
          ok: false,
          status: 415,
          error: `Unsupported video type "${mime}". Please upload an MP4 or WebM file.`,
        })
        return
      }
      fileHandled = true
      const filename = info.filename || `video.${ext}`
      void getVideoBucket()
        .then((bucket) => {
          uploadStream = bucket.openUploadStream(filename, {
            metadata: {
              title: title.trim() || filename,
              thumbnailDataUrl: thumbnailDataUrl || null,
              durationSec,
              contentType: mime,
            },
          })
          uploadStream.on('error', (err) => {
            console.error('GridFS upload error:', err)
            done({ ok: false, status: 500, error: 'Failed to store video' })
          })
          uploadStream.on('finish', () => {
            done({ ok: true, id: uploadStream!.id.toString() })
          })
          fileStream.pipe(uploadStream)
        })
        .catch((err) => {
          console.error('Mongo connection error during upload:', err)
          done({ ok: false, status: 500, error: 'Failed to store video' })
        })
    })

    bb.on('close', () => {
      if (!fileHandled) {
        done({ ok: false, status: 400, error: 'No video file in upload (field "video")' })
      }
    })
    bb.on('error', (err: unknown) => {
      console.error('Upload parse error:', err)
      done({ ok: false, status: 400, error: 'Upload failed' })
    })

    incoming.pipe(bb)
  })

  if (!result.ok) {
    return c.json({ error: result.error }, result.status)
  }

  // Re-read the stored file document so the response has accurate size/date.
  const db = await getDb()
  const doc = await db
    .collection<VideoFileDoc>(FILES_COLLECTION)
    .findOne({ _id: new ObjectId(result.id) })
  if (!doc) {
    return c.json({ error: 'Upload finished but video was not found' }, 500)
  }
  return c.json(toSummary(doc), 201)
})
