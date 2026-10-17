import { useCallback, useEffect, useState } from 'react'
import { bridge, call, type RunningItem, type Script } from './forgeApi'

type Width = 'full' | 'tablet' | 'phone'
const WIDTHS: readonly { readonly id: Width; readonly label: string; readonly px?: number }[] = [
  { id: 'full', label: 'Full' }, { id: 'tablet', label: 'Tablet', px: 820 }, { id: 'phone', label: 'Phone', px: 390 },
]
const isLocal = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) } catch { return false }
}

/**
 * Live previews: each dev server running in this workspace, at the address it printed. He can go to
 * another page of it, reload, see it at tablet or phone width, or open it in his browser. Dev
 * scripts not running yet can be started from here.
 */
export function PreviewsTab({ directory, items, chosen, onChoose, onRun, onError }: {
  readonly directory: string
  readonly items: readonly RunningItem[]
  readonly chosen: string | null
  readonly onChoose: (key: string) => void
  readonly onRun: (script: Script) => void
  readonly onError: (reason: unknown) => void
}) {
  const previews = items.filter(item => item.url)
  const active = previews.find(item => item.key === chosen) ?? previews[0] ?? null
  const [address, setAddress] = useState('')
  const [shown, setShown] = useState('')
  const [reload, setReload] = useState(0)
  const [width, setWidth] = useState<Width>('full')
  const [waiting, setWaiting] = useState<readonly Script[]>([])
  const loadScripts = useCallback(async () => {
    const scripts = await call<Script[]>({ op: 'scripts', directory })
    setWaiting(scripts.filter(script => script.type === 'dev'))
  }, [directory])
  useEffect(() => { void loadScripts().catch(onError) }, [loadScripts, onError])
  useEffect(() => bridge()?.onForgeState?.((update) => { if (update.directory === directory) void loadScripts().catch(() => undefined) }), [directory, loadScripts])
  // A new preview starts at the address its server printed.
  useEffect(() => { setAddress(active?.url ?? ''); setShown(active?.url ?? '') }, [active?.key, active?.url])

  const go = () => {
    if (isLocal(address)) { setShown(address); setReload(n => n + 1) } else onError(new Error('Previews show local addresses only (localhost or 127.0.0.1).'))
  }
  const notRunning = waiting.filter(script => !items.some(item => item.key === script.id))
  const starting = waiting.filter(script => items.some(item => item.key === script.id && !item.url))
  const px = WIDTHS.find(item => item.id === width)?.px

  if (!active) {
    return <div className="fg-previews-empty">
      <p className="fg-empty">{starting.length > 0 ? `Waiting for ${starting.map(script => script.name).join(', ')} to say its address…` : 'No dev server is running here.'}</p>
      {notRunning.length > 0 ? <ul className="fg-script-list-plain">
        {notRunning.map(script => <li key={script.id}><span>{script.name}</span><button type="button" className="fg-primary" onClick={() => { onRun(script) }}>Start</button></li>)}
      </ul> : starting.length === 0 ? <p className="fg-empty">Add a script of type “Dev server” in Scripts, or run one in a terminal: its local address shows here.</p> : null}
    </div>
  }
  return <div className="fg-previews">
    <div className="fg-preview-bar">
      {previews.length > 1 ? <div className="fg-row">{previews.map(item => <button key={item.key} type="button" aria-pressed={item.key === active.key} onClick={() => { onChoose(item.key) }}>{item.title}</button>)}</div> : <span className="fg-preview-name">{active.title}</span>}
      <form className="fg-address" onSubmit={(event) => { event.preventDefault(); go() }}>
        <input value={address} onChange={(event) => { setAddress(event.target.value) }} aria-label="Address" spellCheck={false} />
      </form>
      <button type="button" title="Reload" aria-label="Reload" onClick={() => { setReload(n => n + 1) }}>↻</button>
      <div className="fg-row" role="group" aria-label="Width">
        {WIDTHS.map(item => <button key={item.id} type="button" aria-pressed={width === item.id} onClick={() => { setWidth(item.id) }}>{item.label}</button>)}
      </div>
      <button type="button" title="Open in your browser" onClick={() => { void call({ op: 'open-external', url: shown }).catch(onError) }}>Open ↗</button>
    </div>
    <div className="fg-preview-stage">
      <iframe key={`${shown}#${String(reload)}`} src={shown} title={`Preview of ${active.title}`} style={px ? { width: `${String(px)}px` } : undefined} />
    </div>
  </div>
}
