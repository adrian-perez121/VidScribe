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

// --- Transcripts ----------------------------------------------------------
// Each uploaded video can be transcribed once via Deepgram. The result is
// stored as timestamped segments (Deepgram "utterances" — sentence-like
// chunks, not individual words) so later work (a transcript viewer, Redis
// RAG ingest) can use them without re-calling Deepgram.

/** One timestamped chunk of a video's transcript. */
export interface TranscriptSegment {
  startSec: number
  endSec: number
  text: string
}

/** A video's full transcript, stored once per video. */
export interface VideoTranscript {
  /** Same id as the video (GridFS file id, hex string). */
  videoId: string
  segments: TranscriptSegment[]
  /** Deepgram model used (or "mock" when MOCK_DEEPGRAM is on), for debugging. */
  model: string
  createdAt: string
}

// --- Study chatbot ------------------------------------------------------------
// The chatbot answers questions across the student's videos using vector search
// over their notes / research / lens explanations, grounded with Claude. It
// returns the video(s) the answer drew from so the UI can link to them.

/** One video an answer was drawn from. */
export interface ChatSource {
  video_id: string
  video_title: string
  /**
   * When the answer drew on a timestamped chunk (a transcript segment, or a note
   * taken at a moment), the point in the video to jump to, in seconds.
   */
  timestamp_sec?: number
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

/** Response from GET /api/videos/:id/transcript/window — segments around a timestamp. */
export interface TranscriptWindow {
  videoId: string
  timestamp: number
  radius: number
  windowStartSec: number
  windowEndSec: number
  segments: TranscriptSegment[]
  /** The overlapping segments' text, joined with spaces, ready to drop into a prompt. */
  context: string
}

// --- Study guide --------------------------------------------------------------
// Generated on demand from a video's (or the whole library's) notes, lens
// explanations, research summaries, and transcript. Not persisted — regenerated
// each request.

/** One themed section of a study guide. */
export interface StudyGuideSection {
  heading: string
  points: string[]
}

/** A generated study guide. */
export interface StudyGuide {
  title: string
  overview: string
  sections: StudyGuideSection[]
  /** Present when generated for a single video. */
  videoId?: string
}

/** Request body for POST /api/study-guide. */
export interface StudyGuideRequest {
  /** Omit to build from the whole library; set to scope to one video. */
  video_id?: string
}

/** Response from POST /api/study-guide. */
export interface StudyGuideResponse {
  guide: StudyGuide
}

// --- Flashcards (SM-2 spaced repetition) --------------------------------------
// Generated from the same material as the study guide, then persisted so review
// scheduling (SM-2) survives across sessions.

/** Anki-style review grades, mapped to SM-2 quality internally. */
export type FlashcardGrade = 'again' | 'hard' | 'good' | 'easy'

/** A single flashcard plus its SM-2 scheduling state. */
export interface Flashcard {
  id: string
  /** Which video the card came from; absent for whole-library decks. */
  videoId?: string
  front: string
  back: string
  /** SM-2 ease factor (>= 1.3), starts at 2.5. */
  ease: number
  /** Current inter-review interval in days. */
  intervalDays: number
  /** Consecutive successful reviews. */
  repetitions: number
  /** ISO timestamp when the card is next due for review. */
  dueAt: string
  createdAt: string
  lastReviewedAt?: string
}

/** Request body for POST /api/flashcards/generate. */
export interface GenerateFlashcardsRequest {
  /** Omit to build from the whole library; set to scope to one video. */
  video_id?: string
  /** Desired number of cards (clamped server-side). */
  count?: number
}

/** Response carrying a set of flashcards. */
export interface FlashcardsResponse {
  cards: Flashcard[]
}

/** Request body for POST /api/flashcards/:id/review. */
export interface ReviewFlashcardRequest {
  grade: FlashcardGrade
}

/** Response from reviewing a card — the updated, rescheduled card. */
export interface ReviewFlashcardResponse {
  card: Flashcard
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