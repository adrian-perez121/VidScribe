import { createStagehand } from '../lib/stagehand.js'

// Step 1 smoke test: can we construct a Stagehand instance, spin up a real
// Browserbase session, connect over CDP, and navigate? No LLM/extract yet —
// that's exercised in the research service (step 2).
async function main() {
  const sh = createStagehand()
  await sh.init()
  try {
    console.log(`✅ Browserbase session started: ${sh.browserbaseSessionID}`)
    const page = await sh.context.newPage('https://example.com')
    console.log(`   navigated to: ${page.url()}`)
    console.log(`   page title:   ${await page.title()}`)
    console.log('✅ Stagehand connected and navigated successfully.')
  } finally {
    await sh.close()
  }
}

main().catch((e) => {
  console.error('❌ Stagehand connectivity check failed:')
  console.error(e)
  process.exit(1)
})
