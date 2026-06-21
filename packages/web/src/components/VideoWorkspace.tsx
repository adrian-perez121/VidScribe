import { useEffect, useRef, useState } from 'react'
import type { VidscribeNote, VideoTranscript } from '@vid-mark/shared'
import {
  getVideo,
  saveNote,
  deleteNote,
  getTranscriptWindow,
  getTranscript,
  generateTranscript,
} from '../lib/api'

// The video + note-taking workspace. Backs BOTH the hardcoded demo (localStorage
// only) and uploaded videos (localStorage + database).
//
// Notes are stored in one localStorage array (key below) keyed by `videoId`, and
// ALWAYS displayed filtered to the current `videoId` — so notes never bleed
// across videos. When `persist` is set we also (a) hydrate this video's notes
// from the DB once (the fetch is cached in lib/api, so it doesn't refetch over
// and over), and (b) mirror each created/updated note to the DB.

const STORAGE_KEY = 'vidscribe:notes:v1'
const DEFAULT_VISUAL_PROMPT = 'Explain this part of the video in simple study-note terms.'

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

/**
 * Merge DB notes into the local set (by id), then return sorted by time.
 * The LOCAL copy wins on conflict — localStorage is the live store for this
 * browser, so the DB hydrate only fills in notes we don't already have.
 */
function mergeNotes(local: VidscribeNote[], incoming: VidscribeNote[]): VidscribeNote[] {
  const byId = new Map(incoming.map((n) => [n.id, n]))
  for (const n of local) byId.set(n.id, n)
  return [...byId.values()].sort((a, b) => a.timestampSec - b.timestampSec)
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

/** MIME types to try for MediaRecorder, in order of preference. */
const PREFERRED_AUDIO_MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4']

function pickAudioMimeType(): string | undefined {
  return PREFERRED_AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

export interface VideoWorkspaceProps {
  /** The video these notes belong to (stamped onto every note). */
  videoId: string
  /** Source for the <video> element (a public URL or a stream endpoint). */
  videoSrc: string
  /** When true, mirror notes to the DB and hydrate this video's notes on mount. */
  persist?: boolean
  /** Optional heading shown above the player. */
  title?: string
}

function VideoWorkspace({ videoId, videoSrc, persist = false, title }: VideoWorkspaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoBoxRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const [notes, setNotes] = useState<VidscribeNote[]>(loadNotes)
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [draftTimestamp, setDraftTimestamp] = useState(0)
  const [draftText, setDraftText] = useState('')
  const [lensLoadingId, setLensLoadingId] = useState<string | null>(null)
  const [lensErrors, setLensErrors] = useState<Record<string, string>>({})
  const [lensNote, setLensNote] = useState<VidscribeNote | null>(null)
  const [selectionRect, setSelectionRect] = useState<NormalizedRect | null>(null)
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'saving' | 'error'>('idle')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [researchLoadingId, setResearchLoadingId] = useState<string | null>(null)
  const [researchErrors, setResearchErrors] = useState<Record<string, string>>({})
  const [isVisualComposerOpen, setIsVisualComposerOpen] = useState(false)
  const [visualDraftTimestamp, setVisualDraftTimestamp] = useState(0)
  const [visualDraftText, setVisualDraftText] = useState('')
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false)
  const [transcript, setTranscript] = useState<VideoTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptGenerating, setTranscriptGenerating] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null)

  // Notes for THIS video only (the localStorage array holds every video's notes).
  const videoNotes = notes
    .filter((n) => n.videoId === videoId)
    .sort((a, b) => a.timestampSec - b.timestampSec)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
  }, [notes])

  // When DB-backed, pull this video's notes once and merge them in. getVideo is
  // cached in lib/api, so revisiting a video won't refetch over the network.
  useEffect(() => {
    if (!persist) return
    let cancelled = false
    getVideo(videoId)
      .then((detail) => {
        if (!cancelled) setNotes((prev) => mergeNotes(prev, detail.notes))
      })
      .catch((err) => console.error('Could not load notes for video:', err))
    return () => {
      cancelled = true
    }
  }, [persist, videoId])

  // Transcript fetch is isolated from the notes hydrate above: a slow/failed
  // transcript load should never delay or break notes loading. Only fetched
  // for DB-backed (uploaded) videos — the local demo has no real videoId.
  useEffect(() => {
    if (!persist) return
    let cancelled = false
    setTranscriptLoading(true)
    setTranscriptError(null)
    getTranscript(videoId)
      .then((t) => {
        if (!cancelled) setTranscript(t)
      })
      .catch((err) => {
        // 404 (no transcript yet) is expected, not an error worth surfacing.
        if (!cancelled) setTranscript(null)
        console.error('Could not load transcript:', err)
      })
      .finally(() => {
        if (!cancelled) setTranscriptLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [persist, videoId])

  // Track the active transcript segment as the video plays/seeks.
  useEffect(() => {
    if (!persist || !transcript) return
    const video = videoRef.current
    if (!video) return

    function handleTimeUpdate() {
      const t = video!.currentTime
      const index = transcript!.segments.findIndex(
        (s) => t >= s.startSec && t <= s.endSec,
      )
      setActiveSegmentIndex(index === -1 ? null : index)
    }

    video.addEventListener('timeupdate', handleTimeUpdate)
    return () => video.removeEventListener('timeupdate', handleTimeUpdate)
  }, [persist, transcript])

  function handleSegmentClick(segment: { startSec: number }) {
    const video = videoRef.current
    if (!video) return
    video.currentTime = segment.startSec
    video.play().catch(() => {})
  }

  async function handleGenerateTranscript() {
    setTranscriptGenerating(true)
    setTranscriptError(null)
    try {
      const t = await generateTranscript(videoId)
      setTranscript(t)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not generate transcript'
      setTranscriptError(message)
    } finally {
      setTranscriptGenerating(false)
    }
  }

  /** Mirror a note to the DB when this workspace is DB-backed. Best-effort. */
  function persistNote(note: VidscribeNote) {
    if (persist) saveNote(note).catch((err) => console.error('Could not save note:', err))
  }

  /** Add a new note to local state (+ localStorage) and the DB. */
  function addNote(note: VidscribeNote) {
    setNotes((prev) => [...prev, note].sort((a, b) => a.timestampSec - b.timestampSec))
    persistNote(note)
  }

  /** Update an existing note in local state (+ localStorage) and the DB. */
  function updateNote(updated: VidscribeNote) {
    setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
    persistNote(updated)
  }

  /**
   * Best-effort: fetch transcript context around a note's timestamp and merge
   * it in once it arrives. Only `note.id`/`note.timestampSec` are used, so
   * it's safe to call with any snapshot of the note. Never blocks note
   * creation and never surfaces an error to the user — the demo workspace has
   * no transcript at all (persist is false), and an uploaded video may not
   * have been transcribed yet, both of which are expected, silent no-ops.
   */
  function attachTranscriptContext(note: Pick<VidscribeNote, 'id' | 'timestampSec'>) {
    if (!persist) return
    getTranscriptWindow(videoId, note.timestampSec)
      .then((window) => {
        if (!window.context) return
        setNotes((prev) => {
          const next = prev.map((n) =>
            n.id === note.id ? { ...n, transcriptContext: window.context } : n,
          )
          const merged = next.find((n) => n.id === note.id)
          if (merged) persistNote(merged)
          return next
        })
      })
      .catch((err) => console.error('Could not attach transcript context:', err))
  }

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
      videoId,
      timestampSec: draftTimestamp,
      kind: 'text',
      text: draftText.trim(),
      createdAt: new Date().toISOString(),
    }
    addNote(note)
    attachTranscriptContext(note)
    setIsComposerOpen(false)
  }

  function handleCancel() {
    setIsComposerOpen(false)
  }

  function handleDeleteNote(note: VidscribeNote) {
    if (!window.confirm('Delete this note? This cannot be undone.')) return
    setNotes((prev) => prev.filter((n) => n.id !== note.id))
    if (persist) deleteNote(note.id).catch((err) => console.error('Could not delete note:', err))
  }

  function handleVisualNoteClick() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    setVisualDraftTimestamp(video.currentTime)
    setVisualDraftText('')
    setIsVisualComposerOpen(true)
  }

  function handleVisualComposerCancel() {
    setIsVisualComposerOpen(false)
  }

  async function handleVisualComposerSubmit() {
    const video = videoRef.current
    if (!video) return
    const text = visualDraftText.trim() || DEFAULT_VISUAL_PROMPT

    const note: VidscribeNote = {
      id: crypto.randomUUID(),
      videoId,
      timestampSec: visualDraftTimestamp,
      kind: 'text',
      text,
      createdAt: new Date().toISOString(),
    }
    addNote(note)
    attachTranscriptContext(note)
    setIsVisualComposerOpen(false)

    // Reuse the existing Lens crop-selection flow as-is — it works on any note.
    await waitForVideoSeek(video, note.timestampSec)
    setSelectionRect(null)
    setLensNote(note)
  }

  function handleNoteClick(note: VidscribeNote) {
    const video = videoRef.current
    if (!video) return
    video.currentTime = note.timestampSec
    video.play().catch(() => {})
  }

  /**
   * Turn recorded audio into a transcript via a REST upload to the backend,
   * which forwards it to Deepgram's prerecorded speech-to-text API. This is a
   * deliberately small seam: a later milestone can replace this body with a
   * Deepgram Flux streaming call without touching the recording/UI code above.
   */
  async function transcribeRecording(chunks: Blob[], mimeType: string): Promise<string> {
    const blob = new Blob(chunks, { type: mimeType })
    const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm'

    const formData = new FormData()
    formData.append('audio', blob, `voice-note.${extension}`)

    const res = await fetch('/api/deepgram/voice-note', { method: 'POST', body: formData })
    const data = await res.json().catch(() => null)

    if (!res.ok) {
      throw new Error(data?.error ?? `Transcription failed (${res.status})`)
    }
    if (!data || typeof data.transcript !== 'string') {
      throw new Error('Transcription response was missing a transcript')
    }
    return data.transcript
  }

  async function handleVoiceNoteClick() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    const timestampSec = video.currentTime
    setVoiceError(null)

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone permission was denied'
      setVoiceError(message)
      setVoiceState('error')
      return
    }

    mediaStreamRef.current = stream
    const chunks: Blob[] = []
    const mimeType = pickAudioMimeType()
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = async () => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
      setVoiceState('saving')
      try {
        const transcript = await transcribeRecording(chunks, recorder.mimeType || 'audio/webm')
        const note: VidscribeNote = {
          id: crypto.randomUUID(),
          videoId,
          timestampSec,
          kind: 'voice',
          text: transcript,
          createdAt: new Date().toISOString(),
        }
        addNote(note)
        attachTranscriptContext(note)
        setVoiceState('idle')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not save voice note'
        setVoiceError(message)
        setVoiceState('error')
      }
    }

    mediaRecorderRef.current = recorder
    recorder.start()
    setVoiceState('recording')
  }

  function handleStopRecording() {
    mediaRecorderRef.current?.stop()
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

      const notesBefore = videoNotes
        .filter((n) => n.timestampSec < note.timestampSec)
        .map((n) => n.text)
        .join('\n')
      const notesAfter = videoNotes
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

      updateNote({ ...note, aiExplanation: data.explanation, imageDataUrl: frame.dataUrl })
      if (!note.transcriptContext) attachTranscriptContext(note)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lens request failed'
      setLensErrors((prev) => ({ ...prev, [note.id]: message }))
    } finally {
      setLensLoadingId(null)
      setLensNote(null)
      setSelectionRect(null)
    }
  }

  async function handleResearchClick(note: VidscribeNote) {
    setResearchErrors((prev) => {
      const rest = { ...prev }
      delete rest[note.id]
      return rest
    })
    setResearchLoadingId(note.id)

    try {
      const text = note.aiExplanation ? `${note.text}\n\n${note.aiExplanation}` : note.text

      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => null)

      if (!res.ok) {
        throw new Error(data?.error ?? `Research request failed (${res.status})`)
      }
      if (!data || typeof data.summary !== 'string') {
        throw new Error('Research response was missing a summary')
      }

      updateNote({
        ...note,
        researchKeywords: Array.isArray(data.keywords) ? data.keywords : undefined,
        researchSummary: data.summary,
        researchLinks: Array.isArray(data.links) ? data.links : undefined,
      })
      if (!note.transcriptContext) attachTranscriptContext(note)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Research request failed'
      setResearchErrors((prev) => ({ ...prev, [note.id]: message }))
    } finally {
      setResearchLoadingId(null)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 lg:flex-row lg:overflow-hidden">
      <section className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
        {title && (
          <h2 className="shrink-0 truncate text-lg font-semibold text-gray-100">{title}</h2>
        )}
        <div
          ref={videoBoxRef}
          className="relative h-[40vh] overflow-hidden rounded-lg border border-gray-800 bg-black lg:h-auto lg:min-h-0 lg:flex-1"
        >
          <video
            ref={videoRef}
            key={videoSrc}
            className="h-full w-full object-contain"
            src={videoSrc}
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

        {isVisualComposerOpen && (
          <div className="shrink-0 rounded-lg border border-gray-800 bg-gray-900 p-4">
            <p className="mb-2 text-sm text-gray-400">
              Visual note at {formatTimestamp(visualDraftTimestamp)}
            </p>
            <textarea
              autoFocus
              value={visualDraftText}
              onChange={(e) => setVisualDraftText(e.target.value)}
              placeholder={DEFAULT_VISUAL_PROMPT}
              rows={3}
              className="w-full rounded-md border border-gray-700 bg-gray-950 p-2 text-sm text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleVisualComposerCancel}
                className="rounded-md border border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleVisualComposerSubmit}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
              >
                Continue
              </button>
            </div>
          </div>
        )}

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

        {voiceState === 'recording' && (
          <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
            <p className="text-sm text-red-400">● Recording voice note...</p>
            <button
              type="button"
              onClick={handleStopRecording}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Stop
            </button>
          </div>
        )}

        {voiceState === 'saving' && (
          <div className="shrink-0 rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm text-gray-400">
            Saving voice note…
          </div>
        )}

        {voiceState === 'error' && voiceError && (
          <div className="shrink-0 rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
            {voiceError}
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
            onClick={handleVoiceNoteClick}
            disabled={voiceState === 'recording' || voiceState === 'saving'}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Voice Note
          </button>
          <button
            type="button"
            onClick={handleVisualNoteClick}
            disabled={!!lensNote}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Visual Note
          </button>
          {persist && (
            <button
              type="button"
              onClick={() => setIsTranscriptOpen((prev) => !prev)}
              className="rounded-md border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800"
            >
              {isTranscriptOpen ? 'Hide Transcript' : 'Transcript'}
            </button>
          )}
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-md border border-gray-800 px-4 py-2 text-sm font-medium text-gray-500"
          >
            Study Guide · coming soon
          </button>
        </div>

        {persist && isTranscriptOpen && (
          <div className="flex max-h-64 shrink-0 flex-col rounded-lg border border-gray-800 bg-gray-900 p-3">
            <p className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Transcript
            </p>

            {transcriptLoading ? (
              <p className="text-sm text-gray-500">Loading transcript…</p>
            ) : transcript && transcript.segments.length > 0 ? (
              <ul className="flex flex-col gap-1 overflow-y-auto">
                {transcript.segments.map((segment, index) => (
                  <li key={`${segment.startSec}-${index}`}>
                    <button
                      type="button"
                      onClick={() => handleSegmentClick(segment)}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                        index === activeSegmentIndex
                          ? 'bg-indigo-950 text-indigo-200'
                          : 'text-gray-300 hover:bg-gray-800'
                      }`}
                    >
                      <span className="mr-2 font-mono text-xs text-indigo-300">
                        {formatTimestamp(segment.startSec)}
                      </span>
                      {segment.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-gray-500">No transcript yet for this video.</p>
                <button
                  type="button"
                  onClick={handleGenerateTranscript}
                  disabled={transcriptGenerating}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {transcriptGenerating ? 'Generating…' : 'Generate transcript'}
                </button>
                {transcriptError && <p className="text-xs text-red-400">{transcriptError}</p>}
              </div>
            )}
          </div>
        )}
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

        {videoNotes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-gray-800 p-6 text-center text-sm text-gray-500">
            No notes yet. Click Text Note to mark this moment.
          </div>
        ) : (
          <ul className="flex flex-col gap-2 overflow-y-auto">
            {videoNotes.map((note) => (
              <li
                key={note.id}
                className="relative w-full rounded-lg border border-gray-800 bg-gray-900 p-3 hover:border-indigo-500"
              >
                <button
                  type="button"
                  onClick={() => handleDeleteNote(note)}
                  aria-label="Delete note"
                  title="Delete note"
                  className="absolute right-2 top-2 z-10 rounded px-1.5 py-0.5 text-xs text-gray-600 hover:bg-red-950/40 hover:text-red-400"
                >
                  ✕
                </button>

                <button
                  type="button"
                  onClick={() => handleNoteClick(note)}
                  className="w-full pr-6 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-gray-800 px-2 py-0.5 text-xs font-mono text-indigo-300">
                      {formatTimestamp(note.timestampSec)}
                    </span>
                    <span className="rounded bg-indigo-950 px-2 py-0.5 text-xs text-indigo-300">
                      {note.kind === 'voice' ? 'Voice' : 'Text'}
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

                {note.researchSummary && (
                  <div className="mt-2 border-t border-gray-800 pt-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Research
                    </p>
                    {note.researchKeywords && note.researchKeywords.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {note.researchKeywords.map((keyword) => (
                          <span
                            key={keyword}
                            className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-300"
                          >
                            {keyword}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="mt-2 text-sm text-gray-200">{note.researchSummary}</p>
                    {note.researchLinks && note.researchLinks.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {note.researchLinks.slice(0, 5).map((link) => (
                          <li key={link}>
                            <a
                              href={link}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate text-xs text-indigo-400 hover:underline"
                            >
                              {link}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="mt-2">
                  <div className="flex flex-wrap gap-2">
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
                    <button
                      type="button"
                      onClick={() => handleResearchClick(note)}
                      disabled={researchLoadingId === note.id}
                      className="rounded-md border border-gray-700 px-2 py-1 text-xs font-medium text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {researchLoadingId === note.id
                        ? 'Researching…'
                        : note.researchSummary
                          ? 'Re-research this'
                          : 'Research this'}
                    </button>
                  </div>
                  {lensErrors[note.id] && (
                    <p className="mt-1 text-xs text-red-400">{lensErrors[note.id]}</p>
                  )}
                  {researchErrors[note.id] && (
                    <p className="mt-1 text-xs text-red-400">{researchErrors[note.id]}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  )
}

export default VideoWorkspace
