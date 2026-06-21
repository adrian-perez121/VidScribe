import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { api } from './routes/api.js'

console.log(`ANTHROPIC_API_KEY set: ${Boolean(process.env.ANTHROPIC_API_KEY)}`)

const app = new Hono()

app.use('*', logger())

// All backend endpoints live under /api (matches the Vite dev proxy).
app.route('/api', api)

// In production, serve the built React frontend from the web package.
// In dev you don't need this — Vite serves the frontend on :5173 and
// proxies /api here.
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: '../web/dist' }))
  // SPA fallback: any non-API route returns index.html.
  app.get('*', serveStatic({ path: '../web/dist/index.html' }))
}

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
