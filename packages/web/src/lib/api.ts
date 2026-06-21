import type {
  VideoSummary,
  VideoDetail,
  VideoListResponse,
  VidscribeNote,
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
