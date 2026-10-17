import { dataDir, port } from './host'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/**
 * The Forge's workspaces: folders the owner opened, one per project, as herdr has them. Opening a
 * folder adds it here; removing one only takes it off the list, never touches its files.
 */

export interface ForgeWorkspace { readonly id: string; readonly name: string; readonly directory: string; readonly addedAt: string }

const file = () => join(dataDir(), 'forge-workspaces.json')

export function forgeWorkspaces(): readonly ForgeWorkspace[] {
  try {
    const rows = JSON.parse(readFileSync(file(), 'utf8')) as unknown
    if (!Array.isArray(rows)) return []
    return rows.filter((row): row is ForgeWorkspace => typeof row === 'object' && row !== null && typeof (row as ForgeWorkspace).id === 'string' && typeof (row as ForgeWorkspace).directory === 'string' && typeof (row as ForgeWorkspace).name === 'string')
  } catch { return [] }
}

function save(list: readonly ForgeWorkspace[]): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(file(), JSON.stringify(list, null, 2))
}

/** A folder becomes a workspace, named after it; one already open is returned as it is. */
export function addWorkspace(directory: string): ForgeWorkspace {
  const full = resolve(directory)
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error('That folder does not exist.')
  const list = forgeWorkspaces()
  const known = list.find(item => item.directory.toLowerCase() === full.toLowerCase())
  if (known) return known
  const workspace: ForgeWorkspace = { id: randomUUID(), name: basename(full) || full, directory: full, addedAt: new Date().toISOString() }
  save([workspace, ...list])
  return workspace
}

/** Off the list; the folder and its files stay as they are. */
export function removeWorkspace(id: string): void {
  save(forgeWorkspaces().filter(item => item.id !== id))
}

/** The owner picks a folder; null when he cancels. */
export async function pickWorkspace(): Promise<ForgeWorkspace | null> {
  const directory = await port().pickFolder('Open a project folder', false)
  return directory ? addWorkspace(directory) : null
}

/** Whether a directory is one of the owner's workspaces (requests name only these). */
export function isForgeWorkspace(directory: unknown): directory is string {
  return typeof directory === 'string' && forgeWorkspaces().some(item => item.directory === directory)
}
