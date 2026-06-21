import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'

// Server-side Gemini client for plain text-in/text-out LLM calls (e.g. keyword
// distillation). Use this instead of Browserbase/Stagehand whenever a task
// doesn't actually need a browser — spinning up a remote browser session is
// slow and metered, so reserve it for real web interaction.

/** Gemini model for cheap text tasks. Matches the family Stagehand drives. */
export const GEMINI_MODEL = 'gemini-3-flash-preview'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set (see .env / .env.sample)`)
  }
  return value
}

/** Create a Gemini client wired to GEMINI_API_KEY. */
export function createGemini(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') })
}
