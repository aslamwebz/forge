import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORGE_AGENTS, launchEnv, locate } from './agents'
import { scriptsOf } from './scripts'

/**
 * The Forge's Review: what the owner runs, when he chooses, on a workspace's change. First his
 * checks (his "check" scripts; the exit code says pass or fail). Then auditors: each a fresh,
 * headless, read-only run of a coding CLI he picks (best another model than the one that built),
 * looking through one lens. Then a verifier that checks every finding against the code. What he
 * meant the change to do, his holdout scenarios (which builders never see) and the findings he
 * marked false are kept in the app's data, never in the project.
 */

export type Range = 'uncommitted' | 'last-commit' | 'branch' | 'project'
export type StepState = 'waiting' | 'running' | 'passed' | 'failed' | 'done' | 'error' | 'stopped' | 'skipped'
export interface Step { readonly id: string; readonly kind: 'check' | 'auditor' | 'verifier'; readonly name: string; state: StepState; output: string; note?: string }
export interface Finding {
  readonly id: string
  readonly auditor: string
  readonly severity: 'high' | 'medium' | 'low'
  readonly file: string
  readonly line?: number
  readonly title: string
  readonly detail: string
  readonly fix?: string
  verdict: 'confirmed' | 'rejected' | 'unverified'
  reason?: string
  status: 'open' | 'dismissed' | 'false-positive' | 'sent'
}
export interface ReviewRun { readonly id: string; readonly at: string; readonly range: Range; readonly runner: string; state: 'running' | 'done' | 'stopped'; readonly steps: Step[]; findings: Finding[] }
export interface ReviewSettings {
  intent: string
  range: Range
  runner: string
  auditors: string[]
  scenarios: { readonly id: string; readonly text: string }[]
  falsePositives: { readonly auditor: string; readonly title: string; readonly file: string }[]
}
interface Saved extends ReviewSettings { run?: ReviewRun }

/** The lenses. Each auditor looks only through its own. */
export const AUDITORS: readonly { readonly id: string; readonly name: string; readonly optional?: boolean; readonly lens: string }[] = Object.freeze([
  { id: 'correctness', name: 'Correctness', lens: 'Logic errors, wrong conditions, off-by-one, broken edge cases (empty, null, large, concurrent), unhandled errors, behaviour that does not work as written, regressions in code that calls the changed code.' },
  { id: 'security', name: 'Security', lens: 'Injection (SQL, shell, path, HTML), missing authorisation or authentication checks, secrets in code or logs, unsafe handling of user input or files, weak crypto, insecure defaults, risky new dependencies.' },
  { id: 'intent', name: 'Intent', lens: 'Whether the change does what the owner meant (his stated intent and the scenarios below): anything missing, half done, or done differently; and anything added that he did not ask for (scope creep).' },
  { id: 'tests', name: 'Test integrity', lens: 'Tests that do not really test: assertions that always pass, over-mocking that hides the real code, skipped or deleted tests, expectations weakened or changed just to pass, changed behaviour with no test, tests that test the mock.' },
  { id: 'slop', name: 'AI slop', lens: 'Signs of careless generated code: dead or unreachable code, needless abstractions and wrappers, duplicated helpers that already exist in the codebase, comments that narrate the obvious, placeholder or fake implementations, TODOs left behind, invented APIs or options that do not exist, defensive bloat, naming and style unlike the surrounding code.' },
  { id: 'architecture', name: 'Architecture', optional: true, lens: 'Fit with the existing structure: logic in the wrong layer, new coupling between parts that were separate, a second way of doing something the codebase already does one way, changes that will be hard to extend or undo.' },
])

/** CLIs that can run an auditor headless and read-only, each with its prompt on standard input. */
export const AUDIT_RUNNERS: readonly string[] = ['claude-minimax', 'claude-minimax-m3', 'claude', 'codex']
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git ls-files:*)']
const LIMIT_MS = 15 * 60_000
const KEEP = 20_000

const file = () => join(app.getPath('userData'), 'forge-review.json')
const keyOf = (directory: string) => directory.toLowerCase()
function readAll(): Record<string, Saved> {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Saved> : {}
  } catch { return {} }
}
function writeAll(all: Record<string, Saved>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(all, null, 2))
}
const defaults = (): Saved => ({ intent: '', range: 'uncommitted', runner: 'claude-minimax', auditors: AUDITORS.filter(item => !item.optional).map(item => item.id), scenarios: [], falsePositives: [] })

const live = new Map<string, { run: ReviewRun; children: Set<ChildProcess>; stopped: boolean }>()
let changed: (directory: string) => void = () => undefined
/** Who hears that a review moved on (the Forge page). */
export function onReviewChange(listener: (directory: string) => void): void { changed = listener }

export function reviewOf(directory: string): Saved & { readonly runners: readonly string[] } {
  const saved = { ...defaults(), ...readAll()[keyOf(directory)] }
  const running = live.get(keyOf(directory))?.run
  return { ...saved, ...(running ? { run: running } : {}), runners: AUDIT_RUNNERS }
}

function save(directory: string, update: (saved: Saved) => Saved): void {
  const all = readAll()
  all[keyOf(directory)] = update({ ...defaults(), ...all[keyOf(directory)] })
  writeAll(all)
}

export function saveReviewSettings(directory: string, input: Record<string, unknown>): void {
  save(directory, (saved) => {
    const ranges: Range[] = ['uncommitted', 'last-commit', 'branch', 'project']
    const scenarios = Array.isArray(input.scenarios) ? input.scenarios.flatMap((item: unknown) => {
      const row = item as { id?: unknown; text?: unknown }
      return typeof row?.text === 'string' && row.text.trim() ? [{ id: typeof row.id === 'string' ? row.id.slice(0, 40) : randomUUID(), text: row.text.trim().slice(0, 2_000) }] : []
    }).slice(0, 50) : saved.scenarios
    return {
      ...saved,
      intent: typeof input.intent === 'string' ? input.intent.slice(0, 4_000) : saved.intent,
      range: ranges.includes(input.range as Range) ? input.range as Range : saved.range,
      runner: AUDIT_RUNNERS.includes(input.runner as string) ? input.runner as string : saved.runner,
      auditors: Array.isArray(input.auditors) ? input.auditors.filter((id): id is string => AUDITORS.some(item => item.id === id)) : saved.auditors,
      scenarios,
    }
  })
}

/** What the change is, told to an auditor as the git commands that show it. */
function scope(directory: string, range: Range): string {
  const git = (args: string[]) => spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, env: launchEnv() })
  if (range === 'project' || git(['rev-parse', '--is-inside-work-tree']).status !== 0) return 'Review the project as a whole: read its files.'
  if (range === 'uncommitted') return 'The change is the uncommitted work: run `git status --porcelain` and `git diff HEAD`, and read any new untracked files.'
  if (range === 'branch') {
    const base = ['main', 'master', 'origin/main', 'origin/master'].find(name => git(['rev-parse', '--verify', '--quiet', name]).status === 0)
    if (base) return `The change is this branch against ${base}: run \`git log --oneline ${base}..HEAD\` and \`git diff ${base}...HEAD\`.`
  }
  return 'The change is the last commit: run `git show --stat HEAD` and `git show HEAD`.'
}

const JSON_SHAPE = '{"findings":[{"severity":"high|medium|low","file":"path/from/project/root","line":123,"title":"one line","detail":"what is wrong and the evidence","fix":"how to fix it"}]}'

function auditorPrompt(lens: (typeof AUDITORS)[number], settings: Saved, scopeText: string): string {
  const owner = lens.id === 'intent' || lens.id === 'tests'
  const known = settings.falsePositives.filter(item => item.auditor === lens.id)
  return [
    `You are the ${lens.name} auditor for a code change. You are read-only: never edit, write, or run anything but read commands.`,
    scopeText,
    `Look only for: ${lens.lens}`,
    owner && settings.intent.trim() ? `What the owner meant the change to do:\n${settings.intent.trim()}` : '',
    owner && settings.scenarios.length > 0 ? `Scenarios the change must satisfy (check each against the code):\n${settings.scenarios.map((item, index) => `${String(index + 1)}. ${item.text}`).join('\n')}` : '',
    known.length > 0 ? `The owner marked these as false before; do not report them again:\n${known.map(item => `- ${item.title} (${item.file})`).join('\n')}` : '',
    'Report only real problems you can point to in the code, with the evidence. No style nits, no praise, no summary. If there is nothing, report none.',
    `End your answer with one fenced json block exactly like:\n\`\`\`json\n${JSON_SHAPE}\n\`\`\``,
  ].filter(Boolean).join('\n\n')
}

function verifierPrompt(findings: readonly Finding[], scopeText: string): string {
  return [
    'You verify findings from code auditors. You are read-only: never edit or write.',
    scopeText,
    'For each finding below, open the code it names and decide: confirmed (the problem is real) or rejected (it is not, or the evidence is wrong). Be strict: an auditor guessing is rejected.',
    findings.map(item => `[${item.id}] (${item.auditor}, ${item.severity}) ${item.title}\n${item.file}${item.line ? `:${String(item.line)}` : ''}\n${item.detail}`).join('\n\n'),
    'End your answer with one fenced json block exactly like:\n```json\n{"verdicts":[{"id":"the id in brackets","verdict":"confirmed|rejected","reason":"one line"}]}\n```',
  ].join('\n\n')
}

/** The last json block of an answer. */
function lastJson(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gu)].map(match => match[1])
  const candidates = blocks.length > 0 ? blocks.reverse() : [text.slice(text.lastIndexOf('{"'))]
  for (const candidate of candidates) {
    const body = (candidate ?? '').trim()
    // A model sometimes leaves the last brackets off; close what it opened.
    for (const ending of ['', ']}', '}]}', '"}]}']) {
      try { return JSON.parse(body + ending) } catch { /* try the next */ }
    }
  }
  return null
}

// eslint-disable-next-line no-control-regex -- terminal colour codes are control characters
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/gu

/** Run one program headless; its output goes into the step. Resolves with its exit code and full output. */
function runProcess(entry: NonNullable<ReturnType<typeof live.get>>, step: Step, directory: string, file: string, args: readonly string[], env: Record<string, string>, stdin?: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let all = ''
    let child: ChildProcess
    try {
      child = spawn(file, [...args], { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, output: error instanceof Error ? error.message : String(error) })
      return
    }
    entry.children.add(child)
    let last = 0
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(ANSI, '')
      all += text
      step.output = (step.output + text).slice(-KEEP)
      if (Date.now() - last > 1_000) { last = Date.now(); changed(directory) }
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(stdin ?? '')
    const timer = setTimeout(() => { step.note = 'Stopped after 15 minutes.'; kill(child) }, LIMIT_MS)
    const done = (code: number | null) => { clearTimeout(timer); entry.children.delete(child); resolve({ code, output: all }) }
    child.on('error', (error) => { all += `\n${error.message}`; step.output += `\n${error.message}`; done(-1) })
    child.on('close', done)
  })
}

function kill(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGTERM')
}

/** The program and arguments for a runner; the prompt goes on standard input. */
function runnerCommand(runner: string): { file: string; args: string[]; env: Record<string, string> } {
  const agent = FORGE_AGENTS.find(item => item.id === runner)
  if (!agent || !AUDIT_RUNNERS.includes(runner)) throw new Error('That runner cannot audit.')
  const blocked = agent.needs?.() ?? null
  if (blocked) throw new Error(`${agent.label}: ${blocked}`)
  const path = locate(agent.command)
  if (!path) throw new Error(`${agent.label} is not installed.`)
  const env = { ...launchEnv(), ...(agent.env?.() ?? {}) }
  const args = agent.command === 'codex'
    ? ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-']
    : ['-p', '--output-format', 'text', '--allowedTools', ...READ_TOOLS, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']
  return /\.(cmd|bat)$/iu.test(path)
    ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', path, ...args], env }
    : { file: path, args, env }
}

/** Start a review: checks, then (unless only checks) the chosen auditors side by side, then the verifier. */
export function startReview(directory: string, checksOnly: boolean): ReviewRun {
  const key = keyOf(directory)
  if (live.get(key)?.run.state === 'running') throw new Error('A review is already running here.')
  const settings = { ...defaults(), ...readAll()[key] }
  const checks = scriptsOf(directory).filter(script => script.type === 'check')
  const lenses = checksOnly ? [] : AUDITORS.filter(item => settings.auditors.includes(item.id))
  if (checks.length === 0 && lenses.length === 0) throw new Error(checksOnly ? 'No check scripts yet. Add one in Scripts with the type “Check”.' : 'Choose at least one auditor, or add check scripts.')
  if (lenses.length > 0) runnerCommand(settings.runner)
  const run: ReviewRun = {
    id: randomUUID(), at: new Date().toISOString(), range: settings.range, runner: settings.runner, state: 'running', findings: [],
    steps: [
      ...checks.map(script => ({ id: `check:${script.id}`, kind: 'check' as const, name: script.name, state: 'waiting' as StepState, output: '' })),
      ...lenses.map(lens => ({ id: `auditor:${lens.id}`, kind: 'auditor' as const, name: lens.name, state: 'waiting' as StepState, output: '' })),
      ...(lenses.length > 0 ? [{ id: 'verifier', kind: 'verifier' as const, name: 'Verifier', state: 'waiting' as StepState, output: '' }] : []),
    ],
  }
  const entry = { run, children: new Set<ChildProcess>(), stopped: false }
  live.set(key, entry)
  void (async () => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
    for (const script of checks) {
      const step = run.steps.find(item => item.id === `check:${script.id}`)!
      if (entry.stopped) { step.state = 'stopped'; continue }
      step.state = 'running'
      changed(directory)
      const result = await runProcess(entry, step, directory, shell, process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', script.command] : ['-lc', script.command], launchEnv())
      step.state = entry.stopped ? 'stopped' : result.code === 0 ? 'passed' : 'failed'
      step.note = step.note ?? `Exit code ${String(result.code)}.`
      changed(directory)
    }
    const scopeText = lenses.length > 0 ? scope(directory, settings.range) : ''
    await Promise.all(lenses.map(async (lens) => {
      const step = run.steps.find(item => item.id === `auditor:${lens.id}`)!
      if (entry.stopped) { step.state = 'stopped'; return }
      step.state = 'running'
      changed(directory)
      try {
        const command = runnerCommand(settings.runner)
        const result = await runProcess(entry, step, directory, command.file, command.args, command.env, auditorPrompt(lens, settings, scopeText))
        const parsed = lastJson(result.output) as { findings?: unknown } | null
        if (!parsed || !Array.isArray(parsed.findings)) {
          step.state = entry.stopped ? 'stopped' : 'error'
          step.note = step.note ?? 'The auditor did not end with its findings block.'
        } else {
          const found = parsed.findings.slice(0, 30).flatMap((raw: unknown) => {
            const row = raw as Record<string, unknown>
            if (typeof row.title !== 'string' || typeof row.file !== 'string') return []
            const known = settings.falsePositives.some(item => item.auditor === lens.id && item.title === row.title && item.file === row.file)
            if (known) return []
            return [{
              id: randomUUID().slice(0, 8), auditor: lens.id, title: row.title.slice(0, 300), file: row.file.slice(0, 400),
              severity: row.severity === 'high' || row.severity === 'low' ? row.severity : 'medium',
              ...(typeof row.line === 'number' && Number.isInteger(row.line) ? { line: row.line } : {}),
              detail: typeof row.detail === 'string' ? row.detail.slice(0, 4_000) : '',
              ...(typeof row.fix === 'string' ? { fix: row.fix.slice(0, 4_000) } : {}),
              verdict: 'unverified', status: 'open',
            } satisfies Finding]
          })
          run.findings.push(...found)
          step.state = 'done'
          step.note = `${String(found.length)} finding${found.length === 1 ? '' : 's'}.`
        }
      } catch (error) {
        step.state = 'error'
        step.note = error instanceof Error ? error.message : String(error)
      }
      changed(directory)
    }))
    const verifier = run.steps.find(item => item.kind === 'verifier')
    if (verifier) {
      if (entry.stopped) verifier.state = 'stopped'
      else if (run.findings.length === 0) { verifier.state = 'skipped'; verifier.note = 'No findings to verify.' } else {
        verifier.state = 'running'
        changed(directory)
        try {
          const command = runnerCommand(settings.runner)
          const result = await runProcess(entry, verifier, directory, command.file, command.args, command.env, verifierPrompt(run.findings, scopeText))
          const parsed = lastJson(result.output) as { verdicts?: unknown } | null
          const verdicts = parsed && Array.isArray(parsed.verdicts) ? parsed.verdicts as { id?: unknown; verdict?: unknown; reason?: unknown }[] : []
          for (const verdict of verdicts) {
            const finding = run.findings.find(item => item.id === verdict.id)
            if (!finding || (verdict.verdict !== 'confirmed' && verdict.verdict !== 'rejected')) continue
            finding.verdict = verdict.verdict
            if (typeof verdict.reason === 'string') finding.reason = verdict.reason.slice(0, 1_000)
          }
          verifier.state = entry.stopped ? 'stopped' : verdicts.length > 0 ? 'done' : 'error'
          verifier.note = verdicts.length > 0 ? `${String(run.findings.filter(item => item.verdict === 'confirmed').length)} confirmed, ${String(run.findings.filter(item => item.verdict === 'rejected').length)} rejected.` : 'The verifier did not end with its verdicts block.'
        } catch (error) {
          verifier.state = 'error'
          verifier.note = error instanceof Error ? error.message : String(error)
        }
      }
    }
    run.state = entry.stopped ? 'stopped' : 'done'
    save(directory, saved => ({ ...saved, run }))
    live.delete(key)
    changed(directory)
  })()
  changed(directory)
  return run
}

export function stopReview(directory: string): void {
  const entry = live.get(keyOf(directory))
  if (!entry) return
  entry.stopped = true
  for (const child of entry.children) kill(child)
}

/** Every review, stopped with the app. */
export function stopReviews(): void {
  for (const entry of live.values()) { entry.stopped = true; for (const child of entry.children) kill(child) }
}

/** He decides about a finding: dismissed, false (never reported again), or sent to a builder. */
export function markFinding(directory: string, id: string, status: Finding['status']): Finding | null {
  let marked: Finding | null = null
  const running = live.get(keyOf(directory))?.run.findings.find(item => item.id === id)
  if (running) { running.status = status; marked = running }
  save(directory, (saved) => {
    const finding = saved.run?.findings.find(item => item.id === id) ?? running
    if (!finding) return saved
    finding.status = status
    marked = finding
    const falsePositives = status === 'false-positive' && !saved.falsePositives.some(item => item.auditor === finding.auditor && item.title === finding.title && item.file === finding.file)
      ? [...saved.falsePositives, { auditor: finding.auditor, title: finding.title, file: finding.file }].slice(-200)
      : saved.falsePositives
    return { ...saved, falsePositives }
  })
  if (marked) changed(directory)
  return marked
}
