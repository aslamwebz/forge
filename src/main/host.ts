import type { BrowserWindow } from 'electron'

/**
 * What the app that carries the Forge gives it. The Forge needs only its window; the rest is
 * optional. Without a security core, the lead's tools stay off: nothing commands the agents
 * unchecked.
 */
export interface ForgeSecurity {
  /** A card for a caller (a lead), the same card again for the same id. */
  issueIdentity(id: string, kind: 'lead', name: string): { readonly id: string }
  /** Decide a call before it goes; throws when it is stopped. The ticket says how it went. */
  pass(request: { readonly caller: string; readonly channel: 'forge'; readonly target: string; readonly action: string }): Promise<{ done(result: { ok: boolean }): void }>
  /** Whether an error is the security core stopping a call (its message is for the agent). */
  isStop(error: unknown): boolean
}

export interface ForgeHost {
  readonly window: () => BrowserWindow | null
  readonly security?: ForgeSecurity
  /** Bring the Forge to the front (a notification he clicked). */
  readonly navigate?: () => void
}

let current: ForgeHost | null = null
export function setHost(host: ForgeHost): void { current = host }
export function host(): ForgeHost {
  if (!current) throw new Error('The Forge was not mounted.')
  return current
}
