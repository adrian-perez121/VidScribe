// Shared API contracts imported by both the web frontend and the Hono server.
// Define request/response shapes here once so both ends stay in sync.

export interface HealthResponse {
  status: 'ok'
  time: string
}

// --- Research service ---------------------------------------------------------
// The research service takes a chunk of lecture transcript, filters it down to
// keywords, searches the web, and returns a summary for each of the top sites.

/** One web source the user should look at, plus a summary of its content. */
export interface ResearchResult {
  /** Absolute URL of the source page. */
  link: string
  /** Short AI-generated summary of that page's content. */
  summary: string
}

/** Request body for POST /api/research. */
export interface ResearchRequest {
  /** A chunk of lecture transcript (raw text) to research. */
  text: string
}

/** Response from POST /api/research. */
export interface ResearchResponse {
  /** The keywords the transcript was filtered down to (the search query). */
  keywords: string[]
  /** Top sources (up to 3) with summaries. */
  results: ResearchResult[]
}
