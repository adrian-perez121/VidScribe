import { Hono } from 'hono'
import { generateStudyGuide } from '../../lib/studyGuide.js'

// POST /api/study-guide — generate a study guide on demand from the student's
// notes + transcript. Body: { video_id? } (omit for the whole library).

export const studyGuideRoute = new Hono()

studyGuideRoute.post('/', async (c) => {
  const body = await c.req.json<{ video_id?: unknown }>().catch(() => null)
  const videoId = typeof body?.video_id === 'string' && body.video_id ? body.video_id : undefined

  try {
    const guide = await generateStudyGuide(videoId)
    if (!guide) {
      return c.json({ error: 'No notes or transcript found to build a study guide from yet.' }, 404)
    }
    return c.json({ guide })
  } catch (err) {
    console.error('Study guide generation failed:', err)
    return c.json({ error: 'Failed to generate study guide. Check server logs for details.' }, 500)
  }
})
