import Fastify from 'fastify'
import { initSchema, createTables, listRecords, getRecord, createRecord, updateRecord, deleteRecord, findUserByUsername, createUser, pool } from './db'
import { hashPassword, verifyPassword, generateToken, verifyToken } from './auth'
import { listFiles, getPresignedUploadUrl, getPresignedDownloadUrl } from './files'

declare module 'fastify' {
  interface FastifyRequest {
    userId: number | null
    userRole: string | null
  }
}

const APP_ID = process.env.APP_ID || 'unknown'
const APP_SHORT_ID = process.env.APP_SHORT_ID || 'unknown'
const ORG_ID = process.env.ORG_ID || 'unknown'
const SCHEMA_DEF = process.env.SCHEMA_DEF || '{"tables":{}}'
const AGENT_BRIDGE_URL = process.env.AGENT_BRIDGE_URL || ''
const AGENT_BRIDGE_TOKEN = process.env.AGENT_BRIDGE_TOKEN || ''

const app = Fastify({ logger: true })

// Auth middleware
app.decorateRequest('userId', null)
app.decorateRequest('userRole', null)

app.addHook('onRequest', async (request) => {
  const auth = request.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    const decoded = verifyToken(auth.slice(7))
    if (decoded) {
      request.userId = decoded.sub
      request.userRole = decoded.role
    }
  }
})

// Health
app.get('/health', async () => ({
  status: 'ok',
  appId: APP_ID,
  schemaName: `app_${APP_SHORT_ID}`,
  orgId: ORG_ID,
}))

// Auth routes
app.post('/api/auth/register', async (request, reply) => {
  const { username, password, displayName } = request.body as any
  if (!username || !password) {
    return reply.status(400).send({ error: 'username and password required' })
  }
  const existing = await findUserByUsername(username)
  if (existing) {
    return reply.status(409).send({ error: 'username already exists' })
  }
  const pwHash = await hashPassword(password)
  const user = await createUser(username, pwHash, displayName || username)
  const token = generateToken(user)
  return { user: { id: user.id, username: user.username, role: user.role }, token }
})

app.post('/api/auth/login', async (request, reply) => {
  const { username, password } = request.body as any
  const user = await findUserByUsername(username)
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return reply.status(401).send({ error: 'invalid credentials' })
  }
  const token = generateToken({ id: user.id, username: user.username, role: user.role })
  return { user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role }, token }
})

app.get('/api/auth/me', async (request, reply) => {
  if (!request.userId) return reply.status(401).send({ error: 'unauthorized' })
  return { userId: request.userId, appId: APP_ID, role: request.userRole }
})

// Data CRUD
app.get('/api/data/:table', async (request) => {
  const { table } = request.params as { table: string }
  const limit = Number((request.query as any).limit) || 50
  const offset = Number((request.query as any).offset) || 0
  return listRecords(table, limit, offset)
})

app.get('/api/data/:table/:id', async (request, reply) => {
  const { table, id } = request.params as { table: string; id: string }
  const record = await getRecord(table, Number(id))
  if (!record) return reply.status(404).send({ error: 'not found' })
  return record
})

app.post('/api/data/:table', async (request) => {
  const { table } = request.params as { table: string }
  const data = request.body as Record<string, any>
  return createRecord(table, data)
})

app.put('/api/data/:table/:id', async (request, reply) => {
  const { table, id } = request.params as { table: string; id: string }
  const data = request.body as Record<string, any>
  const record = await updateRecord(table, Number(id), data)
  if (!record) return reply.status(404).send({ error: 'not found' })
  return record
})

app.delete('/api/data/:table/:id', async (request, reply) => {
  const { table, id } = request.params as { table: string; id: string }
  const deleted = await deleteRecord(table, Number(id))
  if (!deleted) return reply.status(404).send({ error: 'not found' })
  return { deleted: true }
})

// File operations
app.get('/api/files', async () => {
  return { files: await listFiles() }
})

app.post('/api/files/presign', async (request) => {
  const { fileName } = request.body as { fileName: string }
  const url = await getPresignedUploadUrl(fileName)
  return { uploadUrl: url }
})

app.get('/api/files/:key/presign', async (request) => {
  const { key } = request.params as { key: string }
  const url = await getPresignedDownloadUrl(key)
  return { downloadUrl: url }
})

// Agent bridge proxy
app.post('/api/agent/chat', async (request, reply) => {
  if (!AGENT_BRIDGE_URL) {
    return { reply: 'Agent Bridge not configured. Running in standalone mode.' }
  }
  try {
    const resp = await fetch(AGENT_BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGENT_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify({
        agentId: 'default',
        message: (request.body as any).message,
        context: { appId: APP_ID, orgId: ORG_ID },
      }),
    })
    return await resp.json()
  } catch (err: any) {
    return { reply: `Agent Bridge error: ${err.message}` }
  }
})

// Start
async function start() {
  try {
    console.log(`Initializing schema app_${APP_SHORT_ID}...`)
    await initSchema()
    console.log('Creating tables from SCHEMA_DEF...')
    await createTables(SCHEMA_DEF)
    console.log('All tables ready.')

    const port = Number(process.env.PORT) || 3000
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`App Runtime listening on port ${port}`)
    console.log(`  APP_ID: ${APP_ID}`)
    console.log(`  Schema: app_${APP_SHORT_ID}`)
    console.log(`  ORG_ID: ${ORG_ID}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
