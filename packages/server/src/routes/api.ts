import { Hono } from 'hono'
import type { HealthResponse } from '@vid-mark/shared'

export const api = new Hono()

api.get('/health', (c) => {
  const body: HealthResponse = {
    status: 'ok',
    time: new Date().toISOString(),
  }
  return c.json(body)
})
