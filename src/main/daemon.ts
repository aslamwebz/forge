import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { daemonAddress, daemonCard } from './daemonAddress'
import { engineLink } from './engineLink'
import { paneCount } from './forgeTerminal'
import { shutdownEngine } from './shutdown'

/**
 * The Forge's engine as a process that outlives the app (started detached, by Electron run as
 * Node). Its terminals keep running when the app closes; the app connects again on its local pipe
 * and finds them as they are. One app at a time: a new one takes over. The command line connects
 * beside it and is answered on its own connection. Only a caller with the token
 * from its card is heard. With no app and nothing running for a while, it ends itself.
 */

const IDLE_MS = 10 * 60_000
const LINE_MAX = 64 * 1024 * 1024
const dataDir = process.argv[2]
if (!dataDir) throw new Error('The Forge engine needs its data folder.')
const address = daemonAddress(dataDir)
const token = randomBytes(24).toString('hex')

let client: Socket | null = null
const post = (message: unknown) => { if (client && !client.destroyed) client.write(`${JSON.stringify(message)}\n`) }
const leave = () => {
  try { rmSync(daemonCard(dataDir), { force: true }) } catch { /* gone already */ }
  process.exit(0)
}
const link = engineLink(post, leave)

const shown = (offered: unknown) => {
  if (typeof offered !== 'string' || offered.length !== token.length) return false
  return timingSafeEqual(Buffer.from(offered), Buffer.from(token))
}

/** The command line's messages: start the engine if no app has, and its requests. */
function answer(socket: Socket, message: { t?: unknown; id?: unknown; [key: string]: unknown }): void {
  const reply = (value: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`) }
  if (message.t === 'init') { link.init(String(message.dataDir), String(message.documentsDir)); reply({ t: 'ready' }) }
  else if (message.t === 'req' && typeof message.id === 'number') { const id = message.id; void link.handle(message.request).then((result) => { reply({ t: 'res', id, result }) }) }
}

const server = createServer((socket) => {
  let buffer = ''
  let trusted = false
  let cli = false
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > LINE_MAX) { socket.destroy(); return }
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let message: { t?: unknown; token?: unknown }
      try { message = JSON.parse(line) as typeof message } catch { socket.destroy(); return }
      if (trusted && cli) { answer(socket, message); continue }
      if (trusted) { link.receive(message); continue }
      if (message.t !== 'hello' || !shown(message.token)) { socket.destroy(); return }
      trusted = true
      cli = (message as { role?: unknown }).role === 'cli'
      if (cli) continue
      // A new app takes over: the old one's questions are not coming back.
      if (client && client !== socket) { link.lost(); client.destroy() }
      client = socket
    }
  })
  socket.on('close', () => { if (client === socket) { client = null; link.lost() } })
  socket.on('error', () => undefined)
})

server.on('error', () => { process.exit(1) })
if (process.platform !== 'win32') rmSync(address, { force: true })
server.listen(address, () => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(daemonCard(dataDir), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 })
})

// Nobody connected and nothing running for a while: it ends, as an app would.
let quietSince = Date.now()
setInterval(() => {
  if (client || paneCount() > 0) { quietSince = Date.now(); return }
  if (Date.now() - quietSince < IDLE_MS) return
  shutdownEngine()
  leave()
}, 60_000).unref()
