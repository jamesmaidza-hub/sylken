import postgres from 'postgres'

export type Sql = postgres.Sql<{}>
export type Tx = postgres.TransactionSql<{}>

const url = process.env.DATABASE_URL ?? 'postgres://sylken_app:sylken_app@localhost:5433/sylken'

// Numerics come back as strings by default; we convert at the edges with num().
export const sql: Sql = postgres(url, { max: Number(process.env.DB_POOL ?? 10), onnotice: () => {} })

export function connect(connUrl: string): Sql {
  return postgres(connUrl, { max: 4, onnotice: () => {} })
}

/** Run fn in a transaction scoped to one tenant. Row-level security does the rest. */
export async function withTenant<T>(db: Sql, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`
    return fn(tx)
  }) as Promise<T>
}

export function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v)
}
