/**
 * What the Forge's engine needs from the app it runs in, and nothing more. The engine never
 * touches Electron itself: an app gives it these (in-process, or over a message channel when the
 * engine runs in its own process), so the same engine runs on its own or inside another app.
 */
export interface ForgeSecurity {
  /** A card for a caller (a lead), the same card again for the same id. */
  issueIdentity(id: string, kind: 'lead', name: string): Promise<{ readonly id: string }> | { readonly id: string }
  /** Decide a call before it goes; throws when it is stopped. The ticket says how it went. */
  pass(request: { readonly caller: string; readonly channel: 'forge'; readonly target: string; readonly action: string }): Promise<{ done(result: { ok: boolean }): void }>
  /** Whether an error is the security core stopping a call (its message is for the agent). */
  isStop(error: unknown): boolean
}

/** A desktop notice about an agent; the app decides whether he is looking already. */
export interface ForgeNotice { readonly title: string; readonly body: string; readonly silent: boolean; readonly directory: string; readonly key: string }

export interface ForgePort {
  /** Where the Forge keeps its data, and where new projects go by default. */
  readonly dataDir: string
  readonly documentsDir: string
  /** A message for the Forge page (channel and value). */
  push(channel: string, value: unknown): void
  /** He picks a folder; null when he cancels. */
  pickFolder(title: string, create: boolean): Promise<string | null>
  /** Open an address in his browser. */
  openExternal(url: string): Promise<void>
  notify(notice: ForgeNotice): void
  /** Without one, the lead's tools stay off. */
  readonly security?: ForgeSecurity
}

let current: ForgePort | null = null
export function setPort(port: ForgePort): void { current = port }
export function port(): ForgePort {
  if (!current) throw new Error('The Forge engine was not started.')
  return current
}
export const dataDir = () => port().dataDir
