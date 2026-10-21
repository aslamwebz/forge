import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { daemonAddress, daemonCard, type DaemonCard } from '../main/daemonAddress'

/**
 * The Forge from a terminal or a script: the same engine the app shows (started if none runs), so
 * an agent or a script can list workspaces, start agents, read their screens, send them messages,
 * wait for them and stop them. What it starts appears in the app too.
 */

const HELP = `forge: drive the Forge's agents from a terminal.

  forge workspaces                     the workspaces and what runs in each
  forge add <folder>                   make a folder a workspace
  forge agents                         the coding agents the Forge can start
  forge ps                             the panes running in this workspace
  forge start <agent> [--branch] [--task <text>]
                                       start an agent (on its own git branch with --branch),
                                       optionally typing a first task once it is ready
  forge read <pane> [--lines <n>]      the last lines of a pane's screen
  forge send <pane> <message...> [--no-enter]
                                       type a message into a pane (and press Enter)
  forge wait <pane> [--timeout <s>]    wait until it is done, idle or needs someone
  forge stop <pane>                    stop a pane
  forge branches                       the agents' own branches here

  --in <folder>   the workspace (default: the one the current folder is in)
  --json          machine-readable output
`

const CONNECT_MS = 10_000

function dataDir(): string {
  if (process.env.FORGE_DATA_DIR) return process.env.FORGE_DATA_DIR
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Forge')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Forge')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Forge')
}

const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

/** One connection to the engine, as the command line. */
interface Engine { call<T>(op: string, fields?: Record<string, unknown>): Promise<T>; close(): void }

function attempt(data: string): Promise<Socket | null> {
  return new Promise((done) => {
    let card: DaemonCard
    try { card = JSON.parse(readFileSync(daemonCard(data), 'utf8')) as DaemonCard } catch { done(null); return }
    const socket = connect(daemonAddress(data))
    socket.once('error', () => { done(null) })
    socket.once('connect', () => {
      socket.setEncoding('utf8')
      socket.write(`${JSON.stringify({ t: 'hello', token: card.token, role: 'cli' })}\n`)
      done(socket)
    })
  })
}

async function open(): Promise<Engine> {
  const data = dataDir()
  let socket = await attempt(data)
  if (!socket) {
    // None runs: start one, detached, as the app would.
    spawn(process.execPath, [join(__dirname, 'daemon.cjs'), data], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    const deadline = Date.now() + CONNECT_MS
    while (!socket && Date.now() < deadline) { await pause(250); socket = await attempt(data) }
    if (!socket) throw new Error('The Forge engine did not start within 10 seconds.')
  }
  const live = socket
  const waiting = new Map<number, (message: { t?: string; result?: { ok: boolean; value?: unknown; error?: string } }) => void>()
  let buffer = ''
  live.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end)) as { t?: string; id?: number }
      buffer = buffer.slice(end + 1)
      const key = message.t === 'ready' ? 0 : message.id ?? -1
      waiting.get(key)?.(message)
      waiting.delete(key)
    }
  })
  live.on('close', () => { for (const done of waiting.values()) done({ result: { ok: false, error: 'The Forge engine closed the connection.' } }) })
  await new Promise((done) => {
    waiting.set(0, done)
    live.write(`${JSON.stringify({ t: 'init', dataDir: data, documentsDir: join(homedir(), 'Documents') })}\n`)
  })
  let next = 0
  return {
    call: <T>(op: string, fields: Record<string, unknown> = {}) => new Promise<T>((done, fail) => {
      next += 1
      waiting.set(next, (message) => {
        if (message.result?.ok) done(message.result.value as T)
        else fail(new Error(message.result?.error ?? 'The Forge could not do that.'))
      })
      live.write(`${JSON.stringify({ t: 'req', id: next, request: { op, ...fields } })}\n`)
    }),
    close: () => { live.end() },
  }
}

interface Flags { readonly words: string[]; readonly options: Map<string, string | true> }
function parse(argv: readonly string[]): Flags {
  const words: string[] = []
  const options = new Map<string, string | true>()
  const valued = new Set(['in', 'task', 'lines', 'timeout'])
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!
    if (!item.startsWith('--')) { words.push(item); continue }
    const name = item.slice(2)
    if (valued.has(name)) { options.set(name, argv[index + 1] ?? ''); index += 1 }
    else options.set(name, true)
  }
  return { words, options }
}

interface Workspace { readonly id: string; readonly name: string; readonly directory: string; readonly running: number; readonly items: readonly { key: string; kind: string; title: string; status?: string; branch?: string }[] }

/** The workspace named by --in, or the one the current folder is in (the deepest, when they nest). */
async function workspaceOf(engine: Engine, flags: Flags): Promise<Workspace> {
  const asked = resolve(typeof flags.options.get('in') === 'string' ? flags.options.get('in') as string : process.cwd()).toLowerCase()
  const list = await engine.call<Workspace[]>('workspaces')
  const found = list
    .filter(item => asked === item.directory.toLowerCase() || asked.startsWith(item.directory.toLowerCase() + sep))
    .sort((a, b) => b.directory.length - a.directory.length)[0]
  if (!found) throw new Error(`Not in a Forge workspace. Use --in <folder>, or add it first: forge add <folder>`)
  return found
}

async function main(): Promise<void> {
  const flags = parse(process.argv.slice(2))
  const [command, ...rest] = flags.words
  const json = flags.options.has('json')
  const print = (value: unknown, text: () => string) => { process.stdout.write(`${json ? JSON.stringify(value, null, 2) : text()}\n`) }
  if (!command || command === 'help' || flags.options.has('help')) { process.stdout.write(HELP); return }
  const engine = await open()
  try {
    switch (command) {
      case 'workspaces': {
        const list = await engine.call<Workspace[]>('workspaces')
        print(list, () => list.length === 0 ? 'No workspaces yet: forge add <folder>' : list.map(item => `${item.name}  ${item.directory}  (${String(item.running)} running)`).join('\n'))
        return
      }
      case 'add': {
        if (!rest[0]) throw new Error('forge add <folder>')
        const added = await engine.call<{ name: string; directory: string }>('add-workspace', { path: resolve(rest[0]) })
        print(added, () => `Workspace ${added.name}: ${added.directory}`)
        return
      }
      case 'agents': {
        const list = await engine.call<{ id: string; label: string; installed: boolean; blocked: string | null }[]>('agents')
        print(list, () => list.map(agent => `${agent.id.padEnd(22)} ${agent.label}${agent.installed ? agent.blocked ? `  (${agent.blocked})` : '' : '  (not installed)'}`).join('\n'))
        return
      }
      case 'ps': {
        const workspace = await workspaceOf(engine, flags)
        print(workspace.items, () => workspace.items.length === 0 ? `Nothing runs in ${workspace.name}.` : workspace.items.map(item => `${item.key.padEnd(18)} ${item.title}${item.status ? `  ${item.status}` : ''}${item.branch ? `  on ${item.branch}` : ''}`).join('\n'))
        return
      }
      case 'start': {
        const kind = rest[0]
        if (!kind) throw new Error('forge start <agent>   (forge agents lists them)')
        const workspace = await workspaceOf(engine, flags)
        const used = new Set(workspace.items.map(item => item.key))
        let n = 1
        while (used.has(`${kind}-${String(n)}`)) n += 1
        const key = `${kind}-${String(n)}`
        await engine.call('pane-open', { directory: workspace.directory, kind, key, cols: 120, rows: 36, announce: true, ...(flags.options.has('branch') ? { worktree: key } : {}) })
        const task = flags.options.get('task')
        if (typeof task === 'string' && task) {
          // Ready when its screen has drawn and stays the same for a moment; within 45 seconds.
          let last = ''
          let steady = 0
          const deadline = Date.now() + 45_000
          while (steady < 3 && Date.now() < deadline) {
            await pause(700)
            const read = await engine.call<{ text: string; status: string }>('pane-read', { directory: workspace.directory, key, lines: 40 })
            if (read.status === 'blocked') throw new Error(`${key} started but is asking something first; the task was not sent. forge read ${key}`)
            steady = read.text.trim() && read.text === last ? steady + 1 : 0
            last = read.text
          }
          if (steady < 3) throw new Error(`${key} started but was not ready within 45 seconds; the task was not sent.`)
          await engine.call('pane-send', { directory: workspace.directory, key, text: task, submit: true })
        }
        print({ pane: key, branch: flags.options.has('branch') ? `forge/${key}` : null }, () => `Started ${key}${flags.options.has('branch') ? ` on its own branch forge/${key}` : ''}${typeof task === 'string' && task ? ', task sent' : ''}.`)
        return
      }
      case 'read': {
        if (!rest[0]) throw new Error('forge read <pane>')
        const workspace = await workspaceOf(engine, flags)
        const read = await engine.call<{ text: string; status: string }>('pane-read', { directory: workspace.directory, key: rest[0], lines: Number(flags.options.get('lines')) || 60 })
        print(read, () => `${read.text}\n[${read.status}]`)
        return
      }
      case 'send': {
        if (!rest[0] || rest.length < 2) throw new Error('forge send <pane> <message...>')
        const workspace = await workspaceOf(engine, flags)
        await engine.call('pane-send', { directory: workspace.directory, key: rest[0], text: rest.slice(1).join(' '), submit: !flags.options.has('no-enter') })
        print({ sent: true }, () => 'Sent.')
        return
      }
      case 'wait': {
        if (!rest[0]) throw new Error('forge wait <pane>')
        const workspace = await workspaceOf(engine, flags)
        const deadline = Date.now() + Math.min(3_600, Math.max(1, Number(flags.options.get('timeout')) || 300)) * 1_000
        let status = 'working'
        while (Date.now() < deadline) {
          status = (await engine.call<{ status: string }>('pane-read', { directory: workspace.directory, key: rest[0], lines: 1 })).status
          if (status !== 'working') break
          await pause(1_000)
        }
        print({ status }, () => status === 'working' ? 'Still working (time is up).' : status)
        if (status === 'working') process.exitCode = 2
        return
      }
      case 'stop': {
        if (!rest[0]) throw new Error('forge stop <pane>')
        const workspace = await workspaceOf(engine, flags)
        await engine.call('pane-close', { directory: workspace.directory, key: rest[0], announce: true })
        print({ stopped: rest[0] }, () => `Stopped ${rest[0]!}.`)
        return
      }
      case 'branches': {
        const workspace = await workspaceOf(engine, flags)
        const list = await engine.call<{ branch: string; ahead: number; changed: number; running: boolean }[]>('worktrees', { directory: workspace.directory })
        print(list, () => list.length === 0 ? 'No own branches here.' : list.map(item => `${item.branch.padEnd(24)} ${String(item.ahead)} ahead, ${String(item.changed)} uncommitted${item.running ? ', agent running' : ''}`).join('\n'))
        return
      }
      default:
        throw new Error(`Unknown command: ${command}. forge help lists them.`)
    }
  } finally {
    engine.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`forge: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
