import { Hono } from 'hono'
import type { VidscribeNote } from '@vid-mark/shared'
import { getNotesCollection } from '../../lib/mongo.js'
import { cacheDeleteByPattern } from '../../lib/cache.js'

// Study guides are built live from notes, so any note change invalidates the
// cached guides. Best-effort (cache helpers swallow their own errors).
const bustGuideCache = () => cacheDeleteByPattern('cache:guide:*')

// Notes persistence in MongoDB. This is ADDITIVE to the frontend's in-memory /
// localStorage store — the client keeps working exactly as before, and also
// mirrors each note here so that pulling a video pulls its notes back.
//
// One document per note, keyed by the note's own id (_id === note.id), so an
// upsert is idempotent and updates (e.g. an added AI explanation) just overwrite.

export const notesRoute = new Hono()

// POST /api/notes — create or update a single note (upsert by id).
notesRoute.post('/', async (c) => {
  const note = await c.req.json<VidscribeNote>().catch(() => null)
  if (
    !note ||
    typeof note.id !== 'string' ||
    typeof note.videoId !== 'string' ||
    typeof note.text !== 'string'
  ) {
    return c.json({ error: 'Body must be a note with id, videoId, and text' }, 400)
  }

  // On upsert the _id comes from the filter, so the replacement is just the
  // note (the collection's _id is the note's id).
  const col = await getNotesCollection()
  await col.replaceOne({ _id: note.id }, note, { upsert: true })
  await bustGuideCache()
  return c.json({ ok: true })
})

// DELETE /api/notes/:id — remove a note.
notesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const col = await getNotesCollection()
  await col.deleteOne({ _id: id })
  await bustGuideCache()
  return c.json({ ok: true })
})
