import 'dotenv/config'
import { Stagehand } from '@browserbasehq/stagehand'

// Server-side only. Stagehand is NOT a long-lived singleton like the Prisma
// client: each task creates an instance, init()s it (which spins up a remote
// Browserbase session), runs act()/extract(), then close()s it. So this module
// exports a factory, not a shared instance.

// Model Stagehand uses to drive act()/extract(). Format is "provider/model".
// gemini-3-flash-preview is a fast/cheap default for per-action browser steps;
// switch to "anthropic/claude-sonnet-4-6" (and set ANTHROPIC_API_KEY) for harder
// extraction. Whichever provider you pick, set the matching key in .env.
const STAGEHAND_MODEL = 'google/gemini-3-flash-preview'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set (see .env / .env.sample)`)
  }
  return value
}

/**
 * Create a Stagehand instance wired to Browserbase + Claude.
 * Caller is responsible for `await sh.init()` before use and `await sh.close()`
 * when done (ideally in a try/finally).
 */
export function createStagehand(): Stagehand {
  return new Stagehand({
    env: 'BROWSERBASE',
    apiKey: requireEnv('BROWSERBASE_API_KEY'),
    model: STAGEHAND_MODEL,
  })
}
