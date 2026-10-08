import { serve } from '@hono/node-server'
import { sql } from './db/index.js'
import { createApp } from './web/app.js'

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: createApp(sql).fetch, port }, () => console.log(`sylken listening on http://localhost:${port}`))
