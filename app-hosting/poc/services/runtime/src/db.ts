import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const SHORT_ID = process.env.APP_SHORT_ID || 'unknown'
const SCHEMA_NAME = `app_${SHORT_ID}`

interface ColumnDef {
  [colName: string]: string
}

interface TableDef {
  columns: ColumnDef
}

interface SchemaDef {
  tables: { [tableName: string]: TableDef }
}

export async function initSchema(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME}`)
  console.log(`Schema ${SCHEMA_NAME} ensured`)
}

export async function createTables(schemaDefJson: string): Promise<void> {
  const def: SchemaDef = JSON.parse(schemaDefJson)

  // Always create app_users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.app_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'viewer',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `)

  // Create app-defined tables
  for (const [tableName, tableDef] of Object.entries(def.tables)) {
    const cols = Object.entries(tableDef.columns)
      .map(([name, type]) => `"${name}" ${type}`)
      .join(', ')
    await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}."${tableName}" (${cols})`)
    console.log(`Table ${SCHEMA_NAME}."${tableName}" ensured`)
  }
}

export async function listRecords(table: string, limit = 50, offset = 0): Promise<{ records: any[]; total: number }> {
  const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '')
  const countResult = await pool.query(`SELECT COUNT(*) as total FROM ${SCHEMA_NAME}."${safeTable}"`)
  const result = await pool.query(
    `SELECT * FROM ${SCHEMA_NAME}."${safeTable}" ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  )
  return { records: result.rows, total: Number(countResult.rows[0].total) }
}

export async function getRecord(table: string, id: number): Promise<any | null> {
  const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '')
  const result = await pool.query(`SELECT * FROM ${SCHEMA_NAME}."${safeTable}" WHERE id = $1`, [id])
  return result.rows[0] || null
}

export async function createRecord(table: string, data: Record<string, any>): Promise<any> {
  const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '')
  const keys = Object.keys(data).map(k => `"${k}"`)
  const values = Object.values(data)
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  const result = await pool.query(
    `INSERT INTO ${SCHEMA_NAME}."${safeTable}" (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  )
  return result.rows[0]
}

export async function updateRecord(table: string, id: number, data: Record<string, any>): Promise<any | null> {
  const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '')
  const sets = Object.keys(data).map((k, i) => `"${k}" = $${i + 1}`).join(', ')
  const values = [...Object.values(data), id]
  const result = await pool.query(
    `UPDATE ${SCHEMA_NAME}."${safeTable}" SET ${sets} WHERE id = $${values.length} RETURNING *`,
    values
  )
  return result.rows[0] || null
}

export async function deleteRecord(table: string, id: number): Promise<boolean> {
  const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '')
  const result = await pool.query(`DELETE FROM ${SCHEMA_NAME}."${safeTable}" WHERE id = $1`, [id])
  return result.rowCount !== null && result.rowCount > 0
}

export async function findUserByUsername(username: string): Promise<any | null> {
  const result = await pool.query(
    `SELECT * FROM ${SCHEMA_NAME}.app_users WHERE username = $1`,
    [username]
  )
  return result.rows[0] || null
}

export async function createUser(username: string, passwordHash: string, displayName: string): Promise<any> {
  const result = await pool.query(
    `INSERT INTO ${SCHEMA_NAME}.app_users (username, password_hash, display_name, role) VALUES ($1, $2, $3, 'editor') RETURNING id, username, display_name, role`,
    [username, passwordHash, displayName]
  )
  return result.rows[0]
}

export { pool }
