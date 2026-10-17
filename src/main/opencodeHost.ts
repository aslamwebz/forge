import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'

/**
 * The Forge's builder: OpenCode, run as a local server and driven through its SDK.
 *
 * One server for all of the owner's apps (each app is a folder, named per request), started the
 * first time the Forge needs it, on 127.0.0.1 at a free port, behind a password only this process
 * knows. Its configuration travels in memory (OPENCODE_CONFIG_CONTENT): the model is MiniMax with
 * the key the app already holds, and every file edit, command and web fetch asks first, so each
 * one reaches the Forge page as a request to allow or refuse.
 */

const START_MS = 20_000
/** The builder's own working folder (its process id file lives here); projects are the owner's workspaces. */
export function forgeRoot(): string {
  const root = join(app.getPath('userData'), 'forge')
  mkdirSync(root, { recursive: true })
  return root
}

let server: { readonly process: ChildProcess; readonly client: OpencodeClient; readonly url: string; readonly password: string } | null = null
let starting: Promise<OpencodeClient> | null = null
let stopEvents: (() => void) | null = null

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => { resolve(port) })
    })
  })
}

/** The configuration the server runs with: MiniMax, and asking before acting. */
function serverConfig(): Record<string, unknown> {
  const model = process.env.MINIMAX_MODEL?.trim() || 'MiniMax-M2.7-highspeed'
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `minimax/${model}`,
    provider: {
      minimax: {
        npm: '@ai-sdk/openai-compatible',
        name: 'MiniMax',
        options: { baseURL: process.env.MINIMAX_BASE_URL?.trim() || 'https://api.minimax.io/v1', apiKey: process.env.MINIMAX_API_KEY ?? '' },
        models: { [model]: { name: model }, 'MiniMax-M3': { name: 'MiniMax-M3' } },
      },
    },
    permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
    share: 'disabled',
    autoupdate: false,
  }
}

/** Where the running server's process id is kept, so one left over from a crash can be stopped. */
const pidFile = () => join(forgeRoot(), '.forge-server.pid')

/**
 * The OpenCode program itself. On Windows the command is a .cmd launcher; started through a
 * shell, the server outlives a kill of that shell and keeps whatever it inherited. The real
 * executable beside the launcher is started directly when it is there.
 */
export function opencodeProgram(): { readonly command: string; readonly shell: boolean } {
  if (process.platform !== 'win32') return { command: 'opencode', shell: false }
  const found = spawnSync('where', ['opencode.cmd'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/u).find(line => line.trim() !== '')?.trim()
  const exe = found ? join(dirname(found), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe') : null
  return exe && existsSync(exe) ? { command: exe, shell: false } : { command: 'opencode', shell: true }
}

/** Stop a process and everything it started. */
function stopTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else { try { process.kill(pid) } catch { /* already gone */ } }
}

/** A server left over from an app that did not close cleanly: stopped before a new one starts. */
function stopLeftover(): void {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) {
      const name = process.platform === 'win32'
        ? spawnSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? ''
        : ''
      if (process.platform !== 'win32' || /opencode/iu.test(name)) stopTree(pid)
    }
  } catch { /* no leftover */ }
  try { rmSync(pidFile(), { force: true }) } catch { /* nothing to remove */ }
}

/** The client, starting the server the first time. */
export async function forgeClient(): Promise<OpencodeClient> {
  if (server !== null && server.process.exitCode === null) return server.client
  if (starting !== null) return await starting
  starting = (async () => {
    if (!process.env.MINIMAX_API_KEY) throw new Error('The Forge needs a MiniMax key (Settings → Models) to build with.')
    stopLeftover()
    const port = await freePort()
    const password = randomBytes(18).toString('base64url')
    // The arguments are fixed; a shell is used only when the executable cannot be found.
    const program = opencodeProgram()
    const child = spawn(program.command, ['serve', '--hostname=127.0.0.1', `--port=${String(port)}`], {
      cwd: forgeRoot(),
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(serverConfig()), OPENCODE_SERVER_PASSWORD: password },
      windowsHide: true,
      shell: program.shell,
    })
    try { if (child.pid !== undefined) writeFileSync(pidFile(), String(child.pid)) } catch { /* the leftover check is best effort */ }
    const url = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => { stopTree(child.pid); reject(new Error(`OpenCode did not start within ${String(START_MS / 1000)} seconds. ${output.slice(-300)}`)) }, START_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const found = /opencode server listening on\s+(https?:\/\/\S+)/u.exec(output)
        if (found) { clearTimeout(timer); resolve(found[1]!) }
      })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error: Error) => { clearTimeout(timer); reject(new Error(`OpenCode could not be started: ${error.message}. Is it installed (npm i -g opencode-ai)?`)) })
      child.once('exit', (code: number | null) => { clearTimeout(timer); reject(new Error(`OpenCode stopped (code ${String(code)}). ${output.slice(-300)}`)) })
    })
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    const client = createOpencodeClient({
      baseUrl: url,
      // The event stream calls the global fetch with the client's headers, so the password rides here too.
      headers: { authorization },
      // Every call carries the password: API calls pass a Request, the event stream a URL and options.
      fetch: (async (input: Request | string | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        request.headers.set('authorization', authorization)
        return await fetch(request)
      }) as typeof fetch,
    })
    child.once('exit', () => { if (server?.process === child) { server = null; stopEvents?.(); stopEvents = null } })
    server = { process: child, client, url, password }
    return client
  })()
  try { return await starting } finally { starting = null }
}

/** Everything the server reports, for every app, passed on as it happens. */
export async function watchForge(onEvent: (directory: string, event: { readonly type: string; readonly properties: unknown }) => void): Promise<void> {
  if (stopEvents !== null) return
  const client = await forgeClient()
  const controller = new AbortController()
  stopEvents = () => { controller.abort() }
  const stream = await client.global.event({ signal: controller.signal })
  void (async () => {
    try {
      for await (const item of stream.stream) {
        const row = item as { directory?: string; payload?: { type: string; properties: unknown } }
        if (row.payload && typeof row.directory === 'string') onEvent(row.directory, row.payload)
      }
    } catch { /* the stream ends with the server */ }
    stopEvents = null
  })()
}

/** Where the server is and its password, for a terminal attached to it; starts it if needed. */
export async function forgeServer(): Promise<{ readonly url: string; readonly password: string }> {
  await forgeClient()
  if (server === null) throw new Error('The Forge builder is not running.')
  return { url: server.url, password: server.password }
}

/** Stop the server with the app. */
export function stopForge(): void {
  stopEvents?.()
  stopEvents = null
  if (server !== null) { stopTree(server.process.pid); server = null }
  try { rmSync(pidFile(), { force: true }) } catch { /* nothing to remove */ }
}
