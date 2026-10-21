import { createEngine, type ForgeEngine, type ForgeResult } from './engine'
import { setPort, type ForgeNotice, type ForgeSecurity } from './host'
import { shutdownEngine } from './shutdown'

/**
 * The engine's side of the messages between it and the app that shows it, whatever carries them
 * (a utility process's port, or the local pipe of the engine that outlives the app). Requests from
 * the page come in, answers and pushes go out, and what it needs from the app (a folder dialog, a
 * link opened, a notice, the security core) it asks for. With no app connected, asking fails and
 * what it would show is dropped: the terminals run on.
 */
export interface EngineLink {
  /** One message from the app. */
  receive(message: unknown): void
  /** The app went away: what it was asked for is not coming. */
  lost(): void
  /** Start the engine for a caller that is not the app (the command line); the app's security flag stays as it was. */
  init(dataDir: string, documentsDir: string): void
  /** A request from such a caller, answered to it alone. */
  handle(request: unknown): Promise<ForgeResult>
}

export function engineLink(post: (message: unknown) => void, exit: () => void): EngineLink {
  let engine: ForgeEngine | null = null
  let secured = false
  let next = 0
  const asked = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  /** Ask the app for something; its answer, or the error it gave (a stop by the security core says so). */
  const ask = <T>(method: string, args: unknown[]): Promise<T> => new Promise((resolve, reject) => {
    next += 1
    asked.set(next, { resolve: resolve as (value: unknown) => void, reject })
    post({ t: 'call', id: next, method, args })
  })
  const security: ForgeSecurity = {
    issueIdentity: (id, kind, name) => ask<{ id: string }>('security.issueIdentity', [id, kind, name]),
    pass: async (request) => {
      const { ticket } = await ask<{ ticket: string }>('security.pass', [request])
      return { done: (result) => { post({ t: 'ticket', ticket, result }) } }
    },
    isStop: error => (error as { stopped?: unknown } | null)?.stopped === true,
  }
  const start = (dataDir: string, documentsDir: string) => {
    if (engine) return
    setPort({
      dataDir, documentsDir,
      push: (channel, value) => { post({ t: 'push', channel, value }) },
      pickFolder: (title, create) => ask<string | null>('pickFolder', [title, create]),
      openExternal: url => ask<undefined>('openExternal', [url]).then(() => undefined),
      notify: (notice: ForgeNotice) => { post({ t: 'notify', notice }) },
      get security() { return secured ? security : undefined },
    })
    engine = createEngine()
  }
  const handle = (request: unknown): Promise<ForgeResult> => engine ? engine.handle(request) : Promise.resolve({ ok: false, error: 'The Forge engine is not ready.' })
  return {
    receive(raw) {
      const message = raw as { t?: string; id?: number; [key: string]: unknown }
      if (message.t === 'init') {
        // An app that connects again finds the same engine, its terminals still running.
        secured = message.security === true
        start(String(message.dataDir), String(message.documentsDir))
        post({ t: 'ready' })
      } else if (message.t === 'req' && typeof message.id === 'number') {
        const id = message.id
        void handle(message.request).then((result) => { post({ t: 'res', id, result }) })
      } else if (message.t === 'ret' && typeof message.id === 'number') {
        const waiting = asked.get(message.id)
        asked.delete(message.id)
        if (!waiting) return
        if (message.ok === true) waiting.resolve(message.value)
        else waiting.reject(Object.assign(new Error(String(message.error)), { stopped: message.stopped === true }))
      } else if (message.t === 'shutdown') {
        shutdownEngine()
        post({ t: 'down' })
        setTimeout(exit, 100)
      }
    },
    init: start,
    handle,
    lost() {
      for (const waiting of asked.values()) waiting.reject(new Error('The Forge app is not open.'))
      asked.clear()
    },
  }
}
