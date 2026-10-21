import { app, ipcMain, shell, utilityProcess } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { daemonAddress, daemonCard, type DaemonCard } from './daemonAddress'
import { pickFolder, sender, showNotice, type ForgeHost } from './electronPort'
import type { ForgeNotice } from './host'

/**
 * The Forge's engine in a process of its own. Here in the app's main process stays only its door:
 * the page's requests go to the engine and its answers and pushes come back; what the engine asks
 * of the app (a folder dialog, a link, a notice, the security core) is done here. Restarting the
 * Forge restarts only the engine (with whatever build is on disk now); the app keeps running.
 */

const REQUEST_MS = 10 * 60_000
const START_MS = 20_000
const CONNECT_MS = 10_000

export interface ForgeProcessHost extends ForgeHost {
  /** The built engine (the bundled worker.ts). */
  readonly workerPath: string
  /**
   * The built engine that outlives the app (the bundled daemon.ts). Given, the terminals keep
   * running when the app closes and are there again when it opens; closing the app only lets go.
   */
  readonly daemonPath?: string
}

/** What carries messages to and from the engine: a utility process, or the pipe of one that outlives the app. */
interface Carrier {
  post(message: unknown): void
  onMessage(listener: (message: { t?: string; [key: string]: unknown }) => void): void
  onExit(listener: () => void): void
  /** Let go: the engine ends with it (a utility process) or runs on (the pipe). */
  drop(): void
}

function utilityCarrier(workerPath: string): Carrier {
  const engine = utilityProcess.fork(workerPath, [], { serviceName: 'Forge engine' })
  return {
    post: (message) => { engine.postMessage(message) },
    onMessage: (listener) => { engine.on('message', listener) },
    onExit: (listener) => { engine.on('exit', listener) },
    drop: () => { engine.kill() },
  }
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The pipe to the engine that outlives the app, started first when none runs; within ten seconds, or an error. */
async function pipeCarrier(daemonPath: string): Promise<Carrier> {
  const dataDir = app.getPath('userData')
  const attempt = () => new Promise<Carrier | null>((resolve) => {
    let card: DaemonCard
    try { card = JSON.parse(readFileSync(daemonCard(dataDir), 'utf8')) as DaemonCard } catch { resolve(null); return }
    const socket = connect(daemonAddress(dataDir))
    socket.once('error', () => { resolve(null) })
    socket.once('connect', () => {
      socket.setEncoding('utf8')
      socket.write(`${JSON.stringify({ t: 'hello', token: card.token })}\n`)
      const listeners: ((message: { t?: string }) => void)[] = []
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          try { const message = JSON.parse(line) as { t?: string }; for (const listener of listeners) listener(message) } catch { /* not a message */ }
        }
      })
      resolve({
        post: (message) => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`) },
        onMessage: (listener) => { listeners.push(listener) },
        onExit: (listener) => { socket.on('close', listener) },
        drop: () => { socket.destroy() },
      })
    })
  })
  const found = await attempt()
  if (found) return found
  // None runs (or a stale card): start one, detached, and wait for its pipe.
  spawn(process.execPath, [daemonPath, dataDir], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref()
  const deadline = Date.now() + CONNECT_MS
  while (Date.now() < deadline) {
    await pause(250)
    const carrier = await attempt()
    if (carrier) return carrier
  }
  throw new Error('The Forge engine did not start within 10 seconds.')
}

export function mountForgeProcess(host: ForgeProcessHost): { stop: () => Promise<void> } {
  const send = sender(host)
  let child: Carrier | null = null
  let ready: Promise<void> | null = null
  let next = 0
  const waiting = new Map<number, (result: unknown) => void>()
  const tickets = new Map<string, { done(result: { ok: boolean }): void }>()

  const failAll = (reason: string) => {
    for (const resolve of waiting.values()) resolve({ ok: false, error: reason })
    waiting.clear()
    for (const ticket of tickets.values()) ticket.done({ ok: false })
    tickets.clear()
  }

  /** What the engine asks of the app. */
  const answer = async (method: string, args: unknown[]): Promise<unknown> => {
    const security = host.security
    switch (method) {
      case 'pickFolder': return pickFolder(host, String(args[0]), args[1] === true)
      case 'openExternal': { await shell.openExternal(String(args[0])); return null }
      case 'security.issueIdentity': {
        if (!security) throw new Error('There is no security core.')
        return security.issueIdentity(String(args[0]), 'lead', String(args[2]))
      }
      case 'security.pass': {
        if (!security) throw new Error('There is no security core.')
        const ticket = await security.pass(args[0] as Parameters<typeof security.pass>[0])
        const id = `${String(Date.now())}-${String(Math.random()).slice(2)}`
        tickets.set(id, ticket)
        return { ticket: id }
      }
      default: throw new Error(`The engine asked for something unknown: ${method}`)
    }
  }

  const start = (): Promise<void> => {
    ready = (host.daemonPath ? pipeCarrier(host.daemonPath) : Promise.resolve(utilityCarrier(host.workerPath))).then(engine => attach(engine))
    return ready
  }
  const attach = (engine: Carrier): Promise<void> => {
    child = engine
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('The Forge engine did not start within 20 seconds.')) }, START_MS)
      engine.onMessage((message) => {
        if (message.t === 'ready') { clearTimeout(timer); resolve() }
        else if (message.t === 'res' && typeof message.id === 'number') { waiting.get(message.id)?.(message.result); waiting.delete(message.id) }
        else if (message.t === 'push' && typeof message.channel === 'string') send(message.channel, message.value)
        else if (message.t === 'notify') showNotice(host, message.notice as ForgeNotice)
        else if (message.t === 'ticket' && typeof message.ticket === 'string') { tickets.get(message.ticket)?.done(message.result as { ok: boolean }); tickets.delete(message.ticket) }
        else if (message.t === 'call' && typeof message.id === 'number') {
          const id = message.id
          void answer(String(message.method), Array.isArray(message.args) ? message.args : [])
            .then(value => { engine.post({ t: 'ret', id, ok: true, value }) })
            .catch((error: unknown) => { engine.post({ t: 'ret', id, ok: false, error: error instanceof Error ? error.message : String(error), stopped: host.security?.isStop(error) === true }) })
        }
      })
      engine.onExit(() => {
        clearTimeout(timer)
        if (child === engine) { child = null; ready = null }
        failAll('The Forge engine stopped.')
        reject(new Error('The Forge engine stopped while starting.'))
        send('freya:forge:event', { directory: '', event: { type: 'engine-stopped', properties: {} } })
      })
      engine.post({ t: 'init', dataDir: app.getPath('userData'), documentsDir: app.getPath('documents'), security: host.security !== undefined })
    })
  }

  /** End the engine: it closes its terminals (keeping what ran for Restore), then goes; at most a few seconds. */
  const end = async (): Promise<void> => {
    const engine = child
    if (!engine) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { engine.drop(); resolve() }, 4_000)
      engine.onExit(() => { clearTimeout(timer); resolve() })
      engine.post({ t: 'shutdown' })
    })
    child = null
    ready = null
  }
  /** The app closes: an engine that outlives it is only let go, its terminals running on; any other ends. */
  const stop = async (): Promise<void> => {
    if (!host.daemonPath) { await end(); return }
    const engine = child
    child = null
    ready = null
    engine?.drop()
  }

  const request = (input: unknown): Promise<unknown> => new Promise((resolve) => {
    if (!child) { resolve({ ok: false, error: 'The Forge engine is not running.' }); return }
    next += 1
    const id = next
    const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'The Forge engine did not answer in time.' }) }, REQUEST_MS)
    waiting.set(id, (result) => { clearTimeout(timer); resolve(result) })
    child.post({ t: 'req', id, request: input })
  })

  ipcMain.handle('freya:forge', async (event, input: unknown) => {
    if (event.sender !== host.window()?.webContents) return { ok: false, error: 'not this window' }
    try {
      if ((input as { op?: unknown } | null)?.op === 'restart-forge') {
        await end()
        await start()
        send('freya:forge:event', { directory: '', event: { type: 'engine-restarted', properties: {} } })
        return { ok: true, value: null }
      }
      await (ready ?? start())
      return await request(input)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  void start().catch(() => undefined)
  return { stop }
}
