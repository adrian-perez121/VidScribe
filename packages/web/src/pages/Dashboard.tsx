import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { VideoSummary } from '@vid-mark/shared'
import AppHeader from '../components/AppHeader'
import { listVideos } from '../lib/api'

// The video dashboard: a grid of thumbnails (never the full videos). Clicking a
// card opens that video's notes page. The hardcoded demo shows as a static card.

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
}

function VideoCard({ to, title, thumbnailDataUrl, badge }: CardProps) {
  return (
    <Link
      to={to}
      className="group flex flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900 hover:border-indigo-500"
    >
      <div className="relative aspect-video w-full bg-black">
        {thumbnailDataUrl ? (
          <img
            src={thumbnailDataUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
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
  )
}

function Dashboard() {
  const [videos, setVideos] = useState<VideoSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

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

  return (
    <main className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <AppHeader />
      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="mb-4 text-lg font-semibold">Your videos</h2>

        {status === 'loading' && <p className="text-sm text-gray-400">Loading…</p>}
        {status === 'error' && <p className="text-sm text-red-400">{error}</p>}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {/* The hardcoded demo, always available as a static card. */}
          <VideoCard to="/" title="Cell physiology (demo)" thumbnailDataUrl={null} badge="demo" />

          {videos.map((video) => (
            <VideoCard
              key={video.id}
              to={`/videos/${video.id}`}
              title={video.title}
              thumbnailDataUrl={video.thumbnailDataUrl}
              badge={formatDuration(video.durationSec)}
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
