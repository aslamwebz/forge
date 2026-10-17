import { useEffect, useState } from 'react'
import { AgentIcon } from './AgentIcon'
import { call, type Agent } from './forgeApi'

interface Session { readonly tool: string; readonly id: string; readonly title: string; readonly updated: number }

function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${String(days)} d ago` : new Date(time).toLocaleDateString()
}

/** The sessions the coding CLIs ran in this workspace, newest first, each to pick up again in a pane. */
export function SessionsPanel({ directory, agents, onResume, onClose }: { readonly directory: string; readonly agents: readonly Agent[]; readonly onResume: (tool: string, id: string, title: string) => void; readonly onClose: () => void }) {
  const [sessions, setSessions] = useState<readonly Session[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tool, setTool] = useState<string>('all')
  useEffect(() => {
    setSessions(null)
    void call<Session[]>({ op: 'sessions', directory }).then(setSessions).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [directory])
  const agent = (id: string) => agents.find(item => item.id === id)
  const tools = [...new Set((sessions ?? []).map(item => item.tool))]
  const shown = (sessions ?? []).filter(item => tool === 'all' || item.tool === tool)
  const antigravity = agent('agy')
  return <aside className="fg-sessions" aria-label="Sessions in this workspace">
    <header className="fg-sessions-head">
      <b>Sessions here</b>
      <button type="button" className="fg-icon-button" aria-label="Close sessions" onClick={onClose}>×</button>
    </header>
    {tools.length > 1 ? <div className="fg-row fg-sessions-filter">
      <button type="button" aria-pressed={tool === 'all'} onClick={() => { setTool('all') }}>All</button>
      {tools.map(id => <button key={id} type="button" aria-pressed={tool === id} onClick={() => { setTool(id) }}>{agent(id)?.label ?? id}</button>)}
    </div> : null}
    {error ? <p className="fg-error">{error}</p> : sessions === null ? <p className="fg-empty">Reading the sessions…</p> : null}
    <ul className="fg-session-list">
      {shown.map(item => {
        const usable = agent(item.tool)?.installed === true && agent(item.tool)?.blocked === null
        return <li key={`${item.tool}:${item.id}`}>
          <button type="button" className="fg-session" disabled={!usable} title={usable ? `Resume in ${agent(item.tool)?.label ?? item.tool}` : agent(item.tool)?.blocked ?? 'Not installed'} onClick={() => { onResume(item.tool, item.id, item.title) }}>
            <AgentIcon id={item.tool} mark={agent(item.tool)?.mark ?? '?'} />
            <span className="fg-session-text"><span className="fg-session-title">{item.title}</span><span className="fg-hint">{agent(item.tool)?.label ?? item.tool} · {ago(item.updated)}</span></span>
          </button>
        </li>
      })}
      {sessions !== null && shown.length === 0 ? <li className="fg-empty">No sessions found for this folder yet.</li> : null}
    </ul>
    {antigravity?.installed ? <button type="button" className="fg-session fg-session-last" onClick={() => { onResume('agy', 'last', 'last conversation') }}>
      <AgentIcon id="agy" mark={antigravity.mark} />
      <span className="fg-session-text"><span className="fg-session-title">Continue Antigravity's last conversation</span><span className="fg-hint">Antigravity keeps no list to choose from</span></span>
    </button> : null}
  </aside>
}
