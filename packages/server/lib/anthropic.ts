import Anthropic from '@anthropic-ai/sdk'

// Small shared Anthropic helpers. The client is created lazily so importing this
// module doesn't require ANTHROPIC_API_KEY at import time.

let _client: Anthropic | null = null
export function anthropic(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  return _client
}

/** Concatenate the text blocks of a Claude response (guards the union type). */
export function textFrom(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Parse JSON out of a model response, tolerating ```json fences or surrounding
 * prose by slicing from the first `{` to the last `}`. Throws if it can't parse.
 */
export function extractJson<T>(text: string): T {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text
  return JSON.parse(slice) as T
}
