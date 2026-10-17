import { useEffect, useState } from 'react'
import { call, type Workspace } from './forgeApi'

interface Template { readonly id: string; readonly name: string; readonly description: string; readonly command: string }
const LOCATION_KEY = 'freya.forge.location'

/**
 * A new project: a name, where it goes, and a template. The template's own starter then runs in the
 * new workspace's terminal, where he sees and answers it. An existing folder can be opened instead.
 */
export function NewProject({ onCreated, onOpenFolder }: { readonly onCreated: (workspace: Workspace, command: string) => void; readonly onOpenFolder: () => void }) {
  const [templates, setTemplates] = useState<readonly Template[]>([])
  const [location, setLocation] = useState(() => localStorage.getItem(LOCATION_KEY) ?? '')
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('empty')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void call<{ templates: Template[]; location: string }>({ op: 'templates' }).then((value) => {
      setTemplates(value.templates)
      setLocation(saved => saved || value.location)
    }).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [])
  const chooseLocation = async () => {
    const picked = await call<string | null>({ op: 'pick-location' }).catch(() => null)
    if (picked) { setLocation(picked); localStorage.setItem(LOCATION_KEY, picked) }
  }
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await call<{ workspace: Omit<Workspace, 'running' | 'items'>; command: string }>({ op: 'create-project', location, name, template })
      onCreated({ ...made.workspace, running: 0, items: [] }, made.command)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  const chosen = templates.find(item => item.id === template)
  return <form className="fg-new" onSubmit={(event) => { event.preventDefault(); void create() }}>
    <header className="fg-new-head">
      <h2>New project</h2>
      <button type="button" onClick={onOpenFolder}>Open an existing folder</button>
    </header>
    <label className="fg-field"><span>Name</span>
      <input value={name} onChange={(event) => { setName(event.target.value) }} placeholder="my-app" autoFocus aria-label="Project name" />
    </label>
    <div className="fg-field"><span>Location</span>
      <div className="fg-row fg-location"><code title={location}>{location}{name.trim() ? `\\${name.trim()}` : ''}</code><button type="button" onClick={() => { void chooseLocation() }}>Change</button></div>
    </div>
    <div className="fg-field"><span>Template</span>
      <div className="fg-templates" role="radiogroup" aria-label="Template">
        {templates.map(item => <button key={item.id} type="button" role="radio" aria-checked={item.id === template} className="fg-template" onClick={() => { setTemplate(item.id) }}>
          <b>{item.name}</b><span>{item.description}</span>
        </button>)}
      </div>
    </div>
    {chosen ? <p className="fg-hint">Runs <code>{chosen.command}</code> in the new folder's terminal.</p> : null}
    {error ? <p className="fg-error" role="alert">{error}</p> : null}
    <div className="fg-row"><button type="submit" className="fg-primary" disabled={busy || name.trim() === ''}>{busy ? 'Creating…' : 'Create project'}</button></div>
  </form>
}
