import { Hono } from 'hono'
import { buildNotesDocx, buildStudyGuideDocx } from '../../lib/exportDocx.js'

// Export endpoints — return downloadable Word (.docx) files.
//   GET /api/export/notes.docx?video_id=        all notes + summaries + timestamps
//   GET /api/export/study-guide.docx?video_id=  the generated study guide
// video_id is optional; omit for the whole library.

export const exportRoute = new Hono()

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function docxResponse(buf: Buffer, filename: string): Response {
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': DOCX_MIME,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buf.length),
    },
  })
}

exportRoute.get('/notes.docx', async (c) => {
  const videoId = c.req.query('video_id') || undefined
  try {
    const buf = await buildNotesDocx(videoId)
    return docxResponse(buf, 'notes.docx')
  } catch (err) {
    console.error('Notes export failed:', err)
    return c.json({ error: 'Failed to export notes. Check server logs for details.' }, 500)
  }
})

exportRoute.get('/study-guide.docx', async (c) => {
  const videoId = c.req.query('video_id') || undefined
  try {
    const buf = await buildStudyGuideDocx(videoId)
    if (!buf) {
      return c.json({ error: 'No notes or transcript found to build a study guide from yet.' }, 404)
    }
    return docxResponse(buf, 'study-guide.docx')
  } catch (err) {
    console.error('Study guide export failed:', err)
    return c.json({ error: 'Failed to export study guide. Check server logs for details.' }, 500)
  }
})
