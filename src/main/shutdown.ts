import { closeTerminals } from './forgeTerminal'
import { stopLeads } from './lead'
import { stopForge as stopServer } from './opencodeHost'
import { stopReviews } from './review'

/** Everything the engine runs, stopped: its terminals (what ran is kept for Restore), reviews, leads. */
export function shutdownEngine(): void {
  closeTerminals()
  stopReviews()
  stopLeads()
  stopServer()
}
