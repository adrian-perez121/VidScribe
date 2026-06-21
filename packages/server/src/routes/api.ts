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

// Required to run real Browserbase/Gemini research. Checked up front so a
// missing key surfaces as a clear error, not an uncaught throw mid-request.
const RESEARCH_ENV_VARS = ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GEMINI_API_KEY']

// Research a chunk of transcript: filter to keywords, search the web via
// Browserbase/Stagehand, and return one combined summary plus its source links.
// Note: this spins up a remote browser session, so it can take a while.
api.post('/research', async (c) => {
  const body = await c.req.json<ResearchRequest>().catch(() => null)
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    return c.json({ error: 'Body must be { text: string }' }, 400)
  }
  const text = body.text

  if (process.env.MOCK_BROWSERBASE === 'true') {
    const response: ResearchResponse = {
      keywords: ['mock', 'research', 'topic'],
      summary:
        'Mock research summary: this is a placeholder explanation standing in for the real Browserbase-researched summary.',
      links: ['https://example.com/mock-source-1', 'https://example.com/mock-source-2'],
    }
    return c.json(response)
  }

  const missingVar = RESEARCH_ENV_VARS.find((name) => !process.env[name])
  if (missingVar) {
    return c.json(
      {
        error: `Missing ${missingVar}. Add it to packages/server/.env or set MOCK_BROWSERBASE=true for local testing.`,
      },
      500,
    )
  }

  try {
    const { keywords, summary, links } = await researchTopic(text)
    const response: ResearchResponse = { keywords, summary, links }
    return c.json(response)
  } catch (err) {
    console.error('Research request failed:', err)
    return c.json({ error: 'Research request failed. Check server logs for details.' }, 502)
  }
})
api.route('/explain', explainRoute)
api.route('/deepgram', deepgramRoute)
