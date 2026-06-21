import type {
  VideoSummary,
  VideoDetail,
  VideoListResponse,
  VidscribeNote,
  ChatResponse,
  TranscriptWindow,
  VideoTranscript,
} from '@vid-mark/shared'

// Thin fetch wrappers around the backend video/notes endpoints. Notes calls are
// best-effort mirrors of the localStorage store — callers should not block the
// UI on them.

export async function listVideos(): Promise<VideoSummary[]> {
  const res = await fetch('/api/videos')
  if (!res.ok) throw new Error(`Failed to load videos (${res.status})`)
  const data = (await res.json()) as VideoListResponse
  return data.videos
}

// A video's detail (metadata + its notes) is fetched once and cached for the
// session so revisiting a video doesn't refetch its notes over and over. A
// failed fetch is not cached (so it can be retried).
const videoDetailCache = new Map<string, Promise<VideoDetail>>()

export function getVideo(id: string): Promise<VideoDetail> {
  const cached = videoDetailCache.get(id)
  if (cached) return cached

  const pending = (async () => {
    const res = await fetch(`/api/videos/${id}`)
    if (!res.ok) throw new Error(`Failed to load video (${res.status})`)
    return (await res.json()) as VideoDetail
  })()
  pending.catch(() => {
    if (videoDetailCache.get(id) === pending) videoDetailCache.delete(id)
  })
  videoDetailCache.set(id, pending)
  return pending
}

export interface UploadVideoInput {
  file: File
  title: string
  thumbnailDataUrl: string
  durationSec?: number
  /** Called with 0–100 as the file uploads. */
  onProgress?: (percent: number) => void
}

export function uploadVideo(input: UploadVideoInput): Promise<VideoSummary> {
  const form = new FormData()
  // Append text fields BEFORE the file so the server has them when the file
  // stream opens (the upload is parsed as a stream, in order).
  form.append('title', input.title)
  if (input.durationSec) form.append('durationSec', String(input.durationSec))
  form.append('thumbnail', input.thumbnailDataUrl)
  form.append('video', input.file)

  // Use XHR (not fetch) because it exposes upload progress events.
  return new Promise<VideoSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/videos')

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && input.onProgress) {
        input.onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* non-JSON response */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as VideoSummary)
      } else {
        const message = (data as { error?: string } | null)?.error
        reject(new Error(message ?? `Upload failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed (network error)'))
    xhr.send(form)
  })
}

/** Delete a video and all its notes from the database. */
export async function deleteVideo(id: string): Promise<void> {
  const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Delete failed (${res.status})`)
  }
  videoDetailCache.delete(id) // drop any cached detail/notes for this video
}

/** Mirror a note to the database (create or update). Best-effort. */
export async function saveNote(note: VidscribeNote): Promise<void> {
  await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note),
  })
}

/** Remove a note from the database. Best-effort. */
export async function deleteNote(id: string): Promise<void> {
  await fetch(`/api/notes/${id}`, { method: 'DELETE' })
}

/**
 * Fetch transcript segments around a timestamp (default radius 15s). Throws
 * if the video has no stored transcript (404) or the request otherwise fails
 * — callers should treat this as best-effort and not block on it.
 */
export async function getTranscriptWindow(
  videoId: string,
  timestamp: number,
  radius?: number,
): Promise<TranscriptWindow> {
  const params = new URLSearchParams({ timestamp: String(timestamp) })
  if (radius !== undefined) params.set('radius', String(radius))

  const res = await fetch(`/api/videos/${videoId}/transcript/window?${params}`)
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Transcript window failed (${res.status})`)
  }
  return (await res.json()) as TranscriptWindow
}

/** Fetch a video's stored transcript. Throws (404) if none exists yet. */
export async function getTranscript(videoId: string): Promise<VideoTranscript> {
  const res = await fetch(`/api/videos/${videoId}/transcript`)
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Failed to load transcript (${res.status})`)
  }
  return (await res.json()) as VideoTranscript
}

/** Transcribe a video via Deepgram (or a mock, with MOCK_DEEPGRAM=true server-side). */
export async function generateTranscript(videoId: string): Promise<VideoTranscript> {
  const res = await fetch(`/api/videos/${videoId}/transcript`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Failed to generate transcript (${res.status})`)
  }
  return (await res.json()) as VideoTranscript
}

/**
 * Ask the study chatbot a question; `sessionId` threads follow-up turns. Pass
 * `videoId` to scope the answer to a single video (used on a video's page).
 */
export async function sendChat(
  message: string,
  sessionId: string,
  videoId?: string,
): Promise<ChatResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId, video_id: videoId }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Chat failed (${res.status})`)
  }
  return (await res.json()) as ChatResponse
}

/**
 * Download a generated .docx export. `kind` picks the endpoint; `videoId` scopes
 * it to one video (omit for the whole library). Saves the file via a temporary
 * object URL. Throws with the server's error message on failure.
 */
export async function downloadExport(
  kind: 'notes' | 'study-guide',
  videoId?: string,
): Promise<void> {
  const qs = videoId ? `?video_id=${encodeURIComponent(videoId)}` : ''
  const res = await fetch(`/api/export/${kind}.docx${qs}`)
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `Export failed (${res.status})`)
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${kind}.docx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
