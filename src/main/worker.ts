import { createEngine, type ForgeEngine } from './engine'
import { setPort, type ForgeNotice } from './host'
import { shutdownEngine } from './shutdown'

/**
 * The Forge's engine in a process of its own (an Electron utility process). It speaks to the app
 * only through messages: requests from the page come in, answers and pushes go out, and what it
 * needs from the app (a folder dialog, a link opened, a notice, the security core) it asks for.
 */

interface ParentPort { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void }
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error('The Forge engine runs as a utility process of an app.')
const post = (message: unknown) => { parent.postMessage(message) }

let engine: ForgeEngine | null = null
let next = 0
const asked = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
/** Ask the app for something; its answer, or the error it gave (a stop by the security core says so). */
function ask<T>(method: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    next += 1
    asked.set(next, { resolve: resolve as (value: unknown) => void, reject })
    post({ t: 'call', id: next, method, args })
  })
}

parent.on('message', (event) => {
  const message = event.data as { t?: string; id?: number; [key: string]: unknown }
  if (message.t === 'init') {
    setPort({
      dataDir: String(message.dataDir), documentsDir: String(message.documentsDir),
      push: (channel, value) => { post({ t: 'push', channel, value }) },
      pickFolder: (title, create) => ask<string | null>('pickFolder', [title, create]),
      openExternal: url => ask<undefined>('openExternal', [url]).then(() => undefined),
      notify: (notice: ForgeNotice) => { post({ t: 'notify', notice }) },
      ...(message.security === true ? { security: {
        issueIdentity: (id: string, kind: 'lead', name: string) => ask<{ id: string }>('security.issueIdentity', [id, kind, name]),
        pass: async (request) => {
          const { ticket } = await ask<{ ticket: string }>('security.pass', [request])
          return { done: (result) => { post({ t: 'ticket', ticket, result }) } }
        },
        isStop: error => (error as { stopped?: unknown } | null)?.stopped === true,
      } } : {}),
    })
    engine = createEngine()
    post({ t: 'ready' })
  } else if (message.t === 'req' && typeof message.id === 'number') {
    const id = message.id
    void (engine ? engine.handle(message.request) : Promise.resolve({ ok: false as const, error: 'The Forge engine is not ready.' }))
      .then((result) => { post({ t: 'res', id, result }) })
  } else if (message.t === 'ret' && typeof message.id === 'number') {
    const waiting = asked.get(message.id)
    asked.delete(message.id)
    if (!waiting) return
    if (message.ok === true) waiting.resolve(message.value)
    else waiting.reject(Object.assign(new Error(String(message.error)), { stopped: message.stopped === true }))
  } else if (message.t === 'shutdown') {
    shutdownEngine()
    post({ t: 'down' })
    setTimeout(() => { process.exit(0) }, 100)
  }
})
