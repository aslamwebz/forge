import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The coding CLIs the Forge can start, each in a workspace's folder, and the profiles built on them.
 * A CLI runs as it is (its own sign-in and settings). A profile runs the same program with its own
 * environment, so "Claude · MiniMax" talks to MiniMax with its own config folder while the owner's
 * own Claude runs beside it untouched. Only what is listed here can be started.
 */

export interface ForgeAgent {
  readonly id: string
  readonly label: string
  /** Short letters for the collapsed sidebar. */
  readonly mark: string
  /** The command name looked up on PATH. */
  readonly command: string
  /** The official install command, typed into a shell for the owner to run himself. */
  readonly install: string
  /** For a profile: why it cannot start yet (no key), or null. */
  readonly needs?: () => string | null
  /** For a profile: the environment it adds to the program's own. */
  readonly env?: () => Record<string, string>
  /** For a Claude profile: the config folder its sessions are kept in. */
  readonly configDir?: () => string
}

/**
 * OpenCode in the Forge keeps its data in a folder of its own. The OpenCode desktop app moves the
 * shared database (~/.local/share/opencode) ahead of the command-line OpenCode, which then cannot
 * open it ("no such column"); a folder of the Forge's own always matches the CLI that runs. The
 * owner's sign-ins are copied in at each start, except an OpenCode Zen key: an expired one breaks
 * even the free models, which work without one.
 */
export function opencodeEnv(): Record<string, string> {
  const home = join(app.getPath('userData'), 'forge', 'opencode-data')
  const folder = join(home, 'opencode')
  mkdirSync(folder, { recursive: true })
  const shared = join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'opencode', 'auth.json')
  try {
    if (existsSync(shared)) {
      const auth = JSON.parse(readFileSync(shared, 'utf8')) as Record<string, unknown>
      delete auth.opencode
      writeFileSync(join(folder, 'auth.json'), JSON.stringify(auth, null, 2))
    }
  } catch { /* without sign-ins it still runs the free models */ }
  return { XDG_DATA_HOME: home }
}

/** Claude Code pointed at MiniMax's Anthropic-compatible endpoint, with a config folder of its own. */
function claudeOnMiniMax(model: string): Pick<ForgeAgent, 'needs' | 'env' | 'configDir'> {
  return {
    configDir: () => join(app.getPath('userData'), 'forge', `claude-minimax-${model.toLowerCase()}`),
    needs: () => process.env.MINIMAX_API_KEY ? null : 'Needs a MiniMax key (Settings → Models).',
    env: () => {
      const configDir = join(app.getPath('userData'), 'forge', `claude-minimax-${model.toLowerCase()}`)
      mkdirSync(configDir, { recursive: true })
      return {
        ANTHROPIC_BASE_URL: process.env.MINIMAX_ANTHROPIC_BASE_URL?.trim() || 'https://api.minimax.io/anthropic',
        ANTHROPIC_AUTH_TOKEN: process.env.MINIMAX_API_KEY ?? '',
        ANTHROPIC_MODEL: model,
        ANTHROPIC_SMALL_FAST_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        API_TIMEOUT_MS: '600000',
        CLAUDE_CONFIG_DIR: configDir,
      }
    },
  }
}

export const FORGE_AGENTS: readonly ForgeAgent[] = Object.freeze([
  { id: 'opencode', label: 'OpenCode', mark: 'OC', command: 'opencode', install: 'npm install -g opencode-ai', env: opencodeEnv },
  { id: 'claude', label: 'Claude', mark: 'CL', command: 'claude', install: 'irm https://claude.ai/install.ps1 | iex' },
  { id: 'claude-minimax', label: 'Claude · MiniMax', mark: 'CM', command: 'claude', install: 'irm https://claude.ai/install.ps1 | iex', ...claudeOnMiniMax('MiniMax-M2.7-highspeed') },
  { id: 'claude-minimax-m3', label: 'Claude · MiniMax M3', mark: 'C3', command: 'claude', install: 'irm https://claude.ai/install.ps1 | iex', ...claudeOnMiniMax('MiniMax-M3') },
  { id: 'codex', label: 'Codex', mark: 'CX', command: 'codex', install: 'npm install -g @openai/codex' },
  { id: 'mcode', label: 'MiniMax Code', mark: 'MC', command: 'mcode', install: 'irm https://filecdn.minimax.chat/public/install.ps1 | iex' },
  { id: 'agy', label: 'Antigravity', mark: 'AG', command: 'agy', install: 'irm https://antigravity.google/cli/install.ps1 | iex' },
])

const SESSION_MARKER = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_JOB_DIR|CLAUDE_EFFORT|CLAUDE_CODE_(SESSION_\w+|CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_\w+|ALT_SCREEN_\w+))$/u

/** The environment a Forge program starts with: PATH as saved now, and no session markers of a CLI that launched the app. */
export function launchEnv(): Record<string, string> {
  const env = { ...process.env, PATH: freshPath() } as Record<string, string>
  for (const name of Object.keys(env)) if (SESSION_MARKER.test(name)) delete env[name]
  // A pane is a real colour terminal, whatever started the app (a tool's shell may set NO_COLOR).
  delete env.NO_COLOR
  if (env.FORCE_COLOR === '0') delete env.FORCE_COLOR
  env.COLORTERM = 'truecolor'
  return env
}

let pathCache: { readonly at: number; readonly value: string } | null = null
/**
 * PATH as it is saved now, not as it was when the app started, so a tool installed while the app runs
 * is found without a restart. Read at most every 20 seconds.
 */
export function freshPath(): string {
  const current = process.env.PATH ?? ''
  if (process.platform !== 'win32') return current
  if (pathCache && Date.now() - pathCache.at < 20_000) return pathCache.value
  const saved = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8', windowsHide: true }).stdout ?? ''
  const parts = [...saved.split(';'), ...current.split(';')].map(part => part.trim()).filter(Boolean)
  const seen = new Set<string>()
  const value = parts.filter(part => { const key = part.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true }).join(';')
  pathCache = { at: Date.now(), value }
  return value
}

/** Where a program is, preferring a real executable over a .cmd launcher; null when it is not installed. */
export function locate(command: string): string | null {
  const env = { ...process.env, PATH: freshPath() }
  const lookup = process.platform === 'win32'
    ? spawnSync('where', [command], { encoding: 'utf8', windowsHide: true, env })
    : spawnSync('which', [command], { encoding: 'utf8', env })
  const found = (lookup.stdout ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (found.length === 0) return null
  return found.find(path => /\.exe$/iu.test(path)) ?? found.find(path => /\.(cmd|bat)$/iu.test(path)) ?? found[0]!
}

/** Every CLI and profile, with whether it can start here, and why not when it cannot. */
export function forgeAgents(): readonly { readonly id: string; readonly label: string; readonly mark: string; readonly install: string; readonly installed: boolean; readonly blocked: string | null }[] {
  const found = new Map<string, boolean>()
  return FORGE_AGENTS.map(agent => {
    if (!found.has(agent.command)) found.set(agent.command, locate(agent.command) !== null)
    return { id: agent.id, label: agent.label, mark: agent.mark, install: agent.install, installed: found.get(agent.command) === true, blocked: agent.needs?.() ?? null }
  })
}
