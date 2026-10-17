import { createRoot } from 'react-dom/client'
import { ForgeWorkspace, setForgeBridge, type ForgeBridge } from '../src/ui'
import './theme.css'

/** The Forge's page on its own: its bridge from the preload, and the Forge filling the window. */
setForgeBridge((window as unknown as { forgeBridge?: ForgeBridge }).forgeBridge ?? null)
const root = document.getElementById('root')
if (root) createRoot(root).render(<div className="forge-app"><ForgeWorkspace /></div>)
