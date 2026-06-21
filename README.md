# Vid-Scribe

An interactive study notebook and video lecture annotation web app that allows users to take cropped screenshots from YouTube videos, annotate lecture content, ask questions about specific concepts, diagrams, or images, and receive plain-language AI explanations powered by Claude.

## Project Structure

```
packages/
  server/   — Hono + TypeScript API server
  web/      — React frontend
  shared/   — Shared TypeScript types
```

## Prerequisites

- Node.js 18+
- A running Postgres database
- An Anthropic API key (get one at https://console.anthropic.com/)

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create `packages/server/.env` from the sample:

   ```sh
   cp packages/server/.env.sample packages/server/.env
   ```

3. Fill in the values in `packages/server/.env`:

   ```
   DATABASE_URL="postgres://..."
   DIRECT_URL="postgres://..."
   ANTHROPIC_API_KEY="sk-ant-..."
   ```

4. Run database migrations:

   ```sh
   npx prisma migrate deploy --schema=packages/server/prisma/schema.prisma
   ```

## Development

Start both the API server (port 3000) and the Vite dev server (port 5173) together:

```sh
npm run dev
```

Or start them separately:

```sh
npm run dev:server   # API only
npm run dev:web      # Frontend only
```

## API Endpoints

### `GET /api/health`

Returns server status.

```json
{ "status": "ok", "time": "2026-06-20T00:00:00.000Z" }
```

### `POST /api/explain`

Accepts a cropped screenshot and a question. Returns a plain-language explanation from Claude.

**Request** — `multipart/form-data`:
| Field    | Type   | Required | Description                  |
|----------|--------|----------|------------------------------|
| `image`  | File   | Yes      | PNG screenshot               |
| `prompt` | String | Yes      | The user's question          |

**Success response** (`200`):
```json
{ "explanation": "..." }
```

**Error responses**:
| Status | Meaning                                    |
|--------|--------------------------------------------|
| `400`  | Missing field or image rejected by model   |
| `429`  | Claude rate limit hit — retry shortly      |
| `500`  | Unexpected server error                    |

**Example with curl:**

```sh
curl -X POST http://localhost:3000/api/explain \
  -F "image=@/path/to/screenshot.png" \
  -F "prompt=What does this graph show?"
```

## Build

```sh
npm run build
```

## License

MIT
