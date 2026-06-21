// Capture a still thumbnail from a video file entirely in the browser, so the
// dashboard can show a preview without ever loading the full video. We load the
// file into an off-DOM <video>, seek a little way in, and draw one frame to a
// canvas, returning a small JPEG data URL.

/** Video MIME types we accept for upload (browser-playable via <video>). */
export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const

/** Value for an <input type="file"> accept attribute. */
export const ACCEPTED_VIDEO_ACCEPT = ACCEPTED_VIDEO_TYPES.join(',')

/** Largest thumbnail width; height scales to keep aspect ratio. */
const THUMBNAIL_MAX_WIDTH = 480

/** How long to wait for a metadata load / seek before giving up (ms). */
const STEP_TIMEOUT_MS = 5000

export interface CapturedThumbnail {
  dataUrl: string
  durationSec: number
}

export async function captureThumbnail(file: File): Promise<CapturedThumbnail> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  video.src = url

  try {
    await waitForEvent(video, 'loadedmetadata')
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    // Grab a frame a touch into the video (avoids black/blank first frames).
    const target = duration ? Math.min(1, duration / 2) : 0
    await seekTo(video, target)

    const vw = video.videoWidth || THUMBNAIL_MAX_WIDTH
    const vh = video.videoHeight || Math.round((THUMBNAIL_MAX_WIDTH * 9) / 16)
    const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / vw)

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(vw * scale))
    canvas.height = Math.max(1, Math.round(vh * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a canvas context for the thumbnail')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    return { dataUrl: canvas.toDataURL('image/jpeg', 0.7), durationSec: duration }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function waitForEvent(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error('Could not read the video (is it a valid MP4/WebM?)'))
    }
    const timer = setTimeout(onOk, STEP_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener(event, onOk)
      video.removeEventListener('error', onErr)
    }
    video.addEventListener(event, onOk)
    video.addEventListener('error', onErr)
  })
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(onSeeked, STEP_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
    }
    video.addEventListener('seeked', onSeeked)
    try {
      video.currentTime = time
    } catch {
      cleanup()
      resolve()
    }
  })
}
