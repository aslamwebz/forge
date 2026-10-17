import { spawn as spawnPty, type IPty } from '@lydell/node-pty'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal as Screen } from '@xterm/headless'
import { dataDir } from './host'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORGE_AGENTS, launchEnv, locate } from './agents'
import { findScript } from './scripts'

/**
 * The Forge's panes: real terminals. A pane runs one of the coding CLIs the owner starts (OpenCode,
 * Claude Code, Codex, MiniMax Code, Antigravity) as it is, or a shell, in the workspace's folder.
 * They live here in the main process, so they keep running when the Forge page is closed. Each
 * keeps a screen of its own (what a terminal would show), so the page gets the same screen back,
 * and so the Forge can tell from it what an agent is doing: working, waiting for him, or done.
 */

/** 'shell', 'script' (the key is the script's id), or the id of one of the Forge's CLIs or profiles. */
export type PaneKind = string
/** What an agent is doing, read from its screen. */
export type PaneStatus = 'working' | 'blocked' | 'done' | 'idle'
interface Pane {
  readonly id: string
  readonly directory: string
  readonly key: string
  readonly kind: PaneKind
  readonly pty: IPty
  readonly screen: Screen
  readonly serializer: SerializeAddon
  /** When it started, and (for Claude Code) the session id it was given, so it can be resumed after a restart. */
  readonly startedAt: number
  readonly sessionId?: string
  /** A title the page gave it (a resumed session's name). */
  readonly title?: string
  /** The lead agent that started it, if one did. */
  readonly startedBy?: string
  /** Whether it is its workspace's lead (it has the Forge's tools). */
  readonly lead?: boolean
  /** The last bit of output, for addresses split across chunks. */
  tail: string
  /** The local address a dev server in it said it serves. */
  url?: string
  status: PaneStatus
  lastOutput: number
  lastInput: number
  timer?: NodeJS.Timeout
}
// eslint-disable-next-line no-control-regex -- terminal colour codes are control characters
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/gu
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>\])]*)?/u
/** What the coding CLIs show while they wait for his answer: a permission question, a yes/no. */
const ASKING = /do you want to (proceed|make|create|run|allow|continue)|would you like to (run|make|proceed|apply)|allow (once|always|this|command)|permission (required|needed)|approve (this|the|command)|\(y\/n\)|\[y\/n\]|yes, and don't ask|press enter to (continue|confirm)|enter to (confirm|select)|trust (this|the files in this) folder|run this command\?|requesting permission|allow this (action|command)/iu
/** What they show while they work. */
const WORKING = /esc to interrupt|esc interrupt|ctrl\+c to (interrupt|cancel)|\bworking \(\d/iu
/** A menu waiting for his pick: the highlighted entry of a numbered list ("› 3. Cancel", "❯ 1. Yes"). */
const CHOOSING = /^\s*[›❯>]\s*\d+\.\s+\S/mu
const QUIET_MS = 2_500
/** CLIs whose screen shows an interrupt hint for exactly as long as they work. */
const SAYS_WORKING = new Set(['claude', 'codex', 'opencode'])

/** The first local address a pane's output names, as a browser can open it. */
function localAddress(text: string): string | null {
  const found = LOCAL_URL.exec(text.replace(ANSI, ''))?.[0]
  return found ? found.replace('0.0.0.0', 'localhost').replace(/\[::1?\]/u, 'localhost') : null
}
const panes = new Map<string, Pane>()

export interface TerminalSink {
  data(id: string, data: string): void
  exit(id: string, code: number): void
  /** A pane named the local address it serves. */
  address?(id: string): void
  /** An agent's status changed. */
  status?(id: string, status: PaneStatus, before: PaneStatus): void
}

/** The program a pane runs: a shell, a saved script, or one of the listed CLIs; never anything a request names. */
function command(kind: PaneKind, directory: string, key: string, resume: readonly string[] = [], more: readonly string[] = []): { readonly file: string; readonly args: readonly string[]; readonly env: Record<string, string>; readonly sessionId?: string } {
  // PATH as saved now, so a tool installed while the app runs is found and can find its own helpers.
  const env = launchEnv()
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
  if (kind === 'shell') return { file: shell, args: process.platform === 'win32' ? ['-NoLogo'] : [], env }
  if (kind === 'script') {
    const script = findScript(directory, key)
    if (!script) throw new Error('That script is no longer saved in this workspace.')
    return { file: shell, args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', script.command] : ['-lc', script.command], env }
  }
  const agent = FORGE_AGENTS.find(item => item.id === kind)
  if (!agent) throw new Error('That is not one of the tools the Forge can start.')
  const blocked = agent.needs?.() ?? null
  if (blocked) throw new Error(`${agent.label}: ${blocked}`)
  const path = locate(agent.command)
  if (!path) throw new Error(`${agent.label} is not installed. Use Install to set it up.`)
  const withProfile = { ...env, ...(agent.env?.() ?? {}) }
  // A new Claude Code conversation gets its id from us, so it can be resumed after a restart.
  const sessionId = agent.command === 'claude' && resume.length === 0 ? randomUUID() : undefined
  const args = [...(sessionId ? ['--session-id', sessionId] : resume), ...more]
  // A .cmd launcher needs the command shell; a real program starts directly.
  return /\.(cmd|bat)$/iu.test(path)
    ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', path, ...args], env: withProfile, ...(sessionId ? { sessionId } : {}) }
    : { file: path, args, env: withProfile, ...(sessionId ? { sessionId } : {}) }
}

/** The text on a pane's screen now. */
function visible(screen: Screen): string {
  const buffer = screen.buffer.active
  const lines: string[] = []
  for (let y = buffer.viewportY; y < buffer.viewportY + screen.rows; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

/**
 * An agent's status from its screen and its output: asking him is blocked; a busy line, or steady
 * output he did not cause by typing, is working; quiet after working is done, until he types again.
 */
function judge(pane: Pane, sink: TerminalSink): void {
  if (pane.kind === 'shell' || pane.kind === 'script') return
  // The CLIs ask and show their busy line at the bottom; the conversation above may quote such words.
  const lines = visible(pane.screen).split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  const text = lines.slice(-14).join('\n')
  const now = Date.now()
  // Claude Code, Codex and OpenCode say so while they work; for the others, output he did not cause is the sign.
  const command = FORGE_AGENTS.find(agent => agent.id === pane.kind)?.command ?? ''
  // A CLI that says so is read by its line; when a narrow pane cuts that line off, output still
  // streaming well after his last keystroke (more than a redraw) is the sign.
  const busy = WORKING.test(text) || (pane.lastInput > 0 && now - pane.lastOutput < QUIET_MS && pane.lastOutput - pane.lastInput > (SAYS_WORKING.has(command) ? 2_000 : 600))
  const next: PaneStatus = ASKING.test(text) || CHOOSING.test(text) ? 'blocked'
    : busy ? 'working'
      : pane.status === 'working' || pane.status === 'done' ? 'done'
        : 'idle'
  if (next !== pane.status) {
    const before = pane.status
    pane.status = next
    sink.status?.(pane.id, next, before)
  }
  // Look again once it has been quiet long enough to call it done.
  clearTimeout(pane.timer)
  if (next === 'working') pane.timer = setTimeout(() => { judge(pane, sink) }, QUIET_MS + 200)
}

/** A workspace's pane by its key: the running one (with its screen as it is), or a new one. */
export interface OpenOptions {
  /** The tool's own arguments for resuming a session, and that session's id. */
  readonly resume?: readonly string[]
  readonly resumedId?: string
  /** More arguments (a lead's tools and briefing). */
  readonly more?: readonly string[]
  readonly title?: string
  readonly startedBy?: string
  readonly lead?: boolean
}

export async function openPane(directory: string, key: string, kind: PaneKind, cols: number, rows: number, sink: TerminalSink, options: OpenOptions = {}): Promise<{ readonly id: string; readonly replay: string }> {
  const { resume = [], more = [], title, resumedId, startedBy, lead } = options
  const running = [...panes.values()].find(item => item.directory === directory && item.key === key)
  if (running) {
    resize(running, cols, rows)
    return { id: running.id, replay: running.serializer.serialize({ scrollback: 3_000 }) }
  }
  const run = command(kind, directory, key, resume, more)
  const pty = spawnPty(run.file, [...run.args], { name: 'xterm-256color', cols, rows, cwd: directory, env: run.env })
  const screen = new Screen({ cols, rows, scrollback: 5_000, allowProposedApi: true })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  const sessionId = run.sessionId ?? resumedId
  const pane: Pane = { id: randomUUID(), directory, key, kind, pty, screen, serializer, tail: '', status: 'idle', lastOutput: 0, lastInput: 0, startedAt: Date.now(), ...(sessionId ? { sessionId } : {}), ...(title ? { title } : {}), ...(startedBy ? { startedBy } : {}), ...(lead ? { lead } : {}) }
  panes.set(pane.id, pane)
  remember()
  let judging: NodeJS.Timeout | undefined
  pty.onData((data) => {
    const before = pane.tail
    pane.tail = (pane.tail + data).slice(-600)
    pane.lastOutput = Date.now()
    sink.data(pane.id, data)
    // The screen is read a moment later, once this burst of output is drawn.
    screen.write(data)
    if (!judging) judging = setTimeout(() => { judging = undefined; judge(pane, sink) }, 300)
    // Only what he runs himself serves previews; an agent's sign-in page is not one.
    if (!pane.url && (kind === 'script' || kind === 'shell')) {
      const url = localAddress(before + data)
      if (url) { pane.url = url; sink.address?.(pane.id) }
    }
  })
  pty.onExit(({ exitCode }) => {
    clearTimeout(pane.timer)
    clearTimeout(judging)
    panes.delete(pane.id)
    remember()
    screen.dispose()
    sink.exit(pane.id, exitCode)
  })
  return { id: pane.id, replay: '' }
}

/** The panes running for a workspace, so the page can show the same layout when it comes back. */
export function runningPanes(directory: string): readonly { readonly key: string; readonly kind: PaneKind; readonly url?: string; readonly status?: PaneStatus; readonly sessionId?: string; readonly lead?: boolean; readonly startedBy?: string; readonly title?: string }[] {
  return [...panes.values()].filter(item => item.directory === directory).map(item => ({
    key: item.key, kind: item.kind, ...(item.url ? { url: item.url } : {}), ...(item.kind !== 'shell' && item.kind !== 'script' ? { status: item.status } : {}),
    ...(item.sessionId ? { sessionId: item.sessionId } : {}), ...(item.lead ? { lead: true } : {}), ...(item.startedBy ? { startedBy: item.startedBy } : {}), ...(item.title ? { title: item.title } : {}),
  }))
}

/** Where a pane is, for telling him about it. */
export function paneById(id: string): { readonly directory: string; readonly key: string; readonly kind: PaneKind } | null {
  const pane = panes.get(id)
  return pane ? { directory: pane.directory, key: pane.key, kind: pane.kind } : null
}

/** He typed: what follows is the agent answering him, and a finished agent he answers is no longer done. */
export function writePane(id: string, data: string, sink?: TerminalSink): void {
  const pane = panes.get(id)
  if (!pane) return
  pane.lastInput = Date.now()
  pane.pty.write(data)
  if (pane.status === 'done' && sink) { pane.status = 'idle'; sink.status?.(pane.id, 'idle', 'done') }
}

const find = (directory: string, key: string) => [...panes.values()].find(item => item.directory === directory && item.key === key)

/** A pane's recent text: the last lines of its screen and what scrolled off above. */
export function paneText(directory: string, key: string, lines: number): { readonly text: string; readonly status: PaneStatus; readonly kind: PaneKind } | null {
  const pane = find(directory, key)
  if (!pane) return null
  const buffer = pane.screen.buffer.active
  const end = buffer.viewportY + pane.screen.rows
  const all: string[] = []
  for (let y = Math.max(0, end - lines); y < end; y += 1) all.push(buffer.getLine(y)?.translateToString(true) ?? '')
  while (all.length > 0 && all[all.length - 1]!.trim() === '') all.pop()
  return { text: all.join('\n'), status: pane.status, kind: pane.kind }
}

/** When a pane last printed anything (0 when not yet), or null when it is not running. */
export function paneLastOutput(directory: string, key: string): number | null {
  return find(directory, key)?.lastOutput ?? null
}

/** A pane's status now, or null when it is not running. */
export function paneStatus(directory: string, key: string): PaneStatus | null {
  return find(directory, key)?.status ?? null
}

/** Type a message into a pane as a paste, then Enter a moment later if asked. */
/** Text as typed words only: no control characters, so a message cannot end its paste early or press keys. */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const plain = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '')

export function typeInto(directory: string, key: string, text: string, submit: boolean): boolean {
  const pane = find(directory, key)
  if (!pane) return false
  pane.lastInput = Date.now()
  pane.pty.write(`\x1b[200~${plain(text)}\x1b[201~`)
  if (submit) setTimeout(() => { if (panes.has(pane.id)) { pane.lastInput = Date.now(); pane.pty.write('\r') } }, 250)
  return true
}

const KEYS: Readonly<Record<string, string>> = { enter: '\r', escape: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', backspace: '\x7f', 'ctrl+c': '\x03' }
/** Press keys in a pane: named keys, or single characters (a menu number, y or n). */
export function pressKeys(directory: string, key: string, keys: readonly string[]): boolean {
  const pane = find(directory, key)
  if (!pane) return false
  const data = keys.map(item => KEYS[item.toLowerCase()] ?? (item.length === 1 ? item : '')).join('')
  if (!data) return false
  pane.lastInput = Date.now()
  pane.pty.write(data)
  return true
}

/** Paste text into a workspace's running pane (as a paste, so a CLI does not send it): he presses Enter. */
export function pasteInto(directory: string, key: string, text: string): boolean {
  const pane = [...panes.values()].find(item => item.directory === directory && item.key === key)
  if (!pane) return false
  pane.lastInput = Date.now()
  pane.pty.write(`\x1b[200~${plain(text)}\x1b[201~`)
  return true
}

function resize(pane: Pane, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0 || (pane.screen.cols === cols && pane.screen.rows === rows)) return
  // A resize makes a CLI redraw; that is not work.
  pane.lastInput = Date.now()
  pane.pty.resize(cols, rows)
  pane.screen.resize(cols, rows)
}

export function resizePane(id: string, cols: number, rows: number): void {
  const pane = panes.get(id)
  if (pane) resize(pane, cols, rows)
}

/** Close a pane by workspace and key. */
export function closePane(directory: string, key: string): void {
  for (const pane of [...panes.values()]) {
    if (pane.directory !== directory || pane.key !== key) continue
    panes.delete(pane.id)
    remember()
    clearTimeout(pane.timer)
    try { pane.pty.kill() } catch { /* already gone */ }
  }
}

/** Every pane of a workspace, closed when it leaves the list. */
export function closeWorkspacePanes(directory: string): void {
  for (const pane of [...panes.values()]) if (pane.directory === directory) closePane(directory, pane.key)
}

/** Every pane, closed with the app; what ran is kept for him to restore next time. */
export function closeTerminals(): void {
  remember()
  quitting = true
  for (const pane of [...panes.values()]) closePane(pane.directory, pane.key)
}

/** An agent that was running in a workspace when the app last closed. */
export interface LastPane { readonly key: string; readonly kind: PaneKind; readonly title?: string; readonly startedAt: number; readonly sessionId?: string }
let quitting = false
const lastFile = () => join(dataDir(), 'forge-last.json')

/** What runs now, per workspace (agents only: shells and scripts are his to start again). Kept as the app closes. */
function remember(): void {
  if (quitting) return
  // Last time's list is read before this run writes over it.
  if (lastRun === null) lastPanes('')
  const all: Record<string, LastPane[]> = {}
  for (const pane of panes.values()) {
    if (pane.kind === 'shell' || pane.kind === 'script') continue
    ;(all[pane.directory.toLowerCase()] ??= []).push({ key: pane.key, kind: pane.kind, startedAt: pane.startedAt, ...(pane.title ? { title: pane.title } : {}), ...(pane.sessionId ? { sessionId: pane.sessionId } : {}) })
  }
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(lastFile(), JSON.stringify(all, null, 2))
  } catch { /* the next change tries again */ }
}

/** The agents that ran in a workspace when the app last closed; read once at start, before anything runs. */
let lastRun: Record<string, LastPane[]> | null = null
export function lastPanes(directory: string): readonly LastPane[] {
  if (lastRun === null) {
    try { lastRun = JSON.parse(readFileSync(lastFile(), 'utf8')) as Record<string, LastPane[]> } catch { lastRun = {} }
  }
  return lastRun[directory.toLowerCase()] ?? []
}

/** He restored them, or does not want to: they are no longer offered. */
export function forgetLastPanes(directory: string): void {
  if (lastRun) delete lastRun[directory.toLowerCase()]
}
