/** What the page talks through: the app that shows the Forge gives it (its preload's bridge). */
export interface ForgeBridge {
  forge?(request: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }>
  onForgeEvent?(handler: (update: { directory: string; event: { type: string; properties: unknown } }) => void): () => void
  onForgeState?(handler: (update: { directory: string; running: number }) => void): () => void
  onForgeTerminal?(handler: (update: { id: string; data?: string; exit?: number }) => void): () => void
}
let current: ForgeBridge | null = null
export function setForgeBridge(value: ForgeBridge | null): void { current = value }
export function bridge(): ForgeBridge | null { return current }

/** The Forge's one door to the main process. */
export async function call<T>(request: Record<string, unknown>): Promise<T> {
  const host = current
  if (!host?.forge) throw new Error('The Forge is not available in this window.')
  const result = await host.forge(request)
  if (!result.ok) throw new Error(result.error ?? 'The Forge could not do that.')
  return result.value as T
}

export interface PaneSpec { readonly key: string; readonly kind: string; readonly typeFirst?: string; /** A session of this tool to open again. */ readonly resume?: string; /** Started as its workspace's lead (with the Forge's tools). */ readonly lead?: boolean; /** Works on its own branch: the name of its git worktree. */ readonly worktree?: string }
/** What an agent is doing: waiting for him (blocked), working, done, or idle. */
export type AgentStatus = 'blocked' | 'working' | 'done' | 'idle'
export interface RunningItem extends PaneSpec { readonly title: string; /** The local address it serves, once it said so. */ readonly url?: string; readonly status?: AgentStatus; readonly sessionId?: string; readonly startedBy?: string; /** Its own branch, when it works in a worktree. */ readonly branch?: string }
/** An agent's own branch in a workspace: a git worktree the Forge made. */
export interface Worktree { readonly key: string; readonly branch: string; readonly changed: number; readonly ahead: number; readonly running: boolean }
/** The status that matters most among several: one waiting for him first. */
export function topStatus(items: readonly { readonly status?: AgentStatus }[]): AgentStatus | null {
  for (const status of ['blocked', 'working', 'done', 'idle'] as const) if (items.some(item => item.status === status)) return status
  return null
}
export const STATUS_LABEL: Readonly<Record<AgentStatus, string>> = { blocked: 'needs you', working: 'working', done: 'done', idle: 'idle' }
export interface Workspace { readonly id: string; readonly name: string; readonly directory: string; readonly running: number; readonly items: readonly RunningItem[] }
export interface Agent { readonly id: string; readonly label: string; readonly mark: string; readonly installed: boolean; readonly blocked: string | null; readonly install: string }
export interface Script { readonly id: string; readonly name: string; readonly command: string; readonly type: 'dev' | 'check' | 'other'; readonly running: boolean }
