import { useEffect, useState } from 'react'

/**
 * How the Forge itself looks: solid or glass, and its accent colour. One choice, kept between
 * visits, changed live. Inside another app the Forge takes that app's colours unless he picks an
 * accent here.
 */

export type Style = 'solid' | 'glass'
export interface Appearance { readonly style: Style; readonly accent: string }

export const ACCENTS: readonly { readonly id: string; readonly label: string; readonly color: string | null }[] = [
  { id: 'app', label: 'The app’s own', color: null },
  { id: 'honey', label: 'Honey', color: '#e8a54b' },
  { id: 'sky', label: 'Sky', color: '#5fa8ff' },
  { id: 'mint', label: 'Mint', color: '#4fd1a5' },
  { id: 'rose', label: 'Rose', color: '#f0719b' },
  { id: 'violet', label: 'Violet', color: '#a98bff' },
]

const KEY = 'freya.forge.appearance'
const EVENT = 'freya:forge:appearance'
const DEFAULT: Appearance = { style: 'solid', accent: 'app' }

export function appearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>
    return {
      style: saved.style === 'glass' ? 'glass' : 'solid',
      accent: ACCENTS.some(item => item.id === saved.accent) ? saved.accent! : DEFAULT.accent,
    }
  } catch { return DEFAULT }
}

export function setAppearance(change: Partial<Appearance>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...appearance(), ...change }))
  window.dispatchEvent(new Event(EVENT))
}

/** The appearance now, following every change. */
export function useAppearance(): Appearance {
  const [value, setValue] = useState(appearance)
  useEffect(() => {
    const listener = () => { setValue(appearance()) }
    window.addEventListener(EVENT, listener)
    return () => { window.removeEventListener(EVENT, listener) }
  }, [])
  return value
}

export const accentOf = (look: Appearance) => ACCENTS.find(item => item.id === look.accent)?.color ?? null
