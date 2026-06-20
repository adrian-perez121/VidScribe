import { useState } from 'react'
import type { HealthResponse } from '@vid-mark/shared'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)

  async function checkHealth() {
    const res = await fetch('/api/health')
    setHealth((await res.json()) as HealthResponse)
  }

  return (
    <>
      <div>
        <a href="https://vitejs.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>vid-mark</h1>
      <div className="card">
        <button onClick={checkHealth}>Ping API</button>
        <p>
          {health
            ? `API: ${health.status} @ ${health.time}`
            : 'Click to call the Hono backend'}
        </p>
      </div>
      <p className="read-the-docs">React + Vite frontend · Hono backend</p>
    </>
  )
}

export default App
