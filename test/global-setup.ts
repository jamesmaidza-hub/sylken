import postgres from 'postgres'
import { migrate } from '../src/db/migrate.js'

// Tests run against a throwaway database on a real PostgreSQL server.
// TEST_ADMIN_URL must point at a superuser connection; the test database is recreated each run.
const adminUrl = process.env.TEST_ADMIN_URL ?? 'postgres://postgres@localhost:5433/postgres'
export const TEST_DB = 'sylken_test'

export default async function setup() {
  const root = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await root.unsafe(`drop database if exists ${TEST_DB} with (force)`)
  await root.unsafe(`create database ${TEST_DB}`)
  await root.end()
  const admin = postgres(adminUrl.replace(/\/[^/]*$/, `/${TEST_DB}`), { max: 1, onnotice: () => {} })
  await migrate(admin, 'sylken_test_app', 'sylken_test_app').catch(async (e) => {
    // The role may exist from an earlier run with a different database; that's fine.
    throw e
  })
  await admin.end()
}
