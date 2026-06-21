import { useEffect, useRef, useState } from 'react'
import type { VidscribeNote } from '@vid-mark/shared'

const VIDEO_ID = 'cell-physiology-demo'
const STORAGE_KEY = 'vidscribe:notes:v1'

function loadNotes(): VidscribeNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

/** How close currentTime must already be to the target to skip seeking (seconds). */
const SEEK_EPSILON = 0.05
/** Max time to wait for a seek to finish before giving up and capturing anyway. */
const SEEK_TIMEOUT_MS = 2000

/**
 * Seek the video to timestampSec and resolve only once the browser has
 * actually rendered that frame (after the "seeked" event + one animation
 * frame), so a canvas capture right after this resolves gets the right frame.
 */
function waitForVideoSeek(video: HTMLVideoElement, timestampSec: number): Promise<void> {
  if (Math.abs(video.currentTime - timestampSec) < SEEK_EPSILON) {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      video.removeEventListener('seeked', onSeeked)
      clearTimeout(timeoutId)
      requestAnimationFrame(() => resolve())
    }
    const onSeeked = () => finish()
    const timeoutId = setTimeout(finish, SEEK_TIMEOUT_MS)

    video.addEventListener('seeked', onSeeked)
    video.currentTime = timestampSec
  })
}

/** A selection rectangle in normalized (0-1) coordinates relative to the video box. */
type NormalizedRect = { x: number; y: number; width: number; height: number }

/** Minimum normalized width/height a selection must have to be usable. */
const MIN_SELECTION_SIZE = 0.03

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/**
 * Draw the video's current frame to a canvas and return it as both a Blob and
 * a data URL. If `rect` is given (normalized 0-1 coords), only that region of
 * the actual video pixels is captured.
 */
function captureVideoFrame(
  video: HTMLVideoElement,
  rect?: NormalizedRect,
): { blob: Blob; dataUrl: string } | null {
  const videoWidth = video.videoWidth
  const videoHeight = video.videoHeight
  if (videoWidth === 0 || videoHeight === 0) return null

  const sx = rect ? Math.round(rect.x * videoWidth) : 0
  const sy = rect ? Math.round(rect.y * videoHeight) : 0
  const sw = rect ? Math.max(1, Math.round(rect.width * videoWidth)) : videoWidth
  const sh = rect ? Math.max(1, Math.round(rect.height * videoHeight)) : videoHeight

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
  const dataUrl = canvas.toDataURL('image/png')
  const byteString = atob(dataUrl.split(',')[1])
  const bytes = new Uint8Array(byteString.length)
  for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
  return { blob: new Blob([bytes], { type: 'image/png' }), dataUrl }
}

function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoBoxRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const [notes, setNotes] = useState<VidscribeNote[]>(loadNotes)
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [draftTimestamp, setDraftTimestamp] = useState(0)
  const [draftText, setDraftText] = useState('')
  const [lensLoadingId, setLensLoadingId] = useState<string | null>(null)
  const [lensErrors, setLensErrors] = useState<Record<string, string>>({})
  const [lensNote, setLensNote] = useState<VidscribeNote | null>(null)
  const [selectionRect, setSelectionRect] = useState<NormalizedRect | null>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
  }, [notes])

  function handleTextNoteClick() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    setDraftTimestamp(video.currentTime)
    setDraftText('')
    setIsComposerOpen(true)
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'n' && e.key !== 'N') return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      e.preventDefault()
      handleTextNoteClick()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  function handleSave() {
    if (!draftText.trim()) return
    const note: VidscribeNote = {
      id: crypto.randomUUID(),
      videoId: VIDEO_ID,
      timestampSec: draftTimestamp,
      kind: 'text',
      text: draftText.trim(),
      createdAt: new Date().toISOString(),
    }
    setNotes((prev) => [...prev, note].sort((a, b) => a.timestampSec - b.timestampSec))
    setIsComposerOpen(false)
  }

  function handleCancel() {
    setIsComposerOpen(false)
  }

  function handleNoteClick(note: VidscribeNote) {
    const video = videoRef.current
    if (!video) return
    video.currentTime = note.timestampSec
    video.play().catch(() => {})
  }

  async function handleExplainVisualClick(note: VidscribeNote) {
    const video = videoRef.current
    if (!video) return

    video.pause()

    setLensErrors((prev) => {
      const rest = { ...prev }
      delete rest[note.id]
      return rest
    })
    setLensLoadingId(note.id)

    try {
      await waitForVideoSeek(video, note.timestampSec)
      setSelectionRect(null)
      setLensNote(note)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not seek to that timestamp'
      setLensErrors((prev) => ({ ...prev, [note.id]: message }))
    } finally {
      setLensLoadingId(null)
    }
  }

  function getRelativePoint(e: React.PointerEvent<HTMLDivElement>) {
    const box = videoBoxRef.current
    const rect = box?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    }
  }

  function handleSelectionPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const point = getRelativePoint(e)
    if (!point) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStartRef.current = point
    setSelectionRect({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  function handleSelectionPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current
    if (!start) return
    const point = getRelativePoint(e)
    if (!point) return
    setSelectionRect({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    })
  }

  function handleSelectionPointerUp() {
    dragStartRef.current = null
  }

  function handleCancelSelection() {
    dragStartRef.current = null
    setLensNote(null)
    setSelectionRect(null)
  }

  const isSelectionValid =
    !!selectionRect &&
    selectionRect.width >= MIN_SELECTION_SIZE &&
    selectionRect.height >= MIN_SELECTION_SIZE

  async function handleUseSelection() {
    const video = videoRef.current
    if (!video || !lensNote || !isSelectionValid || !selectionRect) return
    const note = lensNote
    const rect = selectionRect

    setLensLoadingId(note.id)

    try {
      const frame = captureVideoFrame(video, rect)
      if (!frame) throw new Error('Could not capture video frame')

      const notesBefore = notes
        .filter((n) => n.timestampSec < note.timestampSec)
        .map((n) => n.text)
        .join('\n')
      const notesAfter = notes
        .filter((n) => n.timestampSec > note.timestampSec)
        .map((n) => n.text)
        .join('\n')

      const formData = new FormData()
      formData.append('image', frame.blob, 'frame.png')
      formData.append('prompt', note.text)
      if (notesBefore) formData.append('notes_before', notesBefore)
      if (notesAfter) formData.append('notes_after', notesAfter)

      const res = await fetch('/api/explain', { method: 'POST', body: formData })
      const data = await res.json().catch(() => null)

      if (!res.ok) {
        throw new Error(data?.error ?? `Lens request failed (${res.status})`)
      }
      if (!data || typeof data.explanation !== 'string') {
        throw new Error('Lens response was missing an explanation')
      }

      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id
            ? { ...n, aiExplanation: data.explanation, imageDataUrl: frame.dataUrl }
            : n,
        ),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lens request failed'
      setLensErrors((prev) => ({ ...prev, [note.id]: message }))
    } finally {
      setLensLoadingId(null)
      setLensNote(null)
      setSelectionRect(null)
    }
  }

  return (
    <main className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <header className="shrink-0 border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Vidscribe</h1>
        <p className="text-sm text-gray-400">video notes that remember the moment</p>
      </header>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 lg:flex-row lg:overflow-hidden">
        <section className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
          <div
            ref={videoBoxRef}
            className="relative h-[40vh] overflow-hidden rounded-lg border border-gray-800 bg-black lg:h-auto lg:min-h-0 lg:flex-1"
          >
            <video
              ref={videoRef}
              className="h-full w-full object-contain"
              src="/demo-video.mp4"
              controls
            />
            {lensNote && (
              <div
                className="absolute inset-0 cursor-crosshair touch-none bg-black/30"
                onPointerDown={handleSelectionPointerDown}
                onPointerMove={handleSelectionPointerMove}
                onPointerUp={handleSelectionPointerUp}
              >
                <p className="absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded bg-gray-950/80 px-3 py-1 text-xs text-gray-100">
                  Drag over the part of the video you want explained
                </p>
                {selectionRect && (
                  <div
                    className="pointer-events-none absolute border-2 border-indigo-400 bg-indigo-400/20"
                    style={{
                      left: `${selectionRect.x * 100}%`,
                      top: `${selectionRect.y * 100}%`,
                      width: `${selectionRect.width * 100}%`,
                      height: `${selectionRect.height * 100}%`,
                    }}
                  />
                )}
              </div>
            )}
          </div>

          {lensNote && (
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
              <p className="text-xs text-gray-400">
                {isSelectionValid ? 'Selection ready.' : 'Drag a larger rectangle over the video.'}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCancelSelection}
                  className="rounded-md border border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleUseSelection}
                  disabled={!isSelectionValid || lensLoadingId === lensNote.id}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {lensLoadingId === lensNote.id ? 'Explaining…' : 'Use selection'}
                </button>
              </div>
            </div>
          )}

          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={handleTextNoteClick}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Text Note
            </button>
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded-md border border-gray-800 px-4 py-2 text-sm font-medium text-gray-500"
            >
              Voice Note · coming soon
            </button>
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded-md border border-gray-800 px-4 py-2 text-sm font-medium text-gray-500"
            >
              Lens · coming soon
            </button>
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded-md border border-gray-800 px-4 py-2 text-sm font-medium text-gray-500"
            >
              Study Guide · coming soon
            </button>
          </div>
        </section>

        <aside className="flex w-full min-h-0 flex-col gap-3 lg:w-80">
          <h2 className="shrink-0 text-sm font-semibold uppercase tracking-wide text-gray-400">
            Notes
          </h2>

          {isComposerOpen && (
            <div className="shrink-0 rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="mb-2 text-sm text-gray-400">
                Note at {formatTimestamp(draftTimestamp)}
              </p>
              <textarea
                autoFocus
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder="Add a note for this moment..."
                rows={3}
                className="w-full rounded-md border border-gray-700 bg-gray-950 p-2 text-sm text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="rounded-md border border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {notes.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-gray-800 p-6 text-center text-sm text-gray-500">
              No notes yet. Click Text Note to mark this moment.
            </div>
          ) : (
            <ul className="flex flex-col gap-2 overflow-y-auto">
              {notes.map((note) => (
                <li
                  key={note.id}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 p-3 hover:border-indigo-500"
                >
                  <button
                    type="button"
                    onClick={() => handleNoteClick(note)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-gray-800 px-2 py-0.5 text-xs font-mono text-indigo-300">
                        {formatTimestamp(note.timestampSec)}
                      </span>
                      <span className="rounded bg-indigo-950 px-2 py-0.5 text-xs text-indigo-300">
                        Text
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-gray-200">{note.text}</p>
                  </button>

                  {note.aiExplanation && (
                    <div className="mt-2 border-t border-gray-800 pt-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Visual explanation
                      </p>
                      {note.imageDataUrl && (
                        <img
                          src={note.imageDataUrl}
                          alt="Captured video frame"
                          className="mt-2 max-h-32 w-full rounded object-cover"
                        />
                      )}
                      <p className="mt-2 text-sm text-gray-200">{note.aiExplanation}</p>
                    </div>
                  )}

                  {note.kind === 'text' && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => handleExplainVisualClick(note)}
                        disabled={lensLoadingId === note.id || !!lensNote}
                        className="rounded-md border border-gray-700 px-2 py-1 text-xs font-medium text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {lensLoadingId === note.id
                          ? 'Explaining…'
                          : note.aiExplanation
                            ? 'Re-explain visual'
                            : 'Explain visual'}
                      </button>
                      {lensErrors[note.id] && (
                        <p className="mt-1 text-xs text-red-400">{lensErrors[note.id]}</p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </main>
  )
}

export default Home
