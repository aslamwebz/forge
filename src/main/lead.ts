import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { dataDir, port as forgePort } from './host'
import { FORGE_AGENTS, forgeAgents } from './agents'
import { closePane, paneLastOutput, paneStatus, paneText, pressKeys, runningPanes, typeInto } from './forgeTerminal'

/**
 * A Forge lead: one agent (Claude Code) that leads the others in its workspace. It gets tools over
 * a local MCP endpoint (on 127.0.0.1, with a secret per lead) to see the other agents, start new
 * ones with a task, send them messages, read their screens, wait for them and stop the ones it
 * started. Every tool call passes the Security Core first, under the lead's identity card; the
 * gates decide (answering an agent's question asks the owner by default). Nothing here touches
 * Windows itself: the panes are the Forge's own.
 */

interface Lead { readonly directory: string; readonly key: string; readonly identity: string; readonly files: readonly string[] }
interface Context {
  /** Start an agent in a workspace for a lead; resolves with its pane key. */
  open(directory: string, kind: string, startedBy: string, more: readonly string[]): Promise<string>
  /** Tell the page what runs in a workspace changed. */
  changed(directory: string): void
}

const leads = new Map<string, Lead>()
let context: Context | null = null
let server: Server | null = null
let port = 0

export function initLead(value: Context): void { context = value }

const BRIEF = (directory: string) => [
  `You are the lead of the coding agents in the Forge workspace "${basename(directory)}" (${directory}). The owner watches all of you in the Forge.`,
  'Other coding agents (Claude Code, Codex, OpenCode and others) can run beside you in the same folder. With the forge tools you can see them (forge_agents), see which can be started (forge_available), start one with a task (forge_start), send one a message (forge_send), press keys in one (forge_keys), read its screen (forge_read), wait until one finishes or needs someone (forge_wait), and stop one you started (forge_stop).',
  'They share the folder with you: give each its own part of the work so no two change the same files at once. When one finishes, read what it did and review it before you report it done.',
  'Every forge tool call passes the security core; its gates may block a call or ask the owner first. When a call is stopped, the result says why.',
].join('\n\n')

/** The arguments that make a Claude Code pane a lead: its tools, and a briefing about them. */
export async function leadArgs(directory: string, key: string, label: string): Promise<string[]> {
  // A lead commands other agents only through a security core; without one there is no lead.
  const security = forgePort().security
  if (!security) throw new Error('A lead needs a security core to decide its calls; this app has none, so the lead is off.')
  await listen()
  const token = randomBytes(24).toString('hex')
  const identity = (await security.issueIdentity(`lead:${directory.toLowerCase()}:${key}`, 'lead', `${label} lead · ${basename(directory)}`)).id
  // One lead per pane: a lead made again replaces the one before, whose token stops working.
  dropLead(directory, key)
  const folder = leadFolder()
  mkdirSync(folder, { recursive: true })
  const config = join(folder, `${token.slice(0, 12)}.json`)
  writeFileSync(config, JSON.stringify({ mcpServers: { forge: { type: 'http', url: `http://127.0.0.1:${String(port)}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }))
  const brief = join(folder, `${token.slice(0, 12)}.md`)
  writeFileSync(brief, BRIEF(directory))
  leads.set(token, { directory, key, identity, files: [config, brief] })
  return ['--mcp-config', config, '--append-system-prompt-file', brief, '--allowedTools', 'mcp__forge']
}

const leadFolder = () => join(dataDir(), 'forge', 'leads')

/** A lead's pane closed or ended: its token stops working and its files are deleted. */
export function dropLead(directory: string, key: string): void {
  for (const [token, lead] of [...leads]) {
    if (lead.directory !== directory || lead.key !== key) continue
    leads.delete(token)
    for (const file of lead.files) rmSync(file, { force: true })
  }
}

// ---- The tools ---------------------------------------------------------------------------------

const TOOLS = [
  { name: 'forge_agents', description: 'The other agents running in this workspace: pane name, which CLI, and what each is doing (working, done, idle, or blocked: waiting for an answer).', inputSchema: { type: 'object', properties: {} } },
  { name: 'forge_available', description: 'The coding CLIs that can be started here.', inputSchema: { type: 'object', properties: {} } },
  { name: 'forge_start', description: 'Start a coding agent in this workspace, optionally on a chosen model and with a first task once it is ready. Returns its pane name.', inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'An id from forge_available, e.g. "opencode", "agy" or "claude-minimax".' }, model: { type: 'string', description: 'The model, in the CLI’s own naming: OpenCode "provider/model" (e.g. "opencode/kimi-k2.5-free"), Antigravity e.g. "gemini-3.8-flash-medium", Codex or Claude a model name. Leave out for its default.' }, task: { type: 'string', description: 'What it should do first.' } }, required: ['agent'] } },
  { name: 'forge_send', description: 'Send a message to an agent (typed into it and sent). If the agent is waiting for an answer, sending is an answer and may need the owner’s approval.', inputSchema: { type: 'object', properties: { pane: { type: 'string' }, message: { type: 'string' }, submit: { type: 'boolean', description: 'Press Enter after it (default true).' } }, required: ['pane', 'message'] } },
  { name: 'forge_keys', description: 'Press keys in an agent: enter, escape, tab, up, down, left, right, backspace, ctrl+c, or single characters such as a menu number. Keys answer agents, so this may need the owner’s approval.', inputSchema: { type: 'object', properties: { pane: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } }, required: ['pane', 'keys'] } },
  { name: 'forge_read', description: 'Read the last lines of an agent’s screen.', inputSchema: { type: 'object', properties: { pane: { type: 'string' }, lines: { type: 'number', description: 'How many lines (default 60, at most 400).' } }, required: ['pane'] } },
  { name: 'forge_wait', description: 'Wait until an agent is done, idle, or blocked, or until the time is up (at most 100 seconds a call: call it again to wait longer). Returns its status.', inputSchema: { type: 'object', properties: { pane: { type: 'string' }, seconds: { type: 'number', description: 'How long to wait at most (default 90, at most 100).' } }, required: ['pane'] } },
  { name: 'forge_stop', description: 'Stop an agent you started.', inputSchema: { type: 'object', properties: { pane: { type: 'string' } }, required: ['pane'] } },
] as const

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const label = (kind: string) => FORGE_AGENTS.find(agent => agent.id === kind)?.label ?? kind

/** The other agents in the lead's workspace. */
function others(lead: Lead) {
  return runningPanes(lead.directory).filter(pane => pane.key !== lead.key && pane.kind !== 'shell' && pane.kind !== 'script')
}

async function run(lead: Lead, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const pane = typeof args.pane === 'string' ? args.pane : ''
  const target = (key: string) => {
    const found = others(lead).find(item => item.key === key)
    if (!found) throw new Error(`No agent "${key}" runs here. forge_agents lists them.`)
    return found
  }
  /** The core decides first; the ticket is closed with how the call went. */
  const through = async <T>(targetName: string, action: string, work: () => Promise<T> | T): Promise<T> => {
    const security = forgePort().security
    if (!security) throw new Error('There is no security core, so the lead cannot act.')
    const ticket = await security.pass({ caller: lead.identity, channel: 'forge', target: targetName, action })
    try {
      const result = await work()
      ticket.done({ ok: true })
      return result
    } catch (error) {
      ticket.done({ ok: false })
      throw error
    }
  }

  switch (name) {
    case 'forge_agents': {
      const list = others(lead)
      return through('workspace', 'list', () => list.length === 0 ? 'No other agents run here. forge_available lists what can be started.'
        : list.map(item => `${item.key}: ${label(item.kind)}${item.title && item.title !== label(item.kind) ? ` (${item.title})` : ''}, ${item.status ?? 'unknown'}${item.startedBy === lead.key ? ', started by you' : ''}`).join('\n'))
    }
    case 'forge_available':
      return through('workspace', 'available', () => forgeAgents().filter(agent => agent.installed && agent.blocked === null).map(agent => `${agent.id}: ${agent.label}`).join('\n'))
    case 'forge_start': {
      const kind = typeof args.agent === 'string' ? args.agent : ''
      const agent = forgeAgents().find(item => item.id === kind)
      if (!agent || !agent.installed || agent.blocked) throw new Error(`"${kind}" cannot be started here. forge_available lists what can.`)
      const task = typeof args.task === 'string' ? args.task.slice(0, 20_000) : ''
      // The model, as each CLI's own flag; only a plain model name can reach a command line.
      const model = typeof args.model === 'string' ? args.model.trim() : ''
      // It starts with a letter or digit, so it can never be read as a flag.
      if (model && !/^\w[\w./:@-]{0,99}$/u.test(model)) throw new Error('That is not a model name.')
      const command = FORGE_AGENTS.find(item => item.id === kind)?.command
      const more = !model ? [] : command === 'codex' ? ['-m', model] : ['--model', model]
      return through(model ? `${agent.label} · ${model}` : agent.label, 'start', async () => {
        if (!context) throw new Error('The Forge is not ready.')
        const key = await context.open(lead.directory, kind, lead.key, more)
        if (!task) return `Started ${key}.`
        // Ready when it has drawn its screen and gone quiet; a question first is for the owner.
        const deadline = Date.now() + 45_000
        while (Date.now() < deadline && !signal.aborted) {
          await sleep(700)
          const status = paneStatus(lead.directory, key)
          if (status === null) return `${key} ended before it was ready.`
          if (status === 'blocked') return `Started ${key}, but it is asking something before it can work:\n${paneText(lead.directory, key, 14)?.text ?? ''}\nThe task was not sent.`
          if (signal.aborted) return `Started ${key}; the lead left before the task was sent.`
          const last = paneLastOutput(lead.directory, key) ?? 0
          if (last > 0 && Date.now() - last > 2_500) {
            // Typing the task is its own call: what changed while it started (a seal, a revoked card) decides it.
            try {
              await through(key, 'send', () => { typeInto(lead.directory, key, task, true) })
            } catch (error) {
              return `Started ${key}, but the task was not sent: ${error instanceof Error ? error.message : String(error)}`
            }
            return `Started ${key} and gave it the task.`
          }
        }
        return `Started ${key}, but it was not ready in 45 seconds; the task was not sent.`
      })
    }
    case 'forge_send': {
      const found = target(pane)
      const message = typeof args.message === 'string' ? args.message.slice(0, 20_000) : ''
      if (!message) throw new Error('There is no message to send.')
      // Typing into an agent that waits for an answer is answering it.
      const answering = found.status === 'blocked'
      return through(found.key, answering ? 'answer' : 'send', () => {
        if (!answering && paneStatus(lead.directory, found.key) === 'blocked') throw new Error(`${found.key} started asking something meanwhile; read it, and send again as an answer.`)
        typeInto(lead.directory, found.key, message, args.submit !== false)
        return `Sent to ${found.key}.`
      })
    }
    case 'forge_keys': {
      const found = target(pane)
      const keys = Array.isArray(args.keys) ? args.keys.filter((item): item is string => typeof item === 'string').slice(0, 40) : []
      return through(found.key, 'answer', () => {
        if (!pressKeys(lead.directory, found.key, keys)) throw new Error('None of those keys can be pressed.')
        return `Pressed ${keys.join(' ')} in ${found.key}.`
      })
    }
    case 'forge_read': {
      const found = target(pane)
      const lines = Math.min(400, Math.max(5, typeof args.lines === 'number' ? Math.round(args.lines) : 60))
      return through(found.key, 'read', () => {
        const read = paneText(lead.directory, found.key, lines)
        return read ? `${found.key} (${read.status}):\n${read.text}` : `${found.key} is not running.`
      })
    }
    case 'forge_wait': {
      const found = target(pane)
      // Below the lead's own tool time limit, so a wait always comes back.
      const seconds = Math.min(100, Math.max(1, typeof args.seconds === 'number' ? args.seconds : 90))
      return through(found.key, 'wait', async () => {
        const deadline = Date.now() + seconds * 1_000
        const started = Date.now()
        let seenWorking = false
        while (Date.now() < deadline && !signal.aborted) {
          const status = paneStatus(lead.directory, found.key)
          if (status === null) return `${found.key} has ended.`
          if (status === 'working') seenWorking = true
          // Just after a message it may not have started yet: idle counts once it worked, or after a while.
          if (status === 'blocked' || ((status === 'done' || status === 'idle') && (seenWorking || Date.now() - started > 10_000))) return `${found.key} is ${status}.`
          await sleep(1_000)
        }
        return `${found.key} is still ${paneStatus(lead.directory, found.key) ?? 'gone'} after ${String(seconds)} seconds.`
      })
    }
    case 'forge_stop': {
      const found = target(pane)
      if (found.startedBy !== lead.key) throw new Error(`${found.key} was not started by you; only the owner stops it.`)
      return through(found.key, 'stop', () => {
        closePane(lead.directory, found.key)
        context?.changed(lead.directory)
        return `Stopped ${found.key}.`
      })
    }
    default:
      throw new Error(`Unknown tool ${name}.`)
  }
}

// ---- The MCP endpoint (Streamable HTTP, plain JSON answers) ------------------------------------

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > 2_000_000) throw new Error('too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function reply(lead: Lead, message: { id?: unknown; method?: unknown; params?: Record<string, unknown> }, signal: AbortSignal): Promise<unknown> {
  const id = message.id
  if (id === undefined) return null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  switch (message.method) {
    case 'initialize':
      return ok({ protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0.0' } })
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: TOOLS })
    case 'tools/call': {
      const name = typeof message.params?.name === 'string' ? message.params.name : ''
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>
      try {
        return ok({ content: [{ type: 'text', text: await run(lead, name, args, signal) }] })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const stopped = forgePort().security?.isStop(error) === true ? `Stopped by the security core: ${reason}` : reason
        return ok({ content: [{ type: 'text', text: stopped }], isError: true })
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Only this machine's own address: a page elsewhere renamed to point here (DNS rebinding) is refused.
  if (request.headers.host !== `127.0.0.1:${String(port)}`) { response.writeHead(421).end(); return }
  const token = /^Bearer ([0-9a-f]{48})$/u.exec(request.headers.authorization ?? '')?.[1]
  const lead = token ? leads.get(token) : undefined
  if (!lead || request.url !== '/mcp') { response.writeHead(lead ? 404 : 401).end(); return }
  if (request.method === 'DELETE') { response.writeHead(200).end(); return }
  if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return }
  let parsed: unknown
  try { parsed = JSON.parse(await body(request)) } catch { response.writeHead(400).end(); return }
  const messages = Array.isArray(parsed) ? parsed : [parsed]
  // A lead that goes away stops its waits and loops.
  const leaving = new AbortController()
  request.on('close', () => { if (!response.writableEnded) leaving.abort() })
  const answers = (await Promise.all(messages.map(item => reply(lead, item as Parameters<typeof reply>[1], leaving.signal)))).filter(item => item !== null)
  if (answers.length === 0) { response.writeHead(202).end(); return }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]))
}

function listen(): Promise<void> {
  if (server) return Promise.resolve()
  // Tokens from an earlier run are dead: their files go.
  rmSync(leadFolder(), { recursive: true, force: true })
  return new Promise((resolve, reject) => {
    const created = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end() }) })
    created.on('error', reject)
    created.listen(0, '127.0.0.1', () => {
      const address = created.address()
      port = typeof address === 'object' && address ? address.port : 0
      server = created
      resolve()
    })
  })
}

export function stopLeads(): void {
  server?.close()
  server = null
  for (const lead of leads.values()) for (const file of lead.files) rmSync(file, { force: true })
  leads.clear()
}
