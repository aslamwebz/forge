import antigravity from './icons/antigravity-color.svg?raw'
import claude from './icons/claudecode-color.svg?raw'
import codex from './icons/codex-color.svg?raw'
import minimax from './icons/minimax-color.svg?raw'
import opencode from './icons/opencode.svg?raw'

/** Each tool's own logo (bundled files, see icons/LICENSE.md); Claude on MiniMax is MiniMax's, with Claude's in the corner. */
const bare = (svg: string) => svg.replace(/<title>[^<]*<\/title>/u, '')
const LOGOS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries({ opencode, claude, codex, mcode: minimax, agy: antigravity, 'claude-minimax': minimax, 'claude-minimax-m3': minimax }).map(([id, svg]) => [id, bare(svg)]))

export function AgentIcon({ id, mark }: { readonly id: string; readonly mark: string }) {
  const logo = LOGOS[id]
  if (!logo) return <span className="fg-mark" aria-hidden="true">{mark}</span>
  return <span className="fg-mark fg-logo" aria-hidden="true">
    {/* Our own bundled SVG files, never anything from outside. */}
    <span dangerouslySetInnerHTML={{ __html: logo }} />
    {id.startsWith('claude-minimax') ? <span className="fg-logo-badge" dangerouslySetInnerHTML={{ __html: bare(claude) }} /> : null}
    {id === 'claude-minimax-m3' ? <span className="fg-logo-tag">M3</span> : null}
  </span>
}
