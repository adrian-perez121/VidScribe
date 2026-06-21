import 'dotenv/config'
import { createClient } from 'redis'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// Redis
const client = createClient({ url: process.env.REDIS_URL! })
client.on('error', (err) => console.error('Redis error:', err))
await client.connect()
await client.ping()
console.log('Redis: OK')
await client.disconnect()

// Embeddings
const r = await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'hello world' })
const dims = r.data[0].embedding.length
console.log(`embedding dims: ${dims}`)

// Claude
const resp = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 64,
  system: 'Reply in one sentence.',
  messages: [{ role: 'user', content: 'Say hello.' }],
})
const block = resp.content[0]
const answer = block.type === 'text' ? block.text : ''
console.log(`Claude: ${answer}`)
