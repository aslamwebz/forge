import type { ITheme } from '@xterm/xterm'

/**
 * How the Forge's terminals look: a colour theme, a font and its size. One choice for all of
 * them, kept between visits, changed live.
 */

export interface TerminalLook { readonly theme: string; readonly fontSize: number; readonly font: string }

export const THEMES: Readonly<Record<string, { readonly label: string; readonly theme: ITheme }>> = {
  evening: { label: 'Evening', theme: {
    background: '#0f0d0b', foreground: '#e9e2d6', cursor: '#d9a441', cursorAccent: '#0f0d0b', selectionBackground: '#d9a44155',
    black: '#1c1916', red: '#e5534b', green: '#8fbf6b', yellow: '#d9a441', blue: '#6f9fd8', magenta: '#c58fd1', cyan: '#6fc1b8', white: '#d8d0c2',
    brightBlack: '#5e574e', brightRed: '#ff7b72', brightGreen: '#a8d98a', brightYellow: '#f0c36a', brightBlue: '#8fb8ef', brightMagenta: '#dcaae6', brightCyan: '#8fdbd2', brightWhite: '#f5efe4',
  } },
  dark: { label: 'Dark+', theme: {
    background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad', selectionBackground: '#264f78',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
  } },
  oneDark: { label: 'One Dark', theme: {
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451',
    black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
  } },
  dracula: { label: 'Dracula', theme: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  } },
  solarized: { label: 'Solarized Dark', theme: {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#fdf6e3',
  } },
  light: { label: 'Light', theme: {
    background: '#fbfaf7', foreground: '#2b2b2b', cursor: '#2b2b2b', selectionBackground: '#cfe3ff',
    black: '#2b2b2b', red: '#c4302b', green: '#2f7d32', yellow: '#9a6700', blue: '#1f5fbf', magenta: '#8b3fa8', cyan: '#127f86', white: '#d6d3cc',
    brightBlack: '#6e6a63', brightRed: '#d9473f', brightGreen: '#3c9a40', brightYellow: '#b07d00', brightBlue: '#2f74d6', brightMagenta: '#a352c2', brightCyan: '#1a969e', brightWhite: '#ffffff',
  } },
}

export const FONTS: readonly { readonly id: string; readonly label: string; readonly stack: string }[] = [
  { id: 'cascadia', label: 'Cascadia Mono', stack: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' },
  { id: 'consolas', label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', stack: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace' },
  { id: 'fira', label: 'Fira Code', stack: '"Fira Code", "Cascadia Mono", Consolas, monospace' },
]

const KEY = 'freya.forge.terminalLook'
const EVENT = 'freya:forge:terminal-look'
const DEFAULT: TerminalLook = { theme: 'evening', fontSize: 14, font: 'cascadia' }
export const MIN_SIZE = 10
export const MAX_SIZE = 24

export function terminalLook(): TerminalLook {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<TerminalLook>
    return {
      theme: typeof saved.theme === 'string' && saved.theme in THEMES ? saved.theme : DEFAULT.theme,
      fontSize: typeof saved.fontSize === 'number' ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(saved.fontSize))) : DEFAULT.fontSize,
      font: FONTS.some(item => item.id === saved.font) ? saved.font! : DEFAULT.font,
    }
  } catch { return DEFAULT }
}

export function setTerminalLook(change: Partial<TerminalLook>): void {
  const next = { ...terminalLook(), ...change }
  const fontSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, next.fontSize))
  localStorage.setItem(KEY, JSON.stringify({ ...next, fontSize }))
  window.dispatchEvent(new Event(EVENT))
}

/** Hear when the look changes (every terminal follows). */
export function onTerminalLook(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => { window.removeEventListener(EVENT, listener) }
}

export const themeOf = (look: TerminalLook) => THEMES[look.theme]?.theme ?? THEMES.evening!.theme
export const fontOf = (look: TerminalLook) => FONTS.find(item => item.id === look.font)?.stack ?? FONTS[0]!.stack
