import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FORGE_AGENTS, launchEnv, locate, opencodeEnv } from './agents'

/**
 * The sessions each coding CLI ran in a workspace's folder, read from the CLI's own records, so the
 * owner can pick one up again. Claude Code and its MiniMax profiles keep a file per session under
 * their config folder; Codex keeps rollout files naming their folder; OpenCode lists its own.
 * Antigravity keeps no readable list, so only its most recent conversation can be continued.
 */

export interface ForgeSession { readonly tool: string; readonly id: string; readonly title: string; readonly updated: number }
/** How a session is opened again, by the tool it ran in; ids are checked before they reach a command line. */
export const SESSION_ID = /^[\w.-]{1,120}$/u
export function resumeArgs(tool: string, id: string): readonly string[] {
  const command = FORGE_AGENTS.find(agent => agent.id === tool)?.command
  if (command === 'agy') return ['--continue']
  if (!SESSION_ID.test(id)) throw new Error('That is not a session id.')
  if (command === 'claude') return ['--resume', id]
  if (command === 'codex') return ['resume', id]
  if (command === 'opencode') return ['--session', id]
  throw new Error('That tool cannot resume a session here.')
}

const MAX = 40

/** The first part of a file, enough for its first records. */
function head(path: string, bytes = 256 * 1024): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally { closeSync(fd) }
}
const records = (text: string) => text.split('\n').flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } })
const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, 140)
/** Text a person typed, not a tool's wrapper (those start with a tag). */
const typed = (text: unknown) => typeof text === 'string' && text.trim() !== '' && !text.trimStart().startsWith('<') ? oneLine(text) : null

function claudeSessions(directory: string): ForgeSession[] {
  const folder = directory.replace(/[^A-Za-z0-9]/gu, '-')
  const homes = FORGE_AGENTS.filter(agent => agent.command === 'claude').map(agent => ({
    tool: agent.id,
    home: agent.configDir?.() ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')),
  }))
  return homes.flatMap(({ tool, home }) => {
    const dir = join(home, 'projects', folder)
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => name.endsWith('.jsonl')).map((name) => {
      const path = join(dir, name)
      return { path, id: name.slice(0, -'.jsonl'.length), updated: statSync(path).mtimeMs }
    }).sort((a, b) => b.updated - a.updated).slice(0, MAX).flatMap(({ path, id, updated }) => {
      const rows = records(head(path))
      // Headless runs (a review's auditors, scripts) are not conversations he had.
      if (rows.some(row => row.entrypoint === 'sdk-cli')) return []
      const named = rows.find(row => row.type === 'ai-title' && typeof row.aiTitle === 'string')?.aiTitle as string | undefined
      let first: string | null = null
      for (const row of rows) {
        if (row.type !== 'user') continue
        const content = (row.message as { content?: unknown } | undefined)?.content
        first = typed(content) ?? (Array.isArray(content) ? content.map(part => typed((part as { text?: unknown }).text)).find(Boolean) ?? null : null)
        if (first) break
      }
      const title = named ? oneLine(named) : first
      // A file with nothing he said is not a session to come back to.
      return title ? [{ tool, id, title, updated }] : []
    })
  })
}

function codexSessions(directory: string): ForgeSession[] {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const newestFirst = (dir: string) => readdirSync(dir).sort().reverse()
  const files: string[] = []
  // Newest days first; the most recent few hundred sessions are enough.
  outer: for (const year of newestFirst(root)) for (const month of newestFirst(join(root, year))) for (const day of newestFirst(join(root, year, month))) {
    for (const name of newestFirst(join(root, year, month, day))) if (name.endsWith('.jsonl')) files.push(join(root, year, month, day, name))
    if (files.length >= 400) break outer
  }
  // Codex names its threads in an index; the latest name of each wins.
  const names = new Map<string, string>()
  try {
    for (const row of records(readFileSync(join(home, 'session_index.jsonl'), 'utf8'))) {
      if (typeof row.id === 'string' && typeof row.thread_name === 'string') names.set(row.id, oneLine(row.thread_name))
    }
  } catch { /* no index yet */ }
  const want = directory.toLowerCase()
  const found: ForgeSession[] = []
  for (const path of files) {
    let text: string
    try { text = head(path) } catch { continue }
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/u.exec(text)?.[1]
    let folder: string
    try { folder = JSON.parse(`"${cwd ?? ''}"`) as string } catch { continue }
    if (folder.toLowerCase() !== want) continue
    const rows = records(text)
    const meta = rows.find(row => row.type === 'session_meta')?.payload as { id?: unknown; source?: unknown; thread_source?: unknown } | undefined
    // Codex's own helpers (subagents, approval reviews) and headless exec runs are not his sessions.
    if (typeof meta?.source === 'object' || meta?.source === 'exec' || (typeof meta?.thread_source === 'string' && meta.thread_source !== 'user')) continue
    const id = typeof meta?.id === 'string' ? meta.id : /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/iu.exec(path)?.[1]
    if (!id) continue
    let title: string | null = null
    for (const row of rows) {
      const payload = row.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined
      if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) continue
      title = payload.content.map(part => typed((part as { text?: unknown }).text)).find(Boolean) ?? null
      if (title) break
    }
    found.push({ tool: 'codex', id, title: names.get(id) ?? title ?? 'Codex session', updated: statSync(path).mtimeMs })
    if (found.length >= MAX) break
  }
  return found
}

function opencodeSessions(directory: string): Promise<ForgeSession[]> {
  const path = locate('opencode')
  if (!path) return Promise.resolve([])
  const args = ['session', 'list', '--format', 'json', '--max-count', '300']
  const [file, argv] = /\.(cmd|bat)$/iu.test(path) ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', path, ...args]] : [path, args]
  return new Promise((resolve) => {
    execFile(file, argv, { cwd: directory, env: { ...launchEnv(), ...opencodeEnv() }, timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve([]); return }
      try {
        const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as { id?: unknown; title?: unknown; updated?: unknown; directory?: unknown }[]
        resolve(rows.filter(row => typeof row.id === 'string' && typeof row.directory === 'string' && row.directory.toLowerCase() === directory.toLowerCase()).slice(0, MAX).map(row => ({
          tool: 'opencode', id: row.id as string, title: typeof row.title === 'string' ? oneLine(row.title) : 'OpenCode session', updated: typeof row.updated === 'number' ? row.updated : 0,
        })))
      } catch { resolve([]) }
    })
  })
}

/** Whether Claude Code (or a Claude profile) saved a session of this id for this folder. */
export function claudeSessionSaved(kind: string, directory: string, id: string): boolean {
  const agent = FORGE_AGENTS.find(item => item.id === kind)
  if (agent?.command !== 'claude' || !SESSION_ID.test(id)) return false
  const home = agent.configDir?.() ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'))
  return existsSync(join(home, 'projects', directory.replace(/[^A-Za-z0-9]/gu, '-'), `${id}.jsonl`))
}

/** Every session found for a workspace, newest first. */
export async function sessionsOf(directory: string): Promise<readonly ForgeSession[]> {
  const read = (load: () => ForgeSession[]) => { try { return load() } catch { return [] } }
  const all = [...read(() => claudeSessions(directory)), ...read(() => codexSessions(directory)), ...await opencodeSessions(directory)]
  return all.sort((a, b) => b.updated - a.updated)
}
