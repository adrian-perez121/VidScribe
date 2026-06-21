import 'dotenv/config'
import { MongoClient, GridFSBucket, type Db, type Collection } from 'mongodb'
import type { VidscribeNote, VideoTranscript, Flashcard } from '@vid-mark/shared'

// Server-side MongoDB connection. We use the native driver (not Prisma — Prisma
// has no GridFS support) so we can stream large video files into GridFS instead
// of buffering whole files in a single 16MB document.
//
// Connection details come from .env: MONGODB_URI plus optional MONGODB_USERNAME
// / MONGODB_PASSWORD. If the URI already embeds credentials we use it as-is;
// otherwise we inject the username/password (also filling in the usual Atlas
// <username>/<password> placeholders if they're present in the URI).

/** GridFS bucket name for video bytes (creates videos.files / videos.chunks). */
export const VIDEO_BUCKET = 'videos'

/** Database name. Override with MONGODB_DB; defaults to "vidmark". */
const DB_NAME = process.env.MONGODB_DB || 'vidmark'

/** A note as stored in Mongo: the shared shape, keyed by its own id. */
export type NoteDoc = VidscribeNote & { _id: string }

/** A transcript as stored in Mongo: the shared shape, keyed by videoId. */
export type TranscriptDoc = VideoTranscript & { _id: string }

/** A flashcard as stored in Mongo, keyed by its own id (_id === card.id). */
export type FlashcardDoc = Flashcard & { _id: string }

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set (see .env / .env.sample)`)
  }
  return value
}

function buildClient(): MongoClient {
  let uri = requireEnv('MONGODB_URI')
  const username = process.env.MONGODB_USERNAME
  const password = process.env.MONGODB_PASSWORD

  // Fill in the placeholder tokens Atlas leaves in copied connection strings.
  if (username) {
    uri = uri
      .replace('<username>', encodeURIComponent(username))
      .replace('<db_username>', encodeURIComponent(username))
  }
  if (password) {
    uri = uri
      .replace('<password>', encodeURIComponent(password))
      .replace('<db_password>', encodeURIComponent(password))
  }

  // If the URI has no inline credentials, pass them as explicit auth options.
  // Fail server selection in 10s (instead of the 30s default) so a connection
  // problem surfaces quickly instead of hanging each request.
  const hasInlineCredentials = /\/\/[^/@]+@/.test(uri)
  const options: ConstructorParameters<typeof MongoClient>[1] = {
    serverSelectionTimeoutMS: 10000,
  }
  if (!hasInlineCredentials && username && password) {
    options.auth = { username, password }
  }

  return new MongoClient(uri, options)
}

// Connect once and reuse. Cached on globalThis so tsx watch reloads in dev don't
// open a new pool on every reload.
const globalForMongo = globalThis as unknown as {
  mongoClientPromise?: Promise<MongoClient>
}

function clientPromise(): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    const pending = buildClient().connect()
    // Don't cache a FAILED connection: if we did, every later request would
    // reuse the rejected promise and keep failing until the process restarts.
    // Clearing it lets the next request retry (e.g. after fixing the Atlas IP
    // allowlist) without a server restart.
    pending.catch(() => {
      if (globalForMongo.mongoClientPromise === pending) {
        globalForMongo.mongoClientPromise = undefined
      }
    })
    globalForMongo.mongoClientPromise = pending
  }
  return globalForMongo.mongoClientPromise
}

/** Get the application database. */
export async function getDb(): Promise<Db> {
  const client = await clientPromise()
  return client.db(DB_NAME)
}

/** Get the GridFS bucket that stores video bytes. */
export async function getVideoBucket(): Promise<GridFSBucket> {
  const db = await getDb()
  return new GridFSBucket(db, { bucketName: VIDEO_BUCKET })
}

/** The collection that stores notes (one document per note, _id === note.id). */
export async function getNotesCollection(): Promise<Collection<NoteDoc>> {
  const db = await getDb()
  return db.collection<NoteDoc>('notes')
}

/** The collection that stores transcripts (one document per video, _id === videoId). */
export async function getTranscriptsCollection(): Promise<Collection<TranscriptDoc>> {
  const db = await getDb()
  return db.collection<TranscriptDoc>('transcripts')
}

/** The collection that stores flashcards (one document per card, _id === card.id). */
export async function getFlashcardsCollection(): Promise<Collection<FlashcardDoc>> {
  const db = await getDb()
  return db.collection<FlashcardDoc>('flashcards')
}
