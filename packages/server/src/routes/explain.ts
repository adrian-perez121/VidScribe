import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { Hono } from 'hono'

const client = new Anthropic()

export const explainRoute = new Hono()

// TODO: Add authentication middleware here
// TODO: Add rate limiting middleware here

explainRoute.post('/', async (c) => {
  const body = await c.req.parseBody()

  const imageFile = body['image']
  const prompt = body['prompt']

  if (!imageFile || typeof imageFile === 'string') {
    return c.json({ error: 'Missing required field: image (must be a file)' }, 400)
  }

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return c.json({ error: 'Missing required field: prompt' }, 400)
  }

  const userPrompt = prompt.trim()

  const imageBuffer = Buffer.from(await imageFile.arrayBuffer())
  const resizedBuffer = await sharp(imageBuffer)
    .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()

  const base64Image = resizedBuffer.toString('base64')

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `A user has shared a cropped screenshot from a YouTube video and is asking: "${userPrompt}"

Please explain what's shown in the screenshot in clear, plain language. Focus on directly answering the question.

If any part of the image appears to be cut off — such as axis labels, on-screen definitions, or terms that appear to have been introduced before this frame — please say so explicitly rather than guessing at incomplete information.`,
            },
          ],
        },
      ],
    })

    const explanation = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    return c.json({ explanation })
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return c.json({ error: 'Rate limited — please try again in a moment' }, 429)
    }
    if (err instanceof Anthropic.BadRequestError) {
      return c.json({ error: 'The image or request was rejected by the AI model' }, 400)
    }
    console.error('Claude API error:', err)
    return c.json({ error: 'An unexpected error occurred' }, 500)
  }
})
