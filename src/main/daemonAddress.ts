import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Where the engine that outlives the app listens, for one data folder: a named pipe on Windows, a
 * socket file elsewhere. Its card (process id and the token a connecting app must show) is a file
 * in the data folder, readable only by its owner.
 */
export function daemonAddress(dataDir: string): string {
  const id = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16)
  return process.platform === 'win32' ? `\\\\.\\pipe\\forge-${id}` : join(dataDir, 'forge-engine.sock')
}
export const daemonCard = (dataDir: string) => join(dataDir, 'forge-engine.json')
export interface DaemonCard { readonly pid: number; readonly token: string }
