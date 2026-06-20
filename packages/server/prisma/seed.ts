import { prisma } from '../lib/prisma.js'

// Seed a handful of rows. Idempotent via upsert so re-running is safe.
async function main() {
  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      email: 'alice@example.com',
      name: 'Alice',
      posts: {
        create: [
          { title: 'Hello world', content: 'My first post', published: true },
          { title: 'Draft idea', content: 'Still cooking' },
        ],
      },
    },
  })

  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      email: 'bob@example.com',
      name: 'Bob',
      posts: {
        create: [{ title: 'Bob says hi', content: 'A published post', published: true }],
      },
    },
  })

  console.log(`Seeded users: ${alice.name}, ${bob.name}`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
