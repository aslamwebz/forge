import { mountForgeIpc } from './forgeIpc'
import { closeTerminals } from './forgeTerminal'
import { stopLeads } from './lead'
import { stopForge as stopServer } from './opencodeHost'
import { stopReviews } from './review'
import type { ForgeHost } from './host'

export type { ForgeHost, ForgeSecurity } from './host'

/** Mount the Forge in the main process: its door for the page, its panes, leads and reviews. */
export function mountForge(host: ForgeHost): void { mountForgeIpc(host) }

/** Everything the Forge runs, stopped with the app. */
export function shutdownForge(): void {
  closeTerminals()
  stopReviews()
  stopLeads()
  stopServer()
}
