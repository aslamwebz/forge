import { useEffect, useRef, useState } from 'react'
import { ACCENTS, setAppearance, useAppearance } from './appearance'
import { FONTS, MAX_SIZE, MIN_SIZE, onTerminalLook, setTerminalLook, terminalLook, THEMES } from './terminalLook'

/** The "Aa" menu: the Forge's look (solid or glass, its accent) and the terminals' theme, font and size. */
export function LookMenu() {
  const [open, setOpen] = useState(false)
  const [look, setLook] = useState(terminalLook)
  const app = useAppearance()
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => onTerminalLook(() => { setLook(terminalLook()) }), [])
  // A click elsewhere closes it.
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', away)
    return () => { window.removeEventListener('mousedown', away) }
  }, [open])
  return <div className="fg-look" ref={box}>
    <button type="button" className="fg-look-button" aria-label="Look" aria-expanded={open} title="The Forge's look, and the terminals' theme, font and size" onClick={() => { setOpen(value => !value) }}>Aa</button>
    {open ? <div className="fg-look-menu" role="dialog" aria-label="Look">
      <span className="fg-label">Forge</span>
      <div className="fg-row fg-look-style" role="radiogroup" aria-label="Style">
        {(['solid', 'glass'] as const).map(style => <button key={style} type="button" role="radio" aria-checked={app.style === style} onClick={() => { setAppearance({ style }) }}>{style === 'solid' ? 'Solid' : 'Glass'}</button>)}
      </div>
      <div className="fg-row fg-look-accents" role="radiogroup" aria-label="Accent">
        {ACCENTS.map(item => <button key={item.id} type="button" role="radio" aria-checked={app.accent === item.id} aria-label={item.label} title={item.label} onClick={() => { setAppearance({ accent: item.id }) }}>
          <i style={{ background: item.color ?? 'conic-gradient(#e8a54b, #5fa8ff, #4fd1a5, #f0719b, #e8a54b)' }} />
        </button>)}
      </div>
      <span className="fg-label">Terminal theme</span>
      <div className="fg-look-themes" role="radiogroup" aria-label="Theme">
        {Object.entries(THEMES).map(([id, item]) => <button key={id} type="button" role="radio" aria-checked={look.theme === id} onClick={() => { setTerminalLook({ theme: id }) }}>
          <span className="fg-swatch" style={{ background: item.theme.background, color: item.theme.foreground }}>
            {[item.theme.red, item.theme.green, item.theme.yellow, item.theme.blue].map(color => <i key={color} style={{ background: color }} />)}
          </span>
          {item.label}
        </button>)}
      </div>
      <span className="fg-label">Size</span>
      <div className="fg-row fg-look-size">
        <button type="button" aria-label="Smaller" disabled={look.fontSize <= MIN_SIZE} onClick={() => { setTerminalLook({ fontSize: look.fontSize - 1 }) }}>A−</button>
        <span>{look.fontSize}px</span>
        <button type="button" aria-label="Larger" disabled={look.fontSize >= MAX_SIZE} onClick={() => { setTerminalLook({ fontSize: look.fontSize + 1 }) }}>A+</button>
        <span className="fg-hint">Ctrl + = / − / 0 in a terminal</span>
      </div>
      <span className="fg-label">Font</span>
      <select value={look.font} aria-label="Font" onChange={(event) => { setTerminalLook({ font: event.target.value }) }}>
        {FONTS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </div> : null}
  </div>
}
