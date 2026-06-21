import { Hono } from 'hono'
import { createDeepgramClient } from '../../lib/deepgram.js'

export const deepgramRoute = new Hono()

deepgramRoute.post('/voice-note', async (c) => {
  const body = await c.req.parseBody()
  const audioFile = body['audio']

  if (!audioFile || typeof audioFile === 'string') {
    return c.json({ error: 'Missing required field: audio (must be a file)' }, 400)
  }

  if (process.env.MOCK_DEEPGRAM === 'true') {
    return c.json({
      transcript: 'Mock voice note transcript: I want to remember this part of the lecture.',
    })
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    return c.json({ error: 'Missing DEEPGRAM_API_KEY. Add it to packages/server/.env.' }, 500)
  }

  const audioBuffer = Buffer.from(await audioFile.arrayBuffer())

  try {
    const client = createDeepgramClient()
    const response = await client.listen.v1.media.transcribeFile(audioBuffer, {
      model: 'nova-3',
    })

    const transcript =
      'results' in response
        ? response.results?.channels?.[0]?.alternatives?.[0]?.transcript
        : undefined

    if (!transcript) {
      return c.json({ error: 'Deepgram returned no transcript for this recording' }, 502)
    }

    return c.json({ transcript })
  } catch (err) {
    console.error('Deepgram API error:', err)
    return c.json(
      {
        error:
          'Deepgram request failed or timed out. Check internet connection, API key, or set MOCK_DEEPGRAM=true for local demo testing.',
      },
      502,
    )
  }
})
