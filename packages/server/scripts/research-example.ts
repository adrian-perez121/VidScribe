import { researchTopic } from '../lib/research.js'

// Step 2 demo: take a chunk of lecture transcript, filter it to keywords,
// search the web with Browserbase/Stagehand, and print the top 3 sources with
// a summary of each. Run with: npx tsx scripts/research-example.ts

// A stand-in for a chunk of lecture transcript. Swap this out to try other topics.
const TRANSCRIPT_CHUNK = `
  Today we're going to talk about photosynthesis. Photosynthesis is the process
  by which plants, algae, and some bacteria convert light energy into chemical
  energy stored in glucose. It happens in the chloroplasts, specifically using
  the green pigment chlorophyll. There are two main stages: the light-dependent
  reactions, which take place in the thylakoid membranes, and the Calvin cycle,
  which fixes carbon dioxide into sugar in the stroma.
`

async function main() {
  console.log('🔎 Researching transcript chunk...\n')
  const { keywords, results } = await researchTopic(TRANSCRIPT_CHUNK)

  console.log(`Keywords (search query): ${keywords.join(' ')}\n`)

  if (results.length === 0) {
    console.log('No results found.')
    return
  }

  results.forEach((r, i) => {
    console.log(`#${i + 1}  ${r.link}`)
    console.log(`    ${r.summary}\n`)
  })
}

main().catch((e) => {
  console.error('❌ Research example failed:')
  console.error(e)
  process.exit(1)
})
