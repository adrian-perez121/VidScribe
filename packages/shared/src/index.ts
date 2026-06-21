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
