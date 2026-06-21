import AppHeader from '../components/AppHeader'
import VideoWorkspace from '../components/VideoWorkspace'

// Landing page: the original hardcoded demo video + notes, unchanged in
// behavior. Notes live in localStorage only (persist defaults to false), exactly
// as before. The demo file stays in web/public.
const DEMO_VIDEO_ID = 'cell-physiology-demo'

function Home() {
  return (
    <main className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <AppHeader />
      <VideoWorkspace videoId={DEMO_VIDEO_ID} videoSrc="/demo-video.mp4" />
    </main>
  )
}

export default Home
