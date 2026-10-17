import { app, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron'
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

export interface ForgeProcessHost extends ForgeHost {
  /** The built engine (the bundled worker.ts). */
  readonly workerPath: string
}

export function mountForgeProcess(host: ForgeProcessHost): { stop: () => Promise<void> } {
  const send = sender(host)
  let child: UtilityProcess | null = null
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
    const engine = utilityProcess.fork(host.workerPath, [], { serviceName: 'Forge engine' })
    child = engine
    ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('The Forge engine did not start within 20 seconds.')) }, START_MS)
      engine.on('message', (message: { t?: string; [key: string]: unknown }) => {
        if (message.t === 'ready') { clearTimeout(timer); resolve() }
        else if (message.t === 'res' && typeof message.id === 'number') { waiting.get(message.id)?.(message.result); waiting.delete(message.id) }
        else if (message.t === 'push' && typeof message.channel === 'string') send(message.channel, message.value)
        else if (message.t === 'notify') showNotice(host, message.notice as ForgeNotice)
        else if (message.t === 'ticket' && typeof message.ticket === 'string') { tickets.get(message.ticket)?.done(message.result as { ok: boolean }); tickets.delete(message.ticket) }
        else if (message.t === 'call' && typeof message.id === 'number') {
          const id = message.id
          void answer(String(message.method), Array.isArray(message.args) ? message.args : [])
            .then(value => { engine.postMessage({ t: 'ret', id, ok: true, value }) })
            .catch((error: unknown) => { engine.postMessage({ t: 'ret', id, ok: false, error: error instanceof Error ? error.message : String(error), stopped: host.security?.isStop(error) === true }) })
        }
      })
      engine.on('exit', () => {
        clearTimeout(timer)
        if (child === engine) { child = null; ready = null }
        failAll('The Forge engine stopped.')
        reject(new Error('The Forge engine stopped while starting.'))
        send('freya:forge:event', { directory: '', event: { type: 'engine-stopped', properties: {} } })
      })
      engine.postMessage({ t: 'init', dataDir: app.getPath('userData'), documentsDir: app.getPath('documents'), security: host.security !== undefined })
    })
    return ready
  }

  /** Stop the engine: it closes its terminals (keeping what ran for Restore), then goes; at most a few seconds. */
  const stop = async (): Promise<void> => {
    const engine = child
    if (!engine) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { engine.kill(); resolve() }, 4_000)
      engine.once('exit', () => { clearTimeout(timer); resolve() })
      engine.postMessage({ t: 'shutdown' })
    })
    child = null
    ready = null
  }

  const request = (input: unknown): Promise<unknown> => new Promise((resolve) => {
    if (!child) { resolve({ ok: false, error: 'The Forge engine is not running.' }); return }
    next += 1
    const id = next
    const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'The Forge engine did not answer in time.' }) }, REQUEST_MS)
    waiting.set(id, (result) => { clearTimeout(timer); resolve(result) })
    child.postMessage({ t: 'req', id, request: input })
  })

  ipcMain.handle('freya:forge', async (event, input: unknown) => {
    if (event.sender !== host.window()?.webContents) return { ok: false, error: 'not this window' }
    try {
      if ((input as { op?: unknown } | null)?.op === 'restart-forge') {
        await stop()
        await start()
        send('freya:forge:event', { directory: '', event: { type: 'engine-restarted', properties: {} } })
        return { ok: true, value: null }
      }
      if (!child) await start()
      await ready
      return await request(input)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  void start().catch(() => undefined)
  return { stop }
}
