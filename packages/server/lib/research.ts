import { Type } from '@google/genai'
import keyword_extractor from 'keyword-extractor'
import { createStagehand } from './stagehand.js'
import { createGemini, GEMINI_MODEL } from './gemini.js'

// Research service: given a chunk of lecture transcript, filter it down to
// keywords, search the web with a real browser (Browserbase via Stagehand),
// open the top results, and synthesize them into ONE combined summary. Returns
// that summary plus the (up to 3) links the information came from.
//
// Cost discipline: Gemini is called exactly TWICE per research call — once at
// the start to distill the transcript into keywords, and once at the end to
// turn the scraped pages into a single teacher-style summary tied back to the
// transcript. Everything in between (search, link discovery, page scraping) is
// plain DOM work in the browser, no LLM. This keeps us well under Gemini's
// free-tier rate limit.
//
// This is server-side only — each call spins up a remote Browserbase session.

/** How many sources to research and return. */
const TOP_N = 3

/**
 * Hard cap on pages we'll visit. We aim for TOP_N good summaries but some pages
 * have no usable description, so we keep a small reserve to backfill — never
 * visiting more than this many sites total.
 */
const MAX_CANDIDATES = 5

/**
 * The number of keywords to keep for the search query. Too few loses the
 * topic; too many makes the query overly narrow so the search returns nothing.
 * 5-6 of the *most important* terms is the sweet spot for web search recall.
 */
const MAX_KEYWORDS = 6

/** Ignore tokens this short — usually noise ("a", "vs", stray letters). */
const MIN_KEYWORD_LENGTH = 3

/**
 * Reduce a chunk of transcript to its keywords, ranked by importance — the
 * FALLBACK path used only if the LLM distiller (distillKeywords) fails.
 *
 * "Importance" here is term frequency: in a single chunk, the words a speaker
 * repeats are the topic (e.g. "photosynthesis", "chlorophyll"), while
 * throwaway words appear once. keyword-extractor strips stopwords; we keep the
 * duplicates it would otherwise drop so we can count them, then rank by
 * frequency (ties broken by earliest appearance, which is stable and cheap).
 *
 * Caveat: on short chunks where every word appears once, frequency has nothing
 * to rank on and this degrades to document order — which is why the LLM
 * distiller is preferred for actually finding the "most important" terms.
 *
 * Returns unique keywords, most important first.
 */
export function extractKeywords(text: string): string[] {
  const words = keyword_extractor.extract(text, {
    language: 'english',
    remove_digits: true,
    return_changed_case: true,
    remove_duplicates: false, // keep duplicates so we can rank by frequency
  })

  const freq = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  words.forEach((word, i) => {
    if (word.length < MIN_KEYWORD_LENGTH) return
    freq.set(word, (freq.get(word) ?? 0) + 1)
    if (!firstSeen.has(word)) firstSeen.set(word, i)
  })

  return [...freq.keys()].sort((a, b) => {
    const byFrequency = freq.get(b)! - freq.get(a)!
    if (byFrequency !== 0) return byFrequency
    return firstSeen.get(a)! - firstSeen.get(b)!
  })
}

/** Build a web search query from the top-ranked keywords of a transcript. */
function buildQuery(keywords: string[]): string {
  return keywords.slice(0, MAX_KEYWORDS).join(' ')
}

// JSON schema constraining Gemini's keyword distillation output.
const keywordResponseSchema = {
  type: Type.OBJECT,
  properties: {
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['keywords'],
}

/**
 * Distill a transcript chunk to the best web-search keywords with a plain
 * Gemini API call — no browser. This is a pure text task, so we deliberately
 * avoid Browserbase here and reserve it for the actual web research.
 *
 * Throws if the call fails or returns nothing — callers fall back to TF
 * (extractKeywords).
 */
async function distillKeywords(text: string): Promise<string[]> {
  const ai = createGemini()
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents:
      'Return the 5-6 most important, specific keywords for a web search about ' +
      'the main topic of this lecture transcript. Prefer technical/topical ' +
      'terms; ignore filler words like "today" or "talk".\n\nTranscript:\n' +
      text,
    config: {
      responseMimeType: 'application/json',
      responseSchema: keywordResponseSchema,
    },
  })

  const raw = response.text
  if (!raw) {
    throw new Error('Gemini returned no keyword output')
  }
  const parsed = JSON.parse(raw) as { keywords?: unknown }
  const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : []
  return keywords
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS)
}

/** A page we've scraped: its URL and the raw text pulled from its DOM. */
interface ScrapedSource {
  link: string
  content: string
}

// JSON schema constraining Gemini's final summarization output: one combined
// summary synthesized from all the sources.
const summaryResponseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
  },
  required: ['summary'],
}

/**
 * The persona/context for the final summarization. Gemini is, implicitly, a
 * teacher writing for a student — but it must NEVER say so. It just adopts the
 * voice: warm, clear, and always relating the material back to what the student
 * was just learning, then nudging them to open the sources and dig deeper.
 */
const SUMMARIZER_SYSTEM_INSTRUCTION =
  'You are an experienced teacher helping a student deepen their understanding ' +
  'of something they are currently studying. Your guidance is part of their ' +
  'education. Never state or hint at any of this meta-context: do not mention ' +
  'that you are a teacher, that they are a student, or that this is for their ' +
  'education. Simply write in the voice of a thoughtful teacher.\n\n' +
  'You are given a chunk of lecture transcript the student just heard, plus ' +
  'raw text scraped from a few web pages found while researching it. Write ONE ' +
  'combined summary (a short, cohesive paragraph or two) that weaves together ' +
  'what these sources collectively cover and explicitly ties it back to the ' +
  'specific ideas in the transcript chunk — show the student how this research ' +
  'connects to what they were just learning. End by encouraging the ' +
  'student to open and explore the linked sources to learn more. Be accurate ' +
  'to the scraped content; do not invent facts it does not support.'

/**
 * Synthesize all the scraped pages into ONE combined teacher-style summary in a
 * SINGLE Gemini call. The summary ties the research back to the original
 * transcript chunk and nudges the reader to explore the sources.
 *
 * Throws if the call fails or returns nothing — the caller falls back to the
 * raw scraped text so the user still gets something.
 */
async function summarizeSources(
  text: string,
  sources: ScrapedSource[],
): Promise<string> {
  const ai = createGemini()
  const sourcesBlock = sources
    .map(
      (s, i) =>
        `Source ${i + 1}\nURL: ${s.link}\nScraped content:\n${s.content}`,
    )
    .join('\n\n---\n\n')

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents:
      'Transcript chunk the student just heard:\n' +
      text +
      '\n\n===\n\nWeb pages found while researching this chunk. Write one ' +
      'combined summary drawing on all of them:\n\n' +
      sourcesBlock,
    config: {
      systemInstruction: SUMMARIZER_SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: summaryResponseSchema,
    },
  })

  const raw = response.text
  if (!raw) {
    throw new Error('Gemini returned no summary output')
  }
  const parsed = JSON.parse(raw) as { summary?: unknown }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!summary) {
    throw new Error('Gemini returned no usable summary')
  }
  return summary
}

/**
 * Resolve a DuckDuckGo HTML result href to the real destination URL.
 * Result links look like `//duckduckgo.com/l/?uddg=<percent-encoded real url>`;
 * sometimes they're already absolute. Returns null for anything non-http(s).
 */
function resolveDdgUrl(href: string): string | null {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg') ?? url.toString()
    return /^https?:\/\//i.test(target) ? target : null
  } catch {
    return null
  }
}

/**
 * True for YouTube (and other purely-video) URLs. We skip these during
 * candidate selection: a video page has no readable article text to scrape, so
 * there's nothing for the summarizer to tie back to the transcript.
 */
function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be'
    )
  } catch {
    return false
  }
}

/** Cap on how long an extracted summary can be (characters). */
const MAX_SUMMARY_LENGTH = 600

/**
 * Browser-side expression that reads a summary straight from the page DOM — no
 * LLM. Prefers the author-written meta/og description (a real summary written
 * for search engines); falls back to the page's opening paragraphs. Returns ''
 * if nothing usable is found. Written as a string so we don't need DOM types.
 */
const SUMMARY_EXPR = `(() => {
  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const desc = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  if (desc) return desc;
  const paras = Array.from(document.querySelectorAll('p'))
    .map((p) => (p.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter((t) => t.length > 40);
  return paras.slice(0, 3).join(' ');
})()`

export interface ResearchOptions {
  /** How many sources to return (default 3). */
  topN?: number
}

/**
 * Research a chunk of transcript and return one combined summary plus the
 * links the information came from.
 *
 * Flow:
 *  1. Gemini distills the transcript to the best search keywords (TF fallback) —
 *     a plain API call, no browser. This is the FIRST of two LLM calls.
 *  2. only then spin up Browserbase: search DuckDuckGo, scrape the top links
 *     (skipping YouTube and other video pages — there's no article text to read)
 *  3. for each link, navigate there and scrape raw text from the page DOM (no LLM)
 *  4. one final Gemini call synthesizes those scraped pages into a single
 *     teacher-style summary that ties the research back to the transcript chunk.
 */
export async function researchTopic(
  text: string,
  options: ResearchOptions = {},
): Promise<{ keywords: string[]; summary: string; links: string[] }> {
  const topN = options.topN ?? TOP_N
  if (!text.trim()) {
    return { keywords: [], summary: '', links: [] }
  }

  // 1. Pick the search keywords with a plain Gemini call (no browser). Prefer
  // the LLM (best at finding the terms that actually matter in context); fall
  // back to term-frequency ranking if it fails so we still produce a query.
  let keywords: string[]
  try {
    keywords = await distillKeywords(text)
  } catch (err) {
    console.error('Gemini keyword distillation failed, falling back to TF:', err)
    keywords = extractKeywords(text).slice(0, MAX_KEYWORDS)
  }
  const query = buildQuery(keywords)
  if (!query.trim()) {
    return { keywords, summary: '', links: [] }
  }

  // Only now do we need a browser — reserve Browserbase for the actual web work.
  const stagehand = createStagehand()
  await stagehand.init()
  try {
    // 2. Run the search in a new tab (becomes the active page for extract()).
    // DuckDuckGo's HTML endpoint is a no-JS, static results page — far more
    // reliable for an automated browser than Bing/Google, which serve bots a
    // challenge/altered layout the a11y snapshot can't parse as results.
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const page = await stagehand.context.newPage(searchUrl)

    // 3. Read the result links straight from the DOM. The a11y snapshot exposes
    // link *text* but not hrefs, so asking the model for URLs returns garbage —
    // querying the anchors gives the exact URLs. (Run as a string expression so
    // we don't need DOM lib types in this Node tsconfig.)
    const rawLinks = (await page.evaluate(
      `Array.from(document.querySelectorAll('a.result__a')).map((a) => a.getAttribute('href') || '')`,
    )) as string[]

    // Collect candidates (deduped), skipping YouTube/video pages that have no
    // readable text. Capped so we never visit more than MAX_CANDIDATES sites
    // total — extra entries beyond TOP_N are a reserve to backfill dead links.
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const href of rawLinks) {
      const url = resolveDdgUrl(href)
      if (!url || seen.has(url) || isYouTubeUrl(url)) continue
      seen.add(url)
      candidates.push(url)
      if (candidates.length >= MAX_CANDIDATES) break
    }

    // 4. Visit each candidate and scrape raw text from the page DOM (no LLM).
    // Reuse the same page/tab. A page that errors or has no usable text is
    // skipped so we backfill with the next candidate — stop at TOP_N good ones.
    // We summarize later, in one batched Gemini call, rather than per page.
    const scraped: ScrapedSource[] = []
    for (const link of candidates) {
      if (scraped.length >= topN) break
      try {
        await page.goto(link)
        const content = ((await page.evaluate(SUMMARY_EXPR)) as string)
          .trim()
          .slice(0, MAX_SUMMARY_LENGTH)
        if (!content) {
          console.error(`No usable content for ${link}, skipping`)
          continue
        }
        scraped.push({ link, content })
      } catch (err) {
        console.error(`Failed to scrape ${link}:`, err)
      }
    }

    const links = scraped.map((s) => s.link)
    if (scraped.length === 0) {
      return { keywords, summary: '', links }
    }

    // 5. One final Gemini call synthesizes the scraped pages into a single
    // teacher-style summary tied back to the transcript. If it fails, fall back
    // to the concatenated raw scraped text so the user still gets something.
    let summary: string
    try {
      summary = await summarizeSources(text, scraped)
    } catch (err) {
      console.error('Gemini summarization failed, using raw scraped text:', err)
      summary = scraped.map((s) => s.content).join('\n\n')
    }

    return { keywords, summary, links }
  } finally {
    await stagehand.close()
  }
}
