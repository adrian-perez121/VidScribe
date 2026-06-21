import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import VideoWorkspace from '../components/VideoWorkspace'
import { getVideo } from '../lib/api'

// An uploaded video's page: the same workspace as the demo, but the video
// streams from GridFS and notes are mirrored to / hydrated from the database.

function VideoPage() {
  const { id = '' } = useParams()
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
    <main className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <AppHeader />
      {error ? (
        <div className="p-6 text-sm text-red-400">{error}</div>
      ) : (
        <VideoWorkspace
          key={id}
          videoId={id}
          videoSrc={`/api/videos/${id}/stream`}
          persist
          title={title}
        />
      )}
    </main>
  )
}

export default VideoPage
