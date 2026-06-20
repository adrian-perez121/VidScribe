import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

// Server-side only — never import this from browser/client components.

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is not set (see .env)')
}

// Connect through the pg driver adapter.
const adapter = new PrismaPg({ connectionString })

// Reuse a single PrismaClient across hot-reloads in dev to avoid exhausting
// connections. In prod this is just a module-level singleton.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
