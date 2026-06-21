// Shared API contracts imported by both the web frontend and the Hono server.
// Define request/response shapes here once so both ends stay in sync.

export interface HealthResponse {
  status: 'ok'
  time: string
}

export type VidscribeNoteKind = 'text' | 'voice' | 'visual' | 'browserbase'

export type VidscribeNote = {
  id: string
  videoId: string
  timestampSec: number
  kind: VidscribeNoteKind
  text: string
  title?: string
  parentNoteId?: string
  imageDataUrl?: string
  transcriptContext?: string
  aiExplanation?: string
  browserbaseMode?: 'beginner' | 'advanced'
  sources?: {
    title: string
    url: string
    summary: string
  }[]
  createdAt: string
}

// --- Research service ---------------------------------------------------------
// The research service takes a chunk of lecture transcript, filters it down to
// keywords, searches the web, scrapes the top sites, and returns a single
// combined summary plus the links the information came from.

/** Request body for POST /api/research. */
export interface ResearchRequest {
  /** A chunk of lecture transcript (raw text) to research. */
  text: string
}

/** Response from POST /api/research. */
export interface ResearchResponse {
  /** The keywords the transcript was filtered down to (the search query). */
  keywords: string[]
  /** One combined summary synthesized from all the sources. */
  summary: string
  /** The source URLs (up to 3) the summary's information came from. */
  links: string[]
}
