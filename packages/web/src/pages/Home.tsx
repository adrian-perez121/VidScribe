import { useRef, useState } from 'react'
import type { VidscribeNote } from '@vid-mark/shared'

const VIDEO_ID = 'cell-physiology-demo'

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [notes, setNotes] = useState<VidscribeNote[]>([])
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [draftTimestamp, setDraftTimestamp] = useState(0)
  const [draftText, setDraftText] = useState('')

  function handleTextNoteClick() {
    const video = videoRef.current
    if (!video) return
    video.pause()
    setDraftTimestamp(video.currentTime)
    setDraftText('')
    setIsComposerOpen(true)
  }

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

  return (
    <main className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <header className="shrink-0 border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Vidscribe</h1>
        <p className="text-sm text-gray-400">video notes that remember the moment</p>
      </header>

      <div className="flex flex-1 flex-col gap-6 overflow-hidden p-6 lg:flex-row">
        <section className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-800 bg-black">
            <video
              ref={videoRef}
              className="h-full w-full object-contain"
              src="/demo-video.mp4"
              controls
            />
          </div>

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
                <li key={note.id}>
                  <button
                    type="button"
                    onClick={() => handleNoteClick(note)}
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 p-3 text-left hover:border-indigo-500"
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
