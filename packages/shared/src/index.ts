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
  researchKeywords?: string[]
  researchSummary?: string
  researchLinks?: string[]
  browserbaseMode?: 'beginner' | 'advanced'
  sources?: {
    title: string
    url: string
    summary: string
  }[]
  createdAt: string
}

// --- Videos -------------------------------------------------------------------
// Videos are stored in MongoDB via GridFS (the file bytes) plus a small amount
// of metadata (title, thumbnail) on the GridFS file document. The dashboard
// lists videos using only their metadata + thumbnail — never the file bytes.

/** A video as shown on the dashboard — metadata + thumbnail only, no bytes. */
export interface VideoSummary {
  /** GridFS file id, as a hex string. Also used as the note `videoId`. */
  id: string
  /** Human-readable title (defaults to the uploaded file name). */
  title: string
  /** A small still frame captured at upload time, as a data URL (or null). */
  thumbnailDataUrl: string | null
  /** MIME type of the stored video (e.g. video/mp4). */
  contentType: string
  /** Size of the stored video in bytes. */
  sizeBytes: number
  /** Duration in seconds, if it could be determined at upload. */
  durationSec?: number
  /** ISO timestamp of when the video was uploaded. */
  createdAt: string
}

/** A single video plus the notes taken against it (pulled together). */
export interface VideoDetail extends VideoSummary {
  notes: VidscribeNote[]
}

/** Response from GET /api/videos. */
export interface VideoListResponse {
  videos: VideoSummary[]
}

// --- Study chatbot ------------------------------------------------------------
// The chatbot answers questions across the student's videos using vector search
// over their notes / research / lens explanations, grounded with Claude. It
// returns the video(s) the answer drew from so the UI can link to them.

/** One video an answer was drawn from. */
export interface ChatSource {
  video_id: string
  video_title: string
}

/** Request body for POST /api/chat. */
export interface ChatRequest {
  message: string
  /** Opaque per-conversation id used to thread follow-up questions. */
  session_id?: string
  /** When set, scope retrieval to a single video (e.g. asking from its page). */
  video_id?: string
}

/** Response from POST /api/chat. */
export interface ChatResponse {
  answer: string
  /** Deduped videos the answer came from; empty when nothing relevant matched. */
  sources: ChatSource[]
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