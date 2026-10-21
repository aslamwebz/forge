import { createEngine, type ForgeEngine } from './engine'
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
  return {
    receive(raw) {
      const message = raw as { t?: string; id?: number; [key: string]: unknown }
      if (message.t === 'init') {
        // An app that connects again finds the same engine, its terminals still running.
        secured = message.security === true
        if (!engine) {
          setPort({
            dataDir: String(message.dataDir), documentsDir: String(message.documentsDir),
            push: (channel, value) => { post({ t: 'push', channel, value }) },
            pickFolder: (title, create) => ask<string | null>('pickFolder', [title, create]),
            openExternal: url => ask<undefined>('openExternal', [url]).then(() => undefined),
            notify: (notice: ForgeNotice) => { post({ t: 'notify', notice }) },
            get security() { return secured ? security : undefined },
          })
          engine = createEngine()
        }
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
        setTimeout(exit, 100)
      }
    },
    lost() {
      for (const waiting of asked.values()) waiting.reject(new Error('The Forge app is not open.'))
      asked.clear()
    },
  }
}
