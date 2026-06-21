import type { StudyGuide } from '@vid-mark/shared'
import { anthropic, textFrom, extractJson } from './anthropic.js'
import { collectContent } from './contentCollector.js'
import { cacheGet, cacheSet } from './cache.js'

// Generate a study guide on demand from a video's (or the whole library's)
// notes, lens explanations, research summaries, and transcript. The result is
// cached in Redis by scope (busted when a note changes / on re-ingest, with a
// TTL backstop) so repeat requests skip the Claude call.

const GUIDE_TTL_SECONDS = 60 * 60 // 1 hour
const guideCacheKey = (videoId?: string) => `cache:guide:${videoId ?? 'all'}`

const SYSTEM_PROMPT = `You are a study assistant. You are given a student's collected study material for one or more lecture videos: their notes, AI explanations, web-research summaries, and the lecture transcript, each labeled with its source and video.

Produce a concise, well-organized study guide that helps them revise. Base it STRICTLY on the provided material — do not invent facts. Organize it into themed sections.

Respond with ONLY valid JSON in exactly this shape, no prose, no markdown fences:
{
  "overview": "a 2-4 sentence summary of what the material covers",
  "sections": [
    { "heading": "section title", "points": ["key fact or concept", "..."] }
  ]
}
Use 3 to 7 sections, each with 2 to 6 concise points.`

interface RawGuide {
  overview?: string
  sections?: { heading?: string; points?: string[] }[]
}

/**
 * Returns null when there's no material to build from. Pass `{ refresh: true }`
 * to bypass the cache and regenerate (the "Regenerate" button), overwriting the
 * cached copy with the fresh one.
 */
export async function generateStudyGuide(
  videoId?: string,
  opts: { refresh?: boolean } = {},
): Promise<StudyGuide | null> {
  const cacheKey = guideCacheKey(videoId)
  if (!opts.refresh) {
    const cached = await cacheGet<StudyGuide>(cacheKey)
    if (cached) {
      console.log(`[cache] study guide HIT ${cacheKey}`)
      return cached
    }
    console.log(`[cache] study guide MISS ${cacheKey}`)
  } else {
    console.log(`[cache] study guide REFRESH (bypass) ${cacheKey}`)
  }

  const content = await collectContent(videoId)
  if (content.count === 0) return null

  const msg = await anthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Study material:\n\n${content.text}\n\nCreate the study guide.` }],
  })

  const raw = extractJson<RawGuide>(textFrom(msg))
  const sections = (raw.sections ?? [])
    .filter((s) => s && typeof s.heading === 'string' && Array.isArray(s.points))
    .map((s) => ({
      heading: s.heading as string,
      points: (s.points ?? []).filter((p): p is string => typeof p === 'string' && p.trim() !== ''),
    }))

  const guide: StudyGuide = {
    title: videoId ? `Study guide: ${content.title}` : 'Study guide: all videos',
    overview: typeof raw.overview === 'string' ? raw.overview : '',
    sections,
    videoId,
  }
  await cacheSet(cacheKey, guide, GUIDE_TTL_SECONDS)
  return guide
}
