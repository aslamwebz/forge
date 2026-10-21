import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { bridge, call, STATUS_LABEL, type AgentStatus, type PaneSpec } from './forgeApi'
import { fontOf, onTerminalLook, setTerminalLook, terminalLook, themeOf } from './terminalLook'

/** Panes already started once: showing one of them again only attaches to it. */
const started = new WeakSet<PaneSpec>()
export function markStarted(pane: PaneSpec): void { started.add(pane) }

/** One real terminal. Leaving the Forge, or hiding it, leaves what runs in it running. */
export function TerminalPane({ directory, pane, title, status, flash = false, zoomed, onZoom, onDragStart, onMakeLead, onError, onClose, onEnded, bare = false }: {
  readonly directory: string; readonly pane: PaneSpec; readonly title: string; readonly status?: AgentStatus; readonly flash?: boolean
  /** In the Harness: whether this pane fills the space, and how he toggles that. */
  readonly zoomed?: boolean; readonly onZoom?: () => void
  /** In the Harness: dragging the header moves the pane. */
  readonly onDragStart?: (event: DragEvent) => void
  /** A Claude pane can become its workspace's lead. */
  readonly onMakeLead?: () => void
  readonly onError: (reason: unknown) => void; readonly onClose: () => void; readonly onEnded: () => void; readonly bare?: boolean
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<'starting' | 'running' | 'ended'>('starting')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const finder = useRef<SearchAddon | null>(null)
  const terminal = useRef<Terminal | null>(null)
  const [background, setBackground] = useState(() => themeOf(terminalLook()).background)
  // The callbacks may change on every render; the terminal is set up again only for another pane.
  const callbacks = useRef({ onError, onEnded })
  callbacks.current = { onError, onEnded }
  useEffect(() => {
    const host = bridge()
    const element = box.current
    if (!host?.forge || !element) return
    const look = terminalLook()
    const term = new Terminal({
      // The CLIs draw their own cursor; a blinking one of ours on top flickers.
      cursorBlink: false,
      fontFamily: fontOf(look),
      fontSize: look.fontSize,
      scrollback: 10_000,
      theme: themeOf(look),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
    finder.current = search
    terminal.current = term
    // Links in the output open in his browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => { void call({ op: 'open-link', url: uri }).catch(() => undefined) }))
    term.open(element)
    // Drawn on the graphics card when it can; the plain renderer when it cannot.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => { webgl.dispose() })
      term.loadAddon(webgl)
    } catch { /* the plain renderer stays */ }
    // Ctrl+C copies when something is selected (otherwise it interrupts, as in any terminal); Ctrl+V pastes; Ctrl+F finds.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey) return true
      const key = event.key.toLowerCase()
      if (key === 'c' && term.hasSelection()) { void navigator.clipboard.writeText(term.getSelection()).catch(() => undefined); term.clearSelection(); return false }
      if (key === 'v') return false
      // The Forge's own: the command bar.
      if (key === 'k' && !event.shiftKey && !event.altKey) return false
      if (key === 'f') { event.preventDefault(); setSearching(true); return false }
      // Text size for every terminal, as in an editor.
      if (key === '=' || key === '+') { event.preventDefault(); setTerminalLook({ fontSize: terminalLook().fontSize + 1 }); return false }
      if (key === '-') { event.preventDefault(); setTerminalLook({ fontSize: terminalLook().fontSize - 1 }); return false }
      if (key === '0') { event.preventDefault(); setTerminalLook({ fontSize: 14 }); return false }
      return true
    })
    fit.fit()
    let id: string | null = null
    let live = true
    const off = host.onForgeTerminal?.((update) => {
      if (update.id !== id) return
      if (update.data !== undefined) term.write(update.data)
      if (update.exit !== undefined) { setState('ended'); term.write(`\r\n[Ended (code ${String(update.exit)}).]\r\n`); callbacks.current.onEnded() }
    })
    const attach = started.has(pane)
    started.add(pane)
    void call<{ id: string | null; replay: string }>({ op: 'pane-open', directory, key: pane.key, kind: pane.kind, cols: term.cols, rows: term.rows, attach, ...(pane.resume ? { resume: pane.resume, title } : {}), ...(pane.lead ? { lead: true } : {}), ...(pane.worktree ? { worktree: pane.worktree } : {}) }).then((opened) => {
      if (!live) return
      if (opened.id === null) { setState('ended'); term.write('[Ended.]\r\n'); return }
      id = opened.id
      if (opened.replay) term.write(opened.replay)
      // Typed for him: an install waits for his Enter; a new project's starter ends with one.
      else if (pane.typeFirst) setTimeout(() => { if (id) void call({ op: 'pane-input', id, data: pane.typeFirst }).catch(() => undefined) }, 900)
      setState('running')
      term.focus()
    }).catch((reason: unknown) => { setState('ended'); callbacks.current.onError(reason) })
    const typing = term.onData((data) => { if (id) void call({ op: 'pane-input', id, data }).catch(() => undefined) })
    // Only a real change of size reaches the terminal: each one makes it redraw its whole screen.
    let sent = ''
    const observer = new ResizeObserver(() => {
      fit.fit()
      const size = `${String(term.cols)}x${String(term.rows)}`
      if (!id || size === sent) return
      sent = size
      void call({ op: 'pane-resize', id, cols: term.cols, rows: term.rows }).catch(() => undefined)
    })
    observer.observe(element)
    // A new theme, font or size: this terminal follows, and the program in it gets its new size.
    const restyle = onTerminalLook(() => {
      const next = terminalLook()
      term.options.theme = themeOf(next)
      term.options.fontFamily = fontOf(next)
      term.options.fontSize = next.fontSize
      setBackground(themeOf(next).background)
      fit.fit()
      if (id) { sent = `${String(term.cols)}x${String(term.rows)}`; void call({ op: 'pane-resize', id, cols: term.cols, rows: term.rows }).catch(() => undefined) }
    })
    return () => { live = false; restyle(); observer.disconnect(); typing.dispose(); off?.(); finder.current = null; terminal.current = null; term.dispose() }
  }, [directory, pane])
  const branch = (pane as { readonly branch?: string }).branch ?? (pane.worktree ? `forge/${pane.worktree}` : null)
  return <div className="fg-pane" data-status={state === 'running' ? status : undefined} data-flash={flash || undefined} style={{ background }}>
    {bare ? null : <header className="fg-pane-head" draggable={onDragStart ? true : undefined} onDragStart={onDragStart} onDoubleClick={onZoom} title={onZoom ? 'Drag to move · double-click to zoom' : undefined}>
      {pane.lead ? <span className="fg-lead-chip" title="Leads the other agents here, through the security core">♛ Lead</span> : null}
      <span className="fg-pane-title">{title}</span>
      {branch ? <span className="fg-branch-chip" title="Works in its own git worktree, on this branch">⑂ {branch}</span> : null}
      <span className="fg-status">{state === 'starting' ? 'Starting…' : state === 'ended' ? 'Ended' : status ? <span className="fg-status-chip" data-state={status}>{STATUS_LABEL[status]}</span> : ''}</span>
      {onMakeLead && !pane.lead ? <button type="button" className="fg-pane-close" aria-label={`Make ${title} the lead`} title="Make it the lead: it restarts in the same conversation with tools to command the other agents" onClick={onMakeLead}>♛</button> : null}
      {onZoom ? <button type="button" className="fg-pane-close" aria-label={zoomed ? `Show all panes` : `Zoom ${title}`} title={zoomed ? 'Show all panes' : 'Zoom'} onClick={onZoom}>{zoomed ? '⤡' : '⤢'}</button> : null}
      <button type="button" className="fg-pane-close" aria-label={`Close ${title}`} title="Close (stops what runs in it)" onClick={onClose}>×</button>
    </header>}
    {searching ? <form className="fg-find" role="search" onSubmit={(event) => { event.preventDefault(); finder.current?.findNext(query) }}>
      <input value={query} autoFocus placeholder="Find in this terminal" aria-label="Find in this terminal" onChange={(event) => { setQuery(event.target.value); finder.current?.findNext(event.target.value, { incremental: true }) }}
        onKeyDown={(event) => { if (event.key === 'Escape') { setSearching(false); finder.current?.clearDecorations(); terminal.current?.focus() } else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); finder.current?.findPrevious(query) } }} />
      <button type="button" aria-label="Previous match" onClick={() => { finder.current?.findPrevious(query) }}>↑</button>
      <button type="submit" aria-label="Next match">↓</button>
      <button type="button" aria-label="Close find" onClick={() => { setSearching(false); finder.current?.clearDecorations(); terminal.current?.focus() }}>×</button>
    </form> : null}
    <div className="fg-term" ref={box} />
  </div>
}
