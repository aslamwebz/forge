import { Fragment, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

export type Layout = 'columns' | 'rows' | 'grid' | 'lead'
export type SubLayout = 'rows' | 'columns' | 'grid'
const LAYOUT_KEY = 'freya.forge.layout'
const SUB_KEY = 'freya.forge.subLayout'

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => { const saved = localStorage.getItem(key); return allowed.includes(saved as T) ? saved as T : fallback })
  return [value, (next) => { localStorage.setItem(key, next); setValue(next) }]
}
/** The Harness layout he chose, kept between visits. */
export function useLayout(): [Layout, (layout: Layout) => void] { return remembered<Layout>(LAYOUT_KEY, ['columns', 'rows', 'grid', 'lead'], 'columns') }
/** How the other agents sit beside the lead. */
export function useSubLayout(): [SubLayout, (layout: SubLayout) => void] { return remembered<SubLayout>(SUB_KEY, ['rows', 'columns', 'grid'], 'rows') }

/**
 * The Harness panes laid out as he likes: side by side, stacked, a grid, or the lead on one half
 * with the others arranged on the other half. Dividers are dragged to give one more room; one pane
 * is zoomed to fill the space (the others keep running, hidden); a pane dragged by its header onto
 * another swaps them.
 */
export function PaneGrid({ keys, layout, subLayout, lead, zoomed, render, onSwap }: {
  readonly keys: readonly string[]
  readonly layout: Layout
  readonly subLayout: SubLayout
  /** The lead's pane, for the lead layout (the first pane when none leads). */
  readonly lead: string | null
  readonly zoomed: string | null
  readonly render: (key: string, drag: { readonly onDragStart: (event: DragEvent) => void }) => ReactNode
  readonly onSwap: (from: string, to: string) => void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [sizes, setSizes] = useState<number[]>(() => keys.map(() => 1))
  const [half, setHalf] = useState(0.5)
  const [over, setOver] = useState<string | null>(null)
  // A pane more or fewer: every pane an equal share again.
  useEffect(() => { setSizes(keys.map(() => 1)) }, [keys.length, layout])

  /** Drag along an axis; the callback gets how far it moved as a share of the box. */
  const dragging = (across: boolean, onMove: (share: number) => void) => (event: ReactPointerEvent) => {
    const element = box.current
    if (!element) return
    event.preventDefault()
    const length = across ? element.clientWidth : element.clientHeight
    const start = across ? event.clientX : event.clientY
    const move = (moved: PointerEvent) => { onMove(((across ? moved.clientX : moved.clientY) - start) / length) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const cell = (key: string) => <div key={key} className="fg-cell" hidden={zoomed !== null && zoomed !== key} data-over={over === key || undefined}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-forge-pane')) { event.preventDefault(); setOver(key) } }}
    onDragLeave={() => { setOver(current => current === key ? null : current) }}
    onDrop={(event) => { event.preventDefault(); setOver(null); const from = event.dataTransfer.getData('application/x-forge-pane'); if (from && from !== key) onSwap(from, key) }}>
    {render(key, { onDragStart: (event) => { event.dataTransfer.setData('application/x-forge-pane', key); event.dataTransfer.effectAllowed = 'move' } })}
  </div>

  // The lead on one half, the others on the other half in their own layout.
  if (layout === 'lead' && !zoomed && keys.length > 1) {
    const leadKey = lead && keys.includes(lead) ? lead : keys[0]!
    const rest = keys.filter(key => key !== leadKey)
    const columns = Math.ceil(Math.sqrt(rest.length))
    const sub = subLayout === 'grid' ? { gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }
      : subLayout === 'columns' ? { gridTemplateColumns: `repeat(${String(rest.length)}, minmax(0, 1fr))`, gridTemplateRows: 'minmax(0, 1fr)' }
        : { gridTemplateRows: `repeat(${String(rest.length)}, minmax(0, 1fr))`, gridTemplateColumns: 'minmax(0, 1fr)' }
    const start = half
    return <div className="fg-panes" ref={box} data-layout="lead" style={{ gridTemplateColumns: `minmax(0, ${String(half)}fr) 5px minmax(0, ${String(1 - half)}fr)`, gridTemplateRows: 'minmax(0, 1fr)' }}>
      {cell(leadKey)}
      <div className="fg-gutter" data-axis="x" role="separator" aria-orientation="vertical" aria-label="Drag to resize" onDoubleClick={() => { setHalf(0.5) }}
        onPointerDown={dragging(true, (share) => { setHalf(Math.min(0.85, Math.max(0.15, start + share))) })} />
      <div className="fg-subgrid" style={sub}>{rest.map(cell)}</div>
    </div>
  }

  const split = layout !== 'grid' && layout !== 'lead' && !zoomed && keys.length > 1
  const across = layout === 'columns' || layout === 'lead'
  const columns = Math.ceil(Math.sqrt(keys.length))
  const template = split ? sizes.map(size => `minmax(0, ${String(size)}fr)`).join(' 5px ') : layout === 'grid' && !zoomed ? `repeat(${String(columns)}, minmax(0, 1fr))` : 'minmax(0, 1fr)'
  const style = split
    ? (across ? { gridTemplateColumns: template, gridTemplateRows: 'minmax(0, 1fr)' } : { gridTemplateRows: template, gridTemplateColumns: 'minmax(0, 1fr)' })
    : layout === 'grid' && !zoomed ? { gridTemplateColumns: template, gridAutoRows: 'minmax(0, 1fr)' } : { gridTemplateColumns: template, gridTemplateRows: 'minmax(0, 1fr)' }
  const resize = (index: number) => {
    const before = [...sizes]
    const total = before.reduce((sum, size) => sum + size, 0)
    return dragging(across, (share) => {
      const delta = share * total
      const a = before[index]! + delta
      const b = before[index + 1]! - delta
      if (a < total * 0.08 || b < total * 0.08) return
      setSizes(before.map((size, i) => i === index ? a : i === index + 1 ? b : size))
    })
  }
  return <div className="fg-panes" ref={box} data-layout={layout} style={style}>
    {keys.map((key, index) => <Fragment key={key}>
      {cell(key)}
      {split && index < keys.length - 1 ? <div className="fg-gutter" data-axis={across ? 'x' : 'y'} role="separator" aria-orientation={across ? 'vertical' : 'horizontal'} aria-label="Drag to resize" onPointerDown={resize(index)} onDoubleClick={() => { setSizes(keys.map(() => 1)) }} /> : null}
    </Fragment>)}
  </div>
}
