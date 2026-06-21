import { Hono } from 'hono'
import type {
  HealthResponse,
  ResearchRequest,
  ResearchResponse,
} from '@vid-mark/shared'
import { researchTopic } from '../../lib/research.js'
import { explainRoute } from './explain.js'
import { deepgramRoute } from './deepgram.js'

export const api = new Hono()

api.get('/health', (c) => {
  const body: HealthResponse = {
    status: 'ok',
    time: new Date().toISOString(),
  }
  return c.json(body)
})

// Research a chunk of transcript: filter to keywords, search the web via
// Browserbase/Stagehand, and return one combined summary plus its source links.
// Note: this spins up a remote browser session, so it can take a while.
api.post('/research', async (c) => {
  const body = await c.req.json<ResearchRequest>().catch(() => null)
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return c.json({ error: 'Body must be { text: string }' }, 400)
  }

  const { keywords, summary, links } = await researchTopic(body.text)
  const response: ResearchResponse = { keywords, summary, links }
  return c.json(response)
})
api.route('/explain', explainRoute)
api.route('/deepgram', deepgramRoute)
