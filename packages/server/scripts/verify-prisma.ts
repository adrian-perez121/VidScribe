import { prisma } from '../lib/prisma.js'

// One read to confirm the client + adapter + connection all work end-to-end.
async function main() {
  const userCount = await prisma.user.count()
  const firstUser = await prisma.user.findFirst({
    include: { posts: true },
    orderBy: { id: 'asc' },
  })
  console.log('✅ Connected — Prisma read succeeded.')
  console.log(`   users: ${userCount}`)
  if (firstUser) {
    console.log(`   first user: ${firstUser.name} <${firstUser.email}> (${firstUser.posts.length} posts)`)
  }
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error('❌ Verification failed:')
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
