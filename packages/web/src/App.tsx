import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Dashboard from './pages/Dashboard'
import VideoPage from './pages/VideoPage'
import ChatWidget from './components/ChatWidget'

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/videos/:id" element={<VideoPage />} />
      </Routes>
      <ChatWidget />
    </>
  )
}

export default App
