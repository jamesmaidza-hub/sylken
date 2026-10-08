import { connect } from '../db/index.js'
import { migrate } from '../db/migrate.js'

const admin = connect(process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5433/sylken')
const applied = await migrate(admin, 'sylken_app', process.env.APP_DB_PASSWORD ?? 'sylken_app')
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date')
await admin.end()
