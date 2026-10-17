import { useCallback, useEffect, useState } from 'react'
import { bridge, call, type Agent, type RunningItem } from './forgeApi'

type Range = 'uncommitted' | 'last-commit' | 'branch' | 'project'
interface Step { readonly id: string; readonly kind: 'check' | 'auditor' | 'verifier'; readonly name: string; readonly state: string; readonly output: string; readonly note?: string }
interface Finding {
  readonly id: string; readonly auditor: string; readonly severity: 'high' | 'medium' | 'low'; readonly file: string; readonly line?: number
  readonly title: string; readonly detail: string; readonly fix?: string; readonly verdict: 'confirmed' | 'rejected' | 'unverified'; readonly reason?: string
  readonly status: 'open' | 'dismissed' | 'false-positive' | 'sent'
}
interface Review {
  readonly intent: string; readonly range: Range; readonly runner: string; readonly auditors: readonly string[]
  readonly scenarios: readonly { readonly id: string; readonly text: string }[]
  readonly runners: readonly string[]
  readonly lenses: readonly { readonly id: string; readonly name: string; readonly optional: boolean }[]
  readonly run?: { readonly at: string; readonly state: 'running' | 'done' | 'stopped'; readonly steps: readonly Step[]; readonly findings: readonly Finding[] }
}

const RANGES: readonly { readonly id: Range; readonly label: string }[] = [
  { id: 'uncommitted', label: 'Uncommitted changes' }, { id: 'last-commit', label: 'Last commit' }, { id: 'branch', label: 'This branch against main' }, { id: 'project', label: 'Whole project' },
]
const ORDER = { confirmed: 0, unverified: 1, rejected: 2 } as const
const SEVERITY = { high: 0, medium: 1, low: 2 } as const

/**
 * Review: what he runs, when he chooses. Checks first, then auditors that only read, each through
 * one lens, then a verifier. Findings come back for him to send to a builder, dismiss, or mark false.
 */
export function ReviewTab({ directory, agents, builders, onError }: { readonly directory: string; readonly agents: readonly Agent[]; readonly builders: readonly RunningItem[]; readonly onError: (reason: unknown) => void }) {
  const [review, setReview] = useState<Review | null>(null)
  const [intent, setIntent] = useState('')
  const [scenario, setScenario] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const load = useCallback(async () => {
    const value = await call<Review>({ op: 'review', directory })
    setReview(value)
    return value
  }, [directory])
  useEffect(() => { void load().then((value) => { setIntent(value.intent) }).catch(onError) }, [load, onError])
  useEffect(() => bridge()?.onForgeState?.((update) => { if (update.directory === directory) void load().catch(() => undefined) }), [directory, load])
  useEffect(() => { if (!builders.some(item => item.key === target)) setTarget(builders[0]?.key ?? '') }, [builders, target])

  const save = async (change: Record<string, unknown>) => {
    try { await call({ op: 'review-save', directory, ...change }); await load() } catch (reason) { onError(reason) }
  }
  const act = async (request: Record<string, unknown>) => {
    try { await call({ directory, ...request }); await load() } catch (reason) { onError(reason) }
  }
  if (!review) return <p className="fg-empty fg-idle">Loading…</p>
  const running = review.run?.state === 'running'
  const label = (id: string) => agents.find(agent => agent.id === id)?.label ?? id
  const usable = (id: string) => { const agent = agents.find(item => item.id === id); return agent ? agent.installed && agent.blocked === null : false }
  const findings = [...(review.run?.findings ?? [])].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || ORDER[a.verdict] - ORDER[b.verdict] || SEVERITY[a.severity] - SEVERITY[b.severity])
  const lensName = (id: string) => review.lenses.find(item => item.id === id)?.name ?? id

  return <div className="fg-review">
    <aside className="fg-review-setup" aria-label="Review setup">
      <label className="fg-field"><span>What to review</span>
        <select value={review.range} disabled={running} onChange={(event) => { void save({ range: event.target.value }) }}>
          {RANGES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="fg-field"><span>What the change should do</span>
        <textarea value={intent} rows={4} placeholder="In your words: what you asked for. The Intent auditor checks the change against it." onChange={(event) => { setIntent(event.target.value) }} onBlur={() => { if (intent !== review.intent) void save({ intent }) }} />
      </label>
      <div className="fg-field"><span>Holdout scenarios</span>
        <p className="fg-hint">Kept in the app's data, never in the project, so builders never see them. Intent and Test integrity check each.</p>
        <ul className="fg-scenarios">
          {review.scenarios.map(item => <li key={item.id}><span>{item.text}</span>
            <button type="button" className="fg-icon-button" aria-label="Remove scenario" onClick={() => { void save({ scenarios: review.scenarios.filter(other => other.id !== item.id) }) }}>×</button></li>)}
        </ul>
        <form className="fg-row fg-scenario-add" onSubmit={(event) => { event.preventDefault(); if (scenario.trim()) { void save({ scenarios: [...review.scenarios, { text: scenario }] }); setScenario('') } }}>
          <input value={scenario} onChange={(event) => { setScenario(event.target.value) }} placeholder="Given … when … then …" aria-label="New scenario" />
          <button type="submit" disabled={!scenario.trim()}>Add</button>
        </form>
      </div>
      <div className="fg-field"><span>Auditors</span>
        <div className="fg-lenses">
          {review.lenses.map(lens => <label key={lens.id} className="fg-check">
            <input type="checkbox" disabled={running} checked={review.auditors.includes(lens.id)} onChange={(event) => { void save({ auditors: event.target.checked ? [...review.auditors, lens.id] : review.auditors.filter(id => id !== lens.id) }) }} />
            {lens.name}{lens.optional ? <small> optional</small> : null}
          </label>)}
        </div>
      </div>
      <label className="fg-field"><span>Audit with</span>
        <select value={review.runner} disabled={running} onChange={(event) => { void save({ runner: event.target.value }) }}>
          {review.runners.map(id => <option key={id} value={id} disabled={!usable(id)}>{label(id)}{usable(id) ? '' : ' (not available)'}</option>)}
        </select>
        <small className="fg-hint">Best a different model than the one that built the change.</small>
      </label>
      <div className="fg-row">
        {running
          ? <button type="button" className="fg-danger" onClick={() => { void act({ op: 'review-stop' }) }}>Stop</button>
          : <><button type="button" className="fg-primary" onClick={() => { void act({ op: 'review-run' }) }}>Run review</button>
            <button type="button" onClick={() => { void act({ op: 'review-run', checksOnly: true }) }}>Run checks only</button></>}
      </div>
    </aside>

    <section className="fg-review-results" aria-label="Review results">
      {!review.run ? <p className="fg-empty">No review yet. Checks run first (your scripts of type “Check”), then the auditors, then a verifier.</p> : <>
        <header className="fg-review-head">
          <b>{running ? 'Reviewing…' : review.run.state === 'stopped' ? 'Stopped' : 'Last review'}</b>
          <span className="fg-hint">{new Date(review.run.at).toLocaleString()}</span>
        </header>
        <ul className="fg-steps">
          {review.run.steps.map(step => <li key={step.id} className="fg-step" data-state={step.state}>
            <button type="button" className="fg-step-head" aria-expanded={open === step.id} onClick={() => { setOpen(open === step.id ? null : step.id) }}>
              <span className="fg-step-state">{step.state}</span>
              <span className="fg-step-kind">{step.kind}</span>
              <span className="fg-step-name">{step.name}</span>
              {step.note ? <span className="fg-hint">{step.note}</span> : null}
            </button>
            {open === step.id ? <pre className="fg-step-output">{step.output.trim() || 'No output yet.'}</pre> : null}
          </li>)}
        </ul>
        {findings.length > 0 ? <>
          <h3 className="fg-label">Findings</h3>
          {builders.length > 0 ? <label className="fg-row fg-send-to"><span className="fg-hint">Send to</span>
            <select value={target} onChange={(event) => { setTarget(event.target.value) }}>{builders.map(item => <option key={item.key} value={item.key}>{item.title}</option>)}</select>
          </label> : <p className="fg-hint">Start an agent in the Harness to send findings to it.</p>}
          <ul className="fg-findings">
            {findings.map(item => <li key={item.id} className="fg-finding" data-status={item.status} data-verdict={item.verdict}>
              <div className="fg-row fg-finding-tags">
                <span className="fg-chip" data-severity={item.severity}>{item.severity}</span>
                <span className="fg-chip">{lensName(item.auditor)}</span>
                <span className="fg-chip" data-verdict={item.verdict}>{item.verdict}</span>
                {item.status !== 'open' ? <span className="fg-chip">{item.status}</span> : null}
              </div>
              <b className="fg-finding-title">{item.title}</b>
              <code className="fg-finding-file">{item.file}{item.line ? `:${String(item.line)}` : ''}</code>
              <p>{item.detail}</p>
              {item.fix ? <p className="fg-hint">Fix: {item.fix}</p> : null}
              {item.reason ? <p className="fg-hint">Verifier: {item.reason}</p> : null}
              <div className="fg-row">
                {item.status === 'open' ? <>
                  <button type="button" className="fg-primary" disabled={!target} onClick={() => { void act({ op: 'review-send', id: item.id, key: target }) }}>Send</button>
                  <button type="button" onClick={() => { void act({ op: 'review-finding', id: item.id, status: 'dismissed' }) }}>Dismiss</button>
                  <button type="button" onClick={() => { void act({ op: 'review-finding', id: item.id, status: 'false-positive' }) }}>False positive</button>
                </> : <button type="button" onClick={() => { void act({ op: 'review-finding', id: item.id, status: 'open' }) }}>Reopen</button>}
              </div>
            </li>)}
          </ul>
        </> : null}
      </>}
    </section>
  </div>
}
