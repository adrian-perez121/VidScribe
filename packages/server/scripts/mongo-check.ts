import 'dotenv/config'
import { getDb, getNotesCollection, VIDEO_BUCKET } from '../lib/mongo.js'

// Quick connectivity check: confirms we can reach the Atlas cluster and reports
// how many videos and notes the ingest will see.
async function main() {
  const db = await getDb()
  console.log(`Connected. DB: ${db.databaseName}`)

  const videos = await db.collection(`${VIDEO_BUCKET}.files`).countDocuments()
  const notes = await (await getNotesCollection()).countDocuments()
  console.log(`videos: ${videos}`)
  console.log(`notes:  ${notes}`)

  process.exit(0)
}

main().catch((err) => {
  console.error('Mongo check failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
