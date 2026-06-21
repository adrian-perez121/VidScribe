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

export async function getVideo(id: string): Promise<VideoDetail> {
  const res = await fetch(`/api/videos/${id}`)
  if (!res.ok) throw new Error(`Failed to load video (${res.status})`)
  return (await res.json()) as VideoDetail
}

export interface UploadVideoInput {
  file: File
  title: string
  thumbnailDataUrl: string
  durationSec?: number
}

export async function uploadVideo(input: UploadVideoInput): Promise<VideoSummary> {
  const form = new FormData()
  // Append text fields BEFORE the file so the server has them when the file
  // stream opens (the upload is parsed as a stream, in order).
  form.append('title', input.title)
  if (input.durationSec) form.append('durationSec', String(input.durationSec))
  form.append('thumbnail', input.thumbnailDataUrl)
  form.append('video', input.file)

  const res = await fetch('/api/videos', { method: 'POST', body: form })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error ?? `Upload failed (${res.status})`)
  }
  return data as VideoSummary
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
