import { z } from 'zod'
import { createStagehand } from '../lib/stagehand.js'

// Mirrors the Browserbase/Stagehand docs "act + extract" demo:
// open Hacker News, let the AI click into the top story's comments, then
// extract structured data. Run with: npx tsx scripts/stagehand-example.ts
async function main() {
  const stagehand = createStagehand()
  await stagehand.init()
  try {
    console.log(`Browserbase session: ${stagehand.browserbaseSessionID}`)

    const page = stagehand.context.pages()[0]
    await page.goto('https://news.ycombinator.com')

    // Let AI click
    await stagehand.act('click on the comments link for the top story')

    // Extract structured data (typed via zod)
    const data = await stagehand.extract(
      'extract the title, points, and number of comments for this story',
      z.object({
        title: z.string().describe('the story title'),
        points: z.number().describe('number of points/upvotes'),
        comments: z.number().describe('number of comments'),
      }),
    )
    console.log(data)
  } finally {
    await stagehand.close()
  }
}

main().catch((e) => {
  console.error('❌ Stagehand example failed:')
  console.error(e)
  process.exit(1)
})
