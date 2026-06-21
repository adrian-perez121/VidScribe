import { Type } from '@google/genai'
import keyword_extractor from 'keyword-extractor'
import type { ResearchResult } from '@vid-mark/shared'
import { createStagehand } from './stagehand.js'
import { createGemini, GEMINI_MODEL } from './gemini.js'

// Research service: given a chunk of lecture transcript, filter it down to
// keywords, search the web with a real browser (Browserbase via Stagehand),
// open the top results, and summarize each. Returns up to 3 {link, summary}
// pairs the user should look at.
//
// Cost discipline: Gemini is called exactly ONCE per research call — to distill
// the transcript into keywords. Everything after that (search, link discovery,
// per-page summaries) is plain DOM scraping in the browser, no LLM. This keeps
// us well under Gemini's free-tier rate limit.
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
 * Research a chunk of transcript and return the top sources with summaries.
 *
 * Flow:
 *  1. Gemini distills the transcript to the best search keywords (TF fallback) —
 *     a plain API call, no browser. This is the ONLY LLM call.
 *  2. only then spin up Browserbase: search DuckDuckGo, scrape the top links
 *  3. for each link, navigate there and read a summary from the page DOM (no LLM)
 */
export async function researchTopic(
  text: string,
  options: ResearchOptions = {},
): Promise<{ keywords: string[]; results: ResearchResult[] }> {
  const topN = options.topN ?? TOP_N
  if (!text.trim()) {
    return { keywords: [], results: [] }
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
    return { keywords, results: [] }
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

    // Collect candidates (deduped), capped so we never visit more than MAX_CANDIDATES
    // sites total — extra entries beyond TOP_N are a reserve to backfill dead links.
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const href of rawLinks) {
      const url = resolveDdgUrl(href)
      if (!url || seen.has(url)) continue
      seen.add(url)
      candidates.push(url)
      if (candidates.length >= MAX_CANDIDATES) break
    }

    // 4. Visit each candidate and read a summary from the page DOM (no LLM).
    // Reuse the same page/tab. A page that errors or has no usable description
    // is skipped so we backfill with the next candidate — stop at TOP_N good ones.
    const results: ResearchResult[] = []
    for (const link of candidates) {
      if (results.length >= topN) break
      try {
        await page.goto(link)
        const summary = ((await page.evaluate(SUMMARY_EXPR)) as string)
          .trim()
          .slice(0, MAX_SUMMARY_LENGTH)
        if (!summary) {
          console.error(`No usable summary for ${link}, skipping`)
          continue
        }
        results.push({ link, summary })
      } catch (err) {
        console.error(`Failed to summarize ${link}:`, err)
      }
    }

    return { keywords, results }
  } finally {
    await stagehand.close()
  }
}
