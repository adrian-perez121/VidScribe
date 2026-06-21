import 'dotenv/config'
import { DeepgramClient } from '@deepgram/sdk'

// Server-side only. Mirrors lib/stagehand.ts's factory pattern: callers create
// a client per request rather than relying on a shared singleton at import time,
// so a missing API key surfaces as a normal request error, not a startup crash.

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set (see .env / .env.sample)`)
  }
  return value
}

/** Create a Deepgram client using DEEPGRAM_API_KEY from the server env. */
export function createDeepgramClient(): DeepgramClient {
  return new DeepgramClient({ apiKey: requireEnv('DEEPGRAM_API_KEY') })
}
