import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AgentIcon } from './AgentIcon'
import { bridge, call, STATUS_LABEL, topStatus, type Agent, type PaneSpec, type RunningItem, type Script, type Workspace } from './forgeApi'
import { LookMenu } from './LookMenu'
import { NewProject } from './NewProject'
import { PaneGrid, useLayout, useSubLayout, type Layout, type SubLayout } from './PaneGrid'
import { PreviewsTab } from './PreviewsTab'
import { ReviewTab } from './ReviewTab'
import { SessionsPanel } from './SessionsPanel'
import { markStarted, TerminalPane } from './TerminalPane'
import './forge.css'

/**
 * The Forge: the owner's workplace for coding agents. Workspaces are folders he opened or projects
 * he made here; each lists what runs in it. Four tabs: Harness (the coding CLIs he starts, side by
 * side), Review (testing and auditors), Live previews (running dev servers) and Scripts (his saved
 * commands). Under them, a terminal panel he can hide: his shells and the scripts he runs. Nothing
 * starts on its own, and everything keeps running when he leaves the Forge.
 */

interface DockTerminal extends RunningItem { /** A new run of the same script gets a fresh terminal. */ readonly run?: number }
type Tab = 'harness' | 'review' | 'previews' | 'scripts'

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'harness', label: 'Harness' }, { id: 'review', label: 'Review' }, { id: 'previews', label: 'Live previews' }, { id: 'scripts', label: 'Scripts' },
]
const RAIL_KEY = 'freya.forge.agentsOpen'
const DOCK_KEY = 'freya.forge.terminalOpen'
const DOCK_HEIGHT_KEY = 'freya.forge.terminalHeight'
const LAST_KEY = 'freya.forge.lastWorkspace'
const inDock = (kind: string) => kind === 'shell' || kind === 'script'

/** The next free key for a kind of pane: shell-1, shell-2, ... */
function nextKey(kind: string, used: readonly PaneSpec[]): string {
  const keys = new Set(used.map(pane => pane.key))
  let n = 1
  while (keys.has(`${kind}-${String(n)}`)) n += 1
  return `${kind}-${String(n)}`
}

/** "Claude · <session>": the tool's name once, however often an older title repeated it. */
function titled(label: string, title: string): string {
  let rest = title
  while (rest.startsWith(`${label} · `)) rest = rest.slice(label.length + 3)
  return rest === label || rest === '' ? label : `${label} · ${rest}`
}

/** The same pane keeps the same object, so its terminal is not set up again. */
function keep<T extends PaneSpec>(before: readonly T[], after: readonly T[]): T[] {
  return after.map(item => before.find(old => old.key === item.key && old.kind === item.kind) ?? item)
}

export function ForgeWorkspace() {
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([])
  const [agents, setAgents] = useState<readonly Agent[]>([])
  const [current, setCurrent] = useState<Workspace | null>(null)
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [panes, setPanes] = useState<readonly RunningItem[]>([])
  const [dock, setDock] = useState<readonly DockTerminal[]>([])
  const [dockActive, setDockActive] = useState<string | null>(null)
  const [dockOpen, setDockOpen] = useState(() => localStorage.getItem(DOCK_KEY) === 'open')
  const [dockHeight, setDockHeight] = useState(() => Number(localStorage.getItem(DOCK_HEIGHT_KEY)) || 280)
  const [tab, setTab] = useState<Tab>('harness')
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [layout, setLayout] = useLayout()
  const [subLayout, setSubLayout] = useSubLayout()
  const [zoomed, setZoomed] = useState<string | null>(null)
  /** What ran in the shown workspace when the app last closed, offered to restore. */
  const [last, setLast] = useState<readonly { readonly kind: string; readonly title: string | null; readonly resume: string | null }[]>([])
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== 'closed')
  const [error, setError] = useState<string | null>(null)
  const fail = useCallback((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }, [])
  const load = useCallback(async () => {
    const list = await call<Workspace[]>({ op: 'workspaces' })
    setWorkspaces(list)
    return list
  }, [])
  const loadAgents = useCallback(async () => { setAgents(await call<Agent[]>({ op: 'agents' })) }, [])
  const refreshAgents = useCallback(() => { void loadAgents().catch(() => undefined) }, [loadAgents])
  useEffect(() => { localStorage.setItem(RAIL_KEY, railOpen ? 'open' : 'closed') }, [railOpen])
  useEffect(() => { localStorage.setItem(DOCK_KEY, dockOpen ? 'open' : 'closed') }, [dockOpen])
  useEffect(() => { localStorage.setItem(DOCK_HEIGHT_KEY, String(dockHeight)) }, [dockHeight])

  // Ctrl+` shows and hides the terminal panel, as in an editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.ctrlKey && event.key === '`') { event.preventDefault(); setDockOpen(open => !open) } }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  // What runs in each workspace, as it changes.
  useEffect(() => bridge()?.onForgeState?.(() => { void load().catch(() => undefined) }), [load])
  // A notification he clicked: that workspace, that agent in front for a moment.
  const focusRef = useRef<(directory: string, key: string) => void>(() => undefined)
  useEffect(() => bridge()?.onForgeEvent?.(({ directory, event }) => {
    if (event.type !== 'focus-pane') return
    const key = (event.properties as { key?: unknown } | null)?.key
    if (typeof key === 'string') focusRef.current(directory, key)
  }), [])
  // A lead started or stopped an agent: the Harness shows what runs now.
  const refreshRef = useRef<(directory: string) => void>(() => undefined)
  useEffect(() => bridge()?.onForgeEvent?.(({ directory, event }) => { if (event.type === 'panes-changed') refreshRef.current(directory) }), [])

  const label = (kind: string) => agents.find(agent => agent.id === kind)?.label ?? kind
  /** Show a workspace: its agents in the Harness, its shells and scripts in the panel, then what he clicked. */
  const choose = useCallback((workspace: Workspace, focus?: { readonly tab?: Tab; readonly dockKey?: string; readonly newDock?: DockTerminal }) => {
    setError(null)
    setCreating(false)
    setCurrent(workspace)
    setExpanded(open => new Set(open).add(workspace.id))
    localStorage.setItem(LAST_KEY, workspace.id)
    void call<RunningItem[]>({ op: 'panes', directory: workspace.directory }).then((running) => {
      for (const pane of running) markStarted(pane)
      setPanes(before => keep(before, running.filter(pane => !inDock(pane.kind))))
      setDock((before) => {
        const terminals: DockTerminal[] = keep(before, running.filter(pane => inDock(pane.kind)))
        return focus?.newDock ? [...terminals, focus.newDock] : terminals
      })
      const active = focus?.newDock?.key ?? focus?.dockKey
      setDockActive(previous => active ?? (running.some(pane => pane.key === previous) ? previous : running.find(pane => inDock(pane.kind))?.key ?? null))
      if (active) setDockOpen(true)
      if (focus?.tab) setTab(focus.tab)
    }).catch(fail)
  }, [fail])

  refreshRef.current = (directory) => {
    const workspace = workspaces.find(item => item.directory === directory)
    if (workspace && current?.directory === directory && !creating) choose(workspace)
  }
  focusRef.current = (directory, key) => {
    const workspace = workspaces.find(item => item.directory === directory)
    if (!workspace) return
    choose(workspace, { tab: 'harness' })
    setFlash(key)
    setTimeout(() => { setFlash(current => current === key ? null : current) }, 2_500)
  }

  // Opening the Forge: the last workspace he used, or a new project.
  const opened = useRef(false)
  useEffect(() => {
    void loadAgents().catch(fail)
    void load().then((list) => {
      if (opened.current) return
      opened.current = true
      const last = list.find(item => item.id === localStorage.getItem(LAST_KEY)) ?? null
      if (last) choose(last)
      else setCreating(true)
    }).catch(fail)
  }, [load, loadAgents, choose, fail])

  const openFolder = async () => {
    try {
      const picked = await call<Omit<Workspace, 'running' | 'items'> | null>({ op: 'open-folder' })
      const list = await load()
      const workspace = list.find(item => item.id === picked?.id)
      if (workspace) choose(workspace)
    } catch (reason) { fail(reason) }
  }
  const remove = async (workspace: Workspace) => {
    // Taking it off the list stops what runs in it, so ask first when something does.
    if (workspace.running > 0 && !window.confirm(`Take ${workspace.name} off the list? This stops the ${String(workspace.running)} running in it. Its files stay.`)) return
    try {
      await call({ op: 'remove', id: workspace.id })
      if (current?.id === workspace.id) { setCurrent(null); setPanes([]); setDock([]); setCreating(true) }
      await load()
    } catch (reason) { fail(reason) }
  }
  /** Start an agent in the chosen workspace, in a new pane beside the others; or open one of its sessions again. */
  const start = (kind: string, resume?: { readonly id: string; readonly title: string }) => {
    if (!current) { setError('Choose a workspace first.'); return }
    setError(null)
    setTab('harness')
    setPanes(list => [...list, { key: nextKey(kind, list), kind, title: resume ? titled(label(kind), resume.title) : label(kind), ...(resume ? { resume: resume.id } : {}) }])
  }
  /** A Claude pane becomes the lead: it restarts in the same conversation, now with the Forge's tools. */
  const makeLead = async (pane: RunningItem) => {
    if (!current) return
    const session = showing?.items.find(item => item.key === pane.key)?.sessionId
    try {
      await call({ op: 'pane-close', directory: current.directory, key: pane.key })
      setPanes(list => list.map(item => item.key === pane.key ? { key: pane.key, kind: pane.kind, title: pane.title, lead: true, ...(session ? { resume: session } : {}) } : item))
      setLayout('lead')
      setZoomed(null)
    } catch (reason) { fail(reason) }
  }
  const closePane = (key: string) => {
    if (!current) return
    void call({ op: 'pane-close', directory: current.directory, key }).catch(() => undefined)
    setPanes(list => list.filter(pane => pane.key !== key))
  }
  /** A terminal in the panel, shown and chosen. */
  const addToDock = (terminal: DockTerminal) => {
    setDock(list => list.some(item => item.key === terminal.key) ? (terminal.run === undefined ? list : list.map(item => item.key === terminal.key ? terminal : item)) : [...list, terminal])
    setDockActive(terminal.key)
    setDockOpen(true)
  }
  const shellFor = (list: readonly PaneSpec[], typeFirst?: string): DockTerminal => {
    const key = nextKey('shell', list)
    return { key, kind: 'shell', title: `Shell ${key.replace(/^shell-/u, '')}`, ...(typeFirst ? { typeFirst } : {}) }
  }
  const newShell = (typeFirst?: string) => {
    if (!current) { setError('Choose a workspace first.'); return }
    addToDock(shellFor(dock, typeFirst))
  }
  const closeDock = (key: string) => {
    if (!current) return
    void call({ op: 'pane-close', directory: current.directory, key }).catch(() => undefined)
    const left = dock.filter(item => item.key !== key)
    setDock(left)
    if (dockActive === key) setDockActive(left[left.length - 1]?.key ?? null)
  }
  // Drag the panel's top edge to make it taller or shorter.
  const resizeDock = (event: ReactPointerEvent) => {
    const startY = event.clientY
    const startHeight = dockHeight
    const move = (moved: PointerEvent) => { setDockHeight(Math.round(Math.min(window.innerHeight * 0.8, Math.max(120, startHeight + startY - moved.clientY)))) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  /** A saved script, run in the panel; one that ended runs again in a fresh terminal. */
  const runScript = (script: Script) => { addToDock({ key: script.id, kind: 'script', title: script.name, ...(script.running ? {} : { run: Date.now() }) }) }
  /** A click on something running under a workspace: that workspace, and that thing in front. */
  const focusItem = (workspace: Workspace, item: RunningItem, preview = false) => {
    if (preview) { setPreviewKey(item.key); choose(workspace, { tab: 'previews' }) }
    else if (inDock(item.kind)) choose(workspace, { dockKey: item.key })
    else choose(workspace, { tab: 'harness' })
  }
  const toggle = (workspace: Workspace) => {
    if (current?.id !== workspace.id || creating) { choose(workspace); return }
    setExpanded((open) => { const next = new Set(open); if (next.has(workspace.id)) next.delete(workspace.id); else next.add(workspace.id); return next })
  }
  const active = dock.find(item => item.key === dockActive) ?? null
  const shownDirectory = creating || !current ? null : current.directory
  useEffect(() => {
    setLast([])
    if (!shownDirectory) return
    void call<{ kind: string; title: string | null; resume: string | null }[]>({ op: 'last-panes', directory: shownDirectory }).then(setLast).catch(() => undefined)
  }, [shownDirectory])
  /** Bring back what ran here last time, each agent in its own session. */
  const restore = () => {
    for (const item of last) start(item.kind, item.resume ? { id: item.resume, title: item.title ?? 'last session' } : undefined)
    forget()
  }
  const forget = () => {
    setLast([])
    if (shownDirectory) void call({ op: 'last-forget', directory: shownDirectory }).catch(() => undefined)
  }
  // The workspace as last listed, so what runs in it stays current.
  const showing = creating || !current ? null : workspaces.find(item => item.id === current.id) ?? current

  return <>
    <div className="fg-forge" data-rail={showing && tab === 'harness' ? (railOpen ? 'open' : 'closed') : 'none'}>
      <aside className="fg-apps" aria-label="Workspaces">
        <div className="fg-apps-head">
          <p className="fg-label">Workspaces</p>
          <button type="button" className="fg-add" aria-label="New project or open a folder" title="New project or open a folder" aria-pressed={creating} onClick={() => { setCreating(true) }}>+</button>
        </div>
        <ul className="fg-tree">
          {workspaces.map((item) => {
            const open = expanded.has(item.id)
            const groups = [
              { name: 'Agents', items: item.items.filter(run => !inDock(run.kind)) },
              { name: 'Scripts', items: item.items.filter(run => run.kind === 'script') },
              { name: 'Terminals', items: item.items.filter(run => run.kind === 'shell') },
              { name: 'Previews', items: item.items.filter(run => run.url) },
            ].filter(group => group.items.length > 0)
            return <li key={item.id}>
              <div className="fg-ws">
                <button type="button" aria-current={item.id === showing?.id ? 'true' : undefined} aria-expanded={open} title={item.directory} onClick={() => { toggle(item) }}>
                  <span className="fg-caret" data-open={open || undefined} aria-hidden="true">›</span>
                  <span className="fg-dot" data-state={topStatus(item.items) ?? (item.running > 0 ? 'running' : 'idle')} aria-hidden="true" />
                  <span className="fg-ws-name">{item.name}</span>
                  {topStatus(item.items) === 'blocked' ? <span className="fg-ws-state" data-state="blocked">needs you</span> : item.running > 0 ? <span className="fg-ws-state">{item.running}</span> : null}
                </button>
                <button type="button" className="fg-ws-remove" aria-label={`Take ${item.name} off the list (its files stay)`} title="Take off the list (files stay)" onClick={() => { void remove(item) }}>×</button>
              </div>
              {open ? <ul className="fg-sub">
                {groups.length === 0 ? <li className="fg-sub-empty">Nothing running</li> : groups.map(group => <li key={group.name}>
                  <span className="fg-sub-label">{group.name}</span>
                  <ul>{group.items.map(run => <li key={run.key}>
                    <button type="button" className="fg-sub-item" onClick={() => { focusItem(item, run, group.name === 'Previews') }}>
                      {group.name === 'Previews' ? <span className="fg-sub-kind" aria-hidden="true">◉</span> : inDock(run.kind) ? <span className="fg-sub-kind" aria-hidden="true">{run.kind === 'script' ? '▶' : '>_'}</span> : <AgentIcon id={run.kind} mark={agents.find(agent => agent.id === run.kind)?.mark ?? '?'} />}
                      <span>{group.name === 'Previews' ? run.url?.replace(/^https?:\/\//u, '') : run.title}</span>
                      {group.name === 'Agents' && run.status ? <span className="fg-status-chip" data-state={run.status}>{STATUS_LABEL[run.status]}</span> : null}
                    </button>
                  </li>)}</ul>
                </li>)}
              </ul> : null}
            </li>
          })}
          {workspaces.length === 0 && <li className="fg-empty fg-sub-empty">No workspaces yet.</li>}
        </ul>
        {error && <p className="fg-error" role="alert">{error}</p>}
      </aside>

      <section className="fg-main" aria-label={showing ? showing.name : 'New project'}>
        {!showing ? <div className="fg-body fg-scroll"><NewProject onOpenFolder={() => { void openFolder() }} onCreated={(workspace, command) => {
          void load().then((list) => {
            const made = list.find(item => item.id === workspace.id) ?? workspace
            choose(made, { tab: 'harness', newDock: shellFor([], command ? `${command}\r` : undefined) })
          }).catch(fail)
        }} /></div> : <>
          <header className="fg-main-head">
            <nav className="fg-tabs" role="tablist" aria-label="Forge">
              {TABS.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id) }}>{item.label}</button>)}
            </nav>
            {tab === 'harness' && panes.length > 1 ? <div className="fg-row fg-layouts" role="group" aria-label="Layout">
              {(['columns', 'rows', 'grid', 'lead'] as const satisfies readonly Layout[]).map(item => { const name = item === 'columns' ? 'Side by side' : item === 'rows' ? 'Stacked' : item === 'grid' ? 'Grid' : 'Lead on one half'; return <button key={item} type="button" aria-pressed={layout === item && !zoomed} aria-label={name} title={name} onClick={() => { setZoomed(null); setLayout(item) }}>{item === 'columns' ? '▥' : item === 'rows' ? '☰' : item === 'grid' ? '▦' : '◧'}</button> })}
              {layout === 'lead' && panes.length > 2 ? <span className="fg-sublayouts" role="group" aria-label="The others">
                {(['rows', 'columns', 'grid'] as const satisfies readonly SubLayout[]).map(item => { const name = `The others ${item === 'rows' ? 'stacked' : item === 'columns' ? 'side by side' : 'in a grid'}`; return <button key={item} type="button" aria-pressed={subLayout === item} aria-label={name} title={name} onClick={() => { setSubLayout(item) }}>{item === 'rows' ? '☰' : item === 'columns' ? '▥' : '▦'}</button> })}
              </span> : null}
            </div> : null}
            <LookMenu />
            <span className="fg-path" title={showing.directory}><b>{showing.name}</b> {showing.directory}</span>
          </header>
          <div className="fg-body">
            {tab === 'harness' ? (panes.length > 0
              ? <PaneGrid keys={panes.map(pane => pane.key)} layout={layout} subLayout={subLayout} lead={panes.find(pane => pane.lead)?.key ?? showing.items.find(item => item.lead)?.key ?? null} zoomed={panes.some(pane => pane.key === zoomed) ? zoomed : null}
                onSwap={(from, to) => { setPanes((list) => { const a = list.findIndex(pane => pane.key === from); const b = list.findIndex(pane => pane.key === to); if (a < 0 || b < 0) return list; const next = [...list]; [next[a], next[b]] = [next[b]!, next[a]!]; return next }) }}
                render={(key, drag) => {
                  const pane = panes.find(item => item.key === key)
                  return pane ? <TerminalPane key={`${showing.directory}::${pane.key}`} directory={showing.directory} pane={pane} title={pane.title} status={showing.items.find(item => item.key === pane.key)?.status} flash={flash === pane.key}
                    zoomed={zoomed === pane.key} onZoom={() => { setZoomed(current => current === pane.key ? null : pane.key) }} onDragStart={drag.onDragStart}
                    {...(agents.find(agent => agent.id === pane.kind)?.id.startsWith('claude') ? { onMakeLead: () => { void makeLead(pane) } } : {})}
                    onError={fail} onClose={() => { closePane(pane.key) }} onEnded={refreshAgents} /> : null
                }} />
              : last.length > 0 ? <div className="fg-restore">
                <p>When the app closed, these were running here:</p>
                <ul>{last.map((item, index) => <li key={String(index)}><AgentIcon id={item.kind} mark={agents.find(agent => agent.id === item.kind)?.mark ?? '?'} /><span>{item.title ? titled(label(item.kind), item.title) : label(item.kind)}</span><span className="fg-hint">{item.resume ? 'resumes its session' : 'starts fresh'}</span></li>)}</ul>
                <div className="fg-row"><button type="button" className="fg-primary" onClick={restore}>Restore</button><button type="button" onClick={forget}>Not now</button></div>
              </div>
              : <p className="fg-empty fg-idle">Nothing is running here. Start an agent from the right.</p>)
              : tab === 'scripts' ? <ScriptsTab key={showing.directory} directory={showing.directory} onError={fail}
                onRun={runScript}
                onStop={(script) => { closeDock(script.id) }} />
                : tab === 'review' ? <ReviewTab key={showing.directory} directory={showing.directory} agents={agents} builders={showing.items.filter(item => !inDock(item.kind))} onError={fail} />
                  : <PreviewsTab key={showing.directory} directory={showing.directory} items={showing.items} chosen={previewKey} onChoose={setPreviewKey} onRun={runScript} onError={fail} />}
            {sessionsOpen && tab === 'harness' ? <SessionsPanel directory={showing.directory} agents={agents} onClose={() => { setSessionsOpen(false) }}
              onResume={(tool, id, title) => { setSessionsOpen(false); start(tool, { id, title }) }} /> : null}
          </div>

          <div className="fg-dock" data-open={dockOpen || undefined} style={dockOpen ? { height: `${String(dockHeight)}px` } : undefined}>
            {dockOpen ? <div className="fg-dock-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal panel" onPointerDown={resizeDock} /> : null}
            <div className="fg-dock-head">
              <button type="button" className="fg-dock-title" aria-expanded={dockOpen} title="Show or hide the terminal panel (Ctrl+`)" onClick={() => { setDockOpen(open => !open) }}>
                Terminal{dock.length > 0 ? ` · ${String(dock.length)}` : ''}
              </button>
              <div className="fg-dock-tabs" role="tablist" aria-label="Terminals">
                {dock.map(item => <span key={item.key} className="fg-dock-tab" aria-selected={item.key === dockActive}>
                  <button type="button" role="tab" aria-selected={item.key === dockActive} onClick={() => { setDockActive(item.key); setDockOpen(true) }}>
                    <span className="fg-dock-kind" aria-hidden="true">{item.kind === 'script' ? '▶' : '>_'}</span>{item.title}
                  </button>
                  <button type="button" className="fg-dock-close" aria-label={`Close ${item.title}`} title="Close (stops what runs in it)" onClick={() => { closeDock(item.key) }}>×</button>
                </span>)}
              </div>
              <button type="button" className="fg-dock-add" aria-label="New terminal" title="New terminal" onClick={() => { newShell() }}>+</button>
              <button type="button" className="fg-dock-hide" aria-label={dockOpen ? 'Hide the terminal panel' : 'Show the terminal panel'} onClick={() => { setDockOpen(open => !open) }}>{dockOpen ? '⌄' : '⌃'}</button>
            </div>
            {dockOpen ? (active
              ? <TerminalPane key={`${showing.directory}::${active.key}::${String(active.run ?? 0)}`} directory={showing.directory} pane={active} title={active.title} onError={fail} onClose={() => { closeDock(active.key) }} onEnded={refreshAgents} bare />
              : <p className="fg-empty fg-idle">No terminals. Press + for a shell, or run a script.</p>) : null}
          </div>
        </>}
      </section>

      {showing && tab === 'harness' ? <aside className="fg-agents" aria-label="Agents">
        <button type="button" className="fg-agents-toggle" aria-label={railOpen ? 'Collapse agents' : 'Expand agents'} aria-expanded={railOpen} onClick={() => { setRailOpen(open => !open) }}>{railOpen ? '›' : '‹'}</button>
        <button type="button" className="fg-agent fg-agent-sessions" data-ready aria-pressed={sessionsOpen} title="Sessions that ran here, to resume" onClick={() => { setSessionsOpen(open => !open) }}>
          <span className="fg-mark" aria-hidden="true">⟲</span><span className="fg-agent-name">Resume a session</span>
        </button>
        {agents.map((agent) => {
          const ready = agent.installed && agent.blocked === null
          const title = !agent.installed ? `Not installed. Opens a terminal with: ${agent.install}` : agent.blocked ?? `Start ${agent.label} here`
          return <button key={agent.id} type="button" className="fg-agent" data-ready={ready || undefined} title={title} disabled={agent.installed && agent.blocked !== null}
            onClick={() => { if (!agent.installed) newShell(agent.install); else start(agent.id) }}>
            <AgentIcon id={agent.id} mark={agent.mark} />
            <span className="fg-agent-name">{agent.installed ? agent.label : `Install ${agent.label}`}</span>
          </button>
        })}
      </aside> : null}
    </div>
  </>
}

/** A workspace's saved scripts: add, change, delete, start and stop them. They run in the terminal panel. */
function ScriptsTab({ directory, onError, onRun, onStop }: { readonly directory: string; readonly onError: (reason: unknown) => void; readonly onRun: (script: Script) => void; readonly onStop: (script: Script) => void }) {
  const [scripts, setScripts] = useState<readonly Script[]>([])
  const [editing, setEditing] = useState<{ id?: string; name: string; command: string; type: Script['type'] } | null>(null)
  const load = useCallback(async () => { setScripts(await call<Script[]>({ op: 'scripts', directory })) }, [directory])
  useEffect(() => { void load().catch(onError) }, [load, onError])
  useEffect(() => bridge()?.onForgeState?.((update) => { if (update.directory === directory) void load().catch(() => undefined) }), [directory, load])
  const save = async () => {
    if (!editing) return
    try { await call({ op: 'script-save', directory, ...editing }); setEditing(null); await load() } catch (reason) { onError(reason) }
  }
  const remove = async (script: Script) => {
    if (!window.confirm(`Delete the script ${script.name}?${script.running ? ' It is running and will be stopped.' : ''}`)) return
    try { onStop(script); await call({ op: 'script-delete', directory, id: script.id }); await load() } catch (reason) { onError(reason) }
  }
  return <div className="fg-script-list">
    <div className="fg-row"><button type="button" className="fg-primary" onClick={() => { setEditing({ name: '', command: '', type: 'dev' }) }}>Add script</button></div>
    {editing ? <form className="fg-script-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <input value={editing.name} onChange={(event) => { setEditing({ ...editing, name: event.target.value }) }} placeholder="Name, e.g. Dev server" aria-label="Script name" />
      <input value={editing.command} onChange={(event) => { setEditing({ ...editing, command: event.target.value }) }} placeholder="Command, e.g. npm run dev" aria-label="Command" className="fg-mono" />
      <select value={editing.type} onChange={(event) => { setEditing({ ...editing, type: event.target.value as Script['type'] }) }} aria-label="Type">
        <option value="dev">Dev server (shows in Live previews)</option>
        <option value="check">Check (runs in Review)</option>
        <option value="other">Other</option>
      </select>
      <div className="fg-row"><button type="submit" className="fg-primary" disabled={editing.name.trim() === '' || editing.command.trim() === ''}>Save</button><button type="button" onClick={() => { setEditing(null) }}>Cancel</button></div>
    </form> : null}
    <ul>
      {scripts.map(script => <li key={script.id} className="fg-script" title={script.command}>
        <span className="fg-dot" data-state={script.running ? 'working' : 'idle'} aria-hidden="true" />
        <span className="fg-script-name">{script.name}</span>
        <div className="fg-row">
          {script.running
            ? <><button type="button" onClick={() => { onRun(script) }}>Show</button><button type="button" onClick={() => { onStop(script) }}>Stop</button></>
            : <button type="button" className="fg-primary" onClick={() => { onRun(script) }}>Start</button>}
          <button type="button" onClick={() => { setEditing({ id: script.id, name: script.name, command: script.command, type: script.type }) }}>Edit</button>
          <button type="button" className="fg-danger" onClick={() => { void remove(script) }}>Delete</button>
        </div>
      </li>)}
      {scripts.length === 0 && !editing ? <li className="fg-empty">No scripts yet. Add your dev server, tests or build.</li> : null}
    </ul>
  </div>
}
