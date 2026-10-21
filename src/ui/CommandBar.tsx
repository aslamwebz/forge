import { useEffect, useMemo, useRef, useState } from 'react'

/** One thing the command bar can do. */
export interface Command {
  readonly id: string
  readonly label: string
  readonly group: string
  /** Its keyboard shortcut, shown beside it. */
  readonly keys?: string
  readonly run: () => void
}

/** How well a query matches a label: its letters in order, closer together and earlier scoring higher; null when they are not all there. */
function score(query: string, label: string): number | null {
  const q = query.toLowerCase()
  const text = label.toLowerCase()
  if (!q) return 0
  const at = text.indexOf(q)
  if (at >= 0) return 1_000 - at
  let index = -1
  let gaps = 0
  for (const letter of q) {
    const found = text.indexOf(letter, index + 1)
    if (found < 0) return null
    gaps += found - index - 1
    index = found
  }
  return 500 - gaps
}

/** Ctrl+K: everything the Forge can do, found by typing a few letters of it. */
export function CommandBar({ commands, onClose }: { readonly commands: readonly Command[]; readonly onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const found = useMemo(() => commands
    .map(command => ({ command, rank: score(query, `${command.group} ${command.label}`) ?? score(query, command.label) }))
    .filter((item): item is { command: Command; rank: number } => item.rank !== null)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 50)
    .map(item => item.command), [commands, query])
  useEffect(() => { setChosen(0) }, [query])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [chosen])
  const run = (command: Command | undefined) => {
    if (!command) return
    onClose()
    command.run()
  }
  return <div className="fg-command-backdrop" onMouseDown={onClose}>
    <div className="fg-command" role="dialog" aria-label="Commands" onMouseDown={(event) => { event.stopPropagation() }}>
      <input autoFocus value={query} placeholder="Type a command, an agent or a workspace" aria-label="Command" role="combobox" aria-expanded="true" aria-controls="fg-command-list"
        onChange={(event) => { setQuery(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setChosen(index => Math.min(found.length - 1, index + 1)) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setChosen(index => Math.max(0, index - 1)) }
          else if (event.key === 'Enter') { event.preventDefault(); run(found[chosen]) }
        }} />
      <ul id="fg-command-list" ref={list} role="listbox">
        {found.length === 0 ? <li className="fg-command-none">Nothing matches.</li> : found.map((command, index) => <li key={command.id} role="option" aria-selected={index === chosen}
          onMouseMove={() => { setChosen(index) }} onClick={() => { run(command) }}>
          <span className="fg-command-group">{command.group}</span>
          <span className="fg-command-label">{command.label}</span>
          {command.keys ? <kbd>{command.keys}</kbd> : null}
        </li>)}
      </ul>
    </div>
  </div>
}
