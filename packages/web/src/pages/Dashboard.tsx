import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { VideoSummary } from '@vid-mark/shared'
import AppHeader from '../components/AppHeader'
import { listVideos, deleteVideo } from '../lib/api'

// The video dashboard: a grid of thumbnails (never the full videos). Clicking a
// card opens that video's notes page. The hardcoded demo shows as a static card.
// Uploaded cards have a "⋮" menu with Delete (removes the video + its notes).

// Notes are stored in this localStorage array (see VideoWorkspace). When a video
// is deleted we also drop its notes locally so nothing stale lingers.
const NOTES_STORAGE_KEY = 'vidscribe:notes:v1'

function removeLocalNotesForVideo(videoId: string) {
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    const kept = parsed.filter((n) => n?.videoId !== videoId)
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(kept))
  } catch {
    /* ignore */
  }
}

function formatDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null
  const total = Math.floor(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface CardProps {
  to: string
  title: string
  thumbnailDataUrl: string | null
  badge?: string | null
  /** When provided, the card shows a ⋮ menu with Delete. */
  onDelete?: () => void
  deleting?: boolean
}

function VideoCard({ to, title, thumbnailDataUrl, badge, onDelete, deleting }: CardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close the menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900 hover:border-indigo-500">
      <Link to={to} className="flex flex-col">
        <div className="relative aspect-video w-full bg-black">
          {thumbnailDataUrl ? (
            <img src={thumbnailDataUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-600">
              <span className="text-3xl">▶</span>
            </div>
          )}
          {badge && (
            <span className="absolute bottom-2 right-2 rounded bg-gray-950/80 px-1.5 py-0.5 text-xs font-mono text-gray-200">
              {badge}
            </span>
          )}
        </div>
        <p className="truncate px-3 py-2 text-sm font-medium text-gray-200 group-hover:text-white">
          {title}
        </p>
      </Link>

      {onDelete && (
        <div ref={menuRef} className="absolute right-2 top-2">
          <button
            type="button"
            aria-label="Video options"
            title="Options"
            disabled={deleting}
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-950/70 text-gray-200 hover:bg-gray-950 disabled:opacity-50"
          >
            {deleting ? '…' : '⋮'}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 z-10 w-32 overflow-hidden rounded-md border border-gray-700 bg-gray-900 shadow-lg">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete()
                }}
                className="block w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-gray-800"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Dashboard() {
  const [videos, setVideos] = useState<VideoSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listVideos()
      .then((v) => {
        if (cancelled) return
        setVideos(v)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load videos')
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleDelete(video: VideoSummary) {
    if (!window.confirm(`Delete "${video.title}" and all its notes? This can't be undone.`)) {
      return
    }
    setError(null)
    setDeletingId(video.id)
    try {
      await deleteVideo(video.id)
      removeLocalNotesForVideo(video.id)
      setVideos((prev) => prev.filter((v) => v.id !== video.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete video')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <main className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <AppHeader />
      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="mb-4 text-lg font-semibold">Your videos</h2>

        {status === 'loading' && <p className="text-sm text-gray-400">Loading…</p>}
        {status === 'error' && <p className="text-sm text-red-400">{error}</p>}
        {status === 'ready' && error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {videos.map((video) => (
            <VideoCard
              key={video.id}
              to={`/videos/${video.id}`}
              title={video.title}
              thumbnailDataUrl={video.thumbnailDataUrl}
              badge={formatDuration(video.durationSec)}
              deleting={deletingId === video.id}
              onDelete={() => handleDelete(video)}
            />
          ))}
        </div>

        {status === 'ready' && videos.length === 0 && (
          <p className="mt-4 text-sm text-gray-500">
            No uploads yet. Use the + button in the top right to add a video.
          </p>
        )}
      </div>
    </main>
  )
}

export default Dashboard
