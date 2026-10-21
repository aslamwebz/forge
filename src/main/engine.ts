import { port } from './host'
import { basename } from 'node:path'
import { FORGE_AGENTS, forgeAgents } from './agents'
import { closePane, closeWorkspacePanes, forgetLastPanes, lastPanes, openPane, paneById, pasteInto, resizePane, runningPanes, writePane, type PaneStatus, type TerminalSink } from './forgeTerminal'
import { AUDITORS, markFinding, onReviewChange, reviewOf, saveReviewSettings, startReview, stopReview, type Finding } from './review'
import { forgeWorkspaces, isForgeWorkspace, pickWorkspace, removeWorkspace } from './workspaces'
import { deleteScript, findScript, saveScript, scriptsOf } from './scripts'
import { claudeSessionSaved, resumeArgs, sessionsOf } from './sessions'
import { dropLead, initLead, leadArgs } from './lead'
import { removeWorktree, worktreeFor, worktreesOf } from './worktrees'
import { FORGE_TEMPLATES, createProject, defaultLocation, isChosenLocation, pickLocation } from './templates'

export type ForgeResult = { ok: true; value: unknown } | { ok: false; error: string }
export interface ForgeEngine {
  /** One request from the Forge page. */
  handle(input: unknown): Promise<ForgeResult>
}

/**
 * The Forge's engine: the owner's workspaces, the coding CLIs he can start in them, and their panes.
 * Nothing is started here unless he asks; every request names one of his workspaces. It speaks to
 * the app only through its port, so it runs in the app's process or in one of its own.
 */
export function createEngine(): ForgeEngine {
  const push = (channel: string, value: unknown) => { port().push(channel, value) }
  /** How many tools run in a workspace, told to the sidebar whenever it changes. */
  const announce = (directory: string) => { push('freya:forge:state', { directory, running: runningPanes(directory).length }) }
  const directoryOf = new Map<string, string>()
  const keyOf = new Map<string, string>()
  /** He is told when an agent needs him or has finished (the app knows whether he is looking already). */
  const tell = (id: string, status: PaneStatus, before: PaneStatus) => {
    const pane = paneById(id)
    if (!pane) return
    if (status !== 'blocked' && !(status === 'done' && before === 'working')) return
    const agent = FORGE_AGENTS.find(item => item.id === pane.kind)?.label ?? pane.kind
    port().notify({ title: `${agent} ${status === 'blocked' ? 'needs you' : 'is done'}`, body: basename(pane.directory), silent: status !== 'blocked', directory: pane.directory, key: pane.key })
  }
  const sink: TerminalSink = {
    data: (id: string, data: string) => { push('freya:forge:term', { id, data }) },
    exit: (id: string, code: number) => {
      push('freya:forge:term', { id, exit: code })
      const directory = directoryOf.get(id)
      const key = keyOf.get(id)
      directoryOf.delete(id)
      keyOf.delete(id)
      // A lead that ended takes its token with it.
      if (directory && key) dropLead(directory, key)
      if (directory) announce(directory)
    },
    address: (id: string) => {
      const directory = directoryOf.get(id)
      if (directory) announce(directory)
    },
    status: (id, status, before) => {
      const directory = directoryOf.get(id)
      if (directory) announce(directory)
      tell(id, status, before)
    },
  }
  /** Only a local address (a dev server here) opens in his browser from the Forge. */
  const isLocal = (value: string) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    } catch { return false }
  }
  /** What runs in a workspace, each with the name the sidebar shows. */
  const running = (directory: string) => {
    const scripts = scriptsOf(directory)
    return runningPanes(directory).map(pane => ({
      ...pane,
      title: pane.kind === 'script' ? scripts.find(script => script.id === pane.key)?.name ?? 'Script'
        : pane.kind === 'shell' ? `Shell ${pane.key.replace(/^shell-/u, '')}`
          : FORGE_AGENTS.find(agent => agent.id === pane.kind)?.label ?? pane.kind,
    }))
  }
  onReviewChange(announce)
  // A lead starts agents itself: they open here, and the page is told so it shows them.
  initLead({
    open: async (directory, kind, startedBy, more, ownBranch) => {
      const used = new Set(runningPanes(directory).map(pane => pane.key))
      let n = 1
      while (used.has(`${kind}-${String(n)}`)) n += 1
      const key = `${kind}-${String(n)}`
      const tree = ownBranch ? worktreeFor(directory, key) : null
      const opened = await openPane(directory, key, kind, 120, 36, sink, { startedBy, more, ...(tree ? { cwd: tree.path, branch: tree.branch } : {}) })
      directoryOf.set(opened.id, directory)
      keyOf.set(opened.id, key)
      announce(directory)
      push('freya:forge:event', { directory, event: { type: 'panes-changed', properties: {} } })
      return key
    },
    changed: (directory) => {
      announce(directory)
      push('freya:forge:event', { directory, event: { type: 'panes-changed', properties: {} } })
    },
  })
  const size = (value: unknown, fallback: number) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback

  const handle = async (input: unknown): Promise<ForgeResult> => {
    const row = (input ?? {}) as Record<string, unknown>
    const text = (key: string, max = 20_000) => typeof row[key] === 'string' ? (row[key] as string).slice(0, max) : ''
    try {
      switch (row.op) {
        case 'workspaces':
          return { ok: true, value: forgeWorkspaces().map(item => { const items = running(item.directory); return { ...item, running: items.length, items } }) }
        case 'templates':
          return { ok: true, value: { templates: FORGE_TEMPLATES.map(({ id, name, description, command }) => ({ id, name, description, command })), location: defaultLocation() } }
        case 'pick-location':
          return { ok: true, value: await pickLocation() }
        case 'create-project':
          // Only where he chose (in the folder dialog) or the default: the page cannot name any folder.
          if (!isChosenLocation(text('location', 1_000))) return { ok: false, error: 'Choose the location with Change first.' }
          push('freya:forge:state', { directory: '', running: 0 })
          return { ok: true, value: createProject({ location: text('location', 1_000), name: text('name', 80), template: text('template', 40) }) }
        case 'open-external':
          if (!isLocal(text('url', 2_000))) return { ok: false, error: 'Only a local address opens from here.' }
          await port().openExternal(text('url', 2_000))
          return { ok: true, value: null }
        case 'open-link': {
          // A link he clicked in a terminal: web addresses only.
          const url = text('url', 2_000)
          if (!/^https?:\/\//iu.test(url)) return { ok: false, error: 'Only web links open from a terminal.' }
          await port().openExternal(url)
          return { ok: true, value: null }
        }
        case 'agents':
          return { ok: true, value: forgeAgents() }
        case 'open-folder':
          push('freya:forge:state', { directory: '', running: 0 })
          return { ok: true, value: await pickWorkspace() }
        case 'remove': {
          const workspace = forgeWorkspaces().find(item => item.id === text('id', 80))
          if (workspace) closeWorkspacePanes(workspace.directory)
          removeWorkspace(text('id', 80))
          return { ok: true, value: null }
        }
        // A pane is named by the id it was opened with; input is what he types into it.
        case 'pane-input':
          writePane(text('id', 80), text('data', 65_536), sink)
          return { ok: true, value: null }
        case 'pane-resize':
          resizePane(text('id', 80), size(row.cols, 80), size(row.rows, 24))
          return { ok: true, value: null }
      }
      const directory = row.directory
      if (!isForgeWorkspace(directory)) return { ok: false, error: 'That folder is not one of your workspaces.' }
      switch (row.op) {
        case 'last-panes': {
          // What ran here when the app last closed, each with the session to resume (Claude's by its id; the others' by when they started).
          const last = lastPanes(directory)
          if (last.length === 0) return { ok: true, value: [] }
          const known = last.some(pane => !pane.sessionId) ? await sessionsOf(directory) : []
          const used = new Set<string>()
          return { ok: true, value: last.map((pane) => {
            const command = FORGE_AGENTS.find(agent => agent.id === pane.kind)?.command
            const found = pane.sessionId ?? (command === 'agy' ? 'last'
              : [...known].reverse().find(session => session.tool === pane.kind && session.updated >= pane.startedAt - 5_000 && !used.has(session.id))?.id)
            if (found) used.add(found)
            return { kind: pane.kind, title: pane.title ?? null, resume: found ?? null, worktree: pane.branch?.replace(/^forge\//u, '') ?? null }
          }) }
        }
        case 'last-forget':
          forgetLastPanes(directory)
          return { ok: true, value: null }
        case 'sessions':
          return { ok: true, value: await sessionsOf(directory) }
        case 'panes':
          return { ok: true, value: running(directory) }
        case 'scripts': {
          const running = new Set(runningPanes(directory).filter(pane => pane.kind === 'script').map(pane => pane.key))
          return { ok: true, value: scriptsOf(directory).map(script => ({ ...script, running: running.has(script.id) })) }
        }
        case 'script-save':
          return { ok: true, value: saveScript(directory, { id: text('id', 80) || undefined, name: text('name', 80), command: text('command', 4_000), type: text('type', 10) }) }
        case 'script-delete':
          closePane(directory, text('id', 80))
          deleteScript(directory, text('id', 80))
          announce(directory)
          return { ok: true, value: null }
        case 'pane-open': {
          const kind = text('kind', 40)
          if (kind !== 'shell' && kind !== 'script' && !FORGE_AGENTS.some(agent => agent.id === kind)) return { ok: false, error: 'That is not one of the tools the Forge can start.' }
          // A script pane is named by the saved script's id; what it runs comes from the saved script.
          if (kind === 'script' && !findScript(directory, text('key', 80))) return { ok: false, error: 'That script is no longer saved in this workspace.' }
          // Showing a pane again never starts it again: one that ended stays ended until he starts it.
          if (row.attach === true && !runningPanes(directory).some(pane => pane.key === (text('key', 80) || kind))) return { ok: true, value: { id: null, replay: '' } }
          // Resuming: the tool's own resume arguments for a session it ran here.
          // A lead made from a Claude that never got a message has no saved conversation: it starts fresh.
          const asked = text('resume', 120)
          const resume = asked && row.lead === true && FORGE_AGENTS.find(item => item.id === kind)?.command === 'claude' && !claudeSessionSaved(kind, directory, asked) ? '' : asked
          // A lead made from a Claude conversation branches off a copy of it: the conversation itself
          // may still be running elsewhere (Claude refuses to resume a running one).
          const branch = resume && row.lead === true && FORGE_AGENTS.find(item => item.id === kind)?.command === 'claude' ? ['--fork-session'] : []
          const extra = resume && kind !== 'shell' && kind !== 'script' ? [...resumeArgs(kind, resume), ...branch] : []
          const key = text('key', 80) || kind
          // A lead: Claude Code with the Forge's tools, every call of which passes the Security Core.
          const agent = FORGE_AGENTS.find(item => item.id === kind)
          const lead = row.lead === true
          if (lead && agent?.command !== 'claude') return { ok: false, error: 'For now only Claude Code (or a Claude profile) can lead.' }
          // A running pane is shown again, not made a lead again (that would issue a token nobody uses).
          const fresh = !runningPanes(directory).some(pane => pane.key === key)
          const more = lead && agent && fresh ? await leadArgs(directory, key, agent.label) : []
          // Its own branch: a worktree named when it was first started, made or found again.
          const own = text('worktree', 80)
          const tree = own && fresh ? worktreeFor(directory, own) : null
          const opened = await openPane(directory, key, kind, size(row.cols, 100), size(row.rows, 30), sink, {
            resume: extra, more, lead, ...(tree ? { cwd: tree.path, branch: tree.branch } : {}), ...(text('title', 200) ? { title: text('title', 200) } : {}), ...(resume && resume !== 'last' ? { resumedId: resume } : {}),
          })
          directoryOf.set(opened.id, directory)
      keyOf.set(opened.id, key)
          announce(directory)
          return { ok: true, value: opened }
        }
        case 'review':
          return { ok: true, value: { ...reviewOf(directory), lenses: AUDITORS.map(({ id, name, optional }) => ({ id, name, optional: optional === true })) } }
        case 'review-save':
          saveReviewSettings(directory, row)
          return { ok: true, value: null }
        case 'review-run':
          return { ok: true, value: startReview(directory, row.checksOnly === true) }
        case 'review-stop':
          stopReview(directory)
          return { ok: true, value: null }
        case 'review-finding': {
          const status = text('status', 20) as Finding['status']
          if (!['open', 'dismissed', 'false-positive'].includes(status)) return { ok: false, error: 'Unknown finding status.' }
          return { ok: true, value: markFinding(directory, text('id', 40), status) }
        }
        case 'review-send': {
          // A finding goes to a builder running here, pasted for him to read and send with Enter.
          const finding = reviewOf(directory).run?.findings.find(item => item.id === text('id', 40))
          if (!finding) return { ok: false, error: 'That finding is gone.' }
          const lens = AUDITORS.find(item => item.id === finding.auditor)?.name ?? finding.auditor
          const message = [
            `Review finding (${lens}, ${finding.severity}): ${finding.title}`,
            `${finding.file}${finding.line ? `:${String(finding.line)}` : ''}`,
            finding.detail,
            finding.fix ? `Suggested fix: ${finding.fix}` : '',
            'Check it, and fix it if it is real.',
          ].filter(Boolean).join('\n')
          if (!pasteInto(directory, text('key', 80), message)) return { ok: false, error: 'That builder is not running any more.' }
          markFinding(directory, finding.id, 'sent')
          return { ok: true, value: null }
        }
        case 'worktrees': {
          const busy = new Set(runningPanes(directory).flatMap(pane => pane.branch ? [pane.branch] : []))
          return { ok: true, value: worktreesOf(directory).map(item => ({ ...item, running: busy.has(item.branch) })) }
        }
        case 'worktree-remove': {
          const name = text('name', 80)
          if (runningPanes(directory).some(pane => pane.branch === `forge/${name}`)) return { ok: false, error: 'An agent still works there: close its pane first.' }
          removeWorktree(directory, name)
          return { ok: true, value: null }
        }
        case 'pane-close':
          closePane(directory, text('key', 80))
          dropLead(directory, text('key', 80))
          announce(directory)
          return { ok: true, value: null }
        default:
          return { ok: false, error: 'Unknown Forge operation.' }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { handle }
}
