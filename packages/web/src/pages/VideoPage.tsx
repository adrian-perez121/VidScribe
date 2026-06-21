import { useEffect, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import VideoWorkspace from '../components/VideoWorkspace'
import { getVideo } from '../lib/api'

function VideoPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const autoGenerateTranscript =
    (location.state as { autoGenerateTranscript?: boolean } | null)?.autoGenerateTranscript === true
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    getVideo(id)
      .then((video) => {
        if (!cancelled) setTitle(video.title)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load video')
      })
    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <main className="flex min-h-screen flex-col bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100 lg:h-screen lg:overflow-hidden">
      <AppHeader />
      {error ? (
        <div className="p-6 text-sm text-red-500 dark:text-red-400">{error}</div>
      ) : (
        <VideoWorkspace
          key={id}
          videoId={id}
          videoSrc={`/api/videos/${id}/stream`}
          persist
          title={title}
          autoGenerateTranscript={autoGenerateTranscript}
        />
      )}
    </main>
  )
}

export default VideoPage
