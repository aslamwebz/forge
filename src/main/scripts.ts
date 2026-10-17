import { dataDir } from './host'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A workspace's scripts: commands the owner saves to start and stop (a dev server, tests, a build).
 * Kept in the app's data, never in the project. The type says what a script is for: a dev server
 * feeds Live previews, a check feeds Review.
 */

export type ScriptType = 'dev' | 'check' | 'other'
export interface ForgeScript { readonly id: string; readonly name: string; readonly command: string; readonly type: ScriptType }

const file = () => join(dataDir(), 'forge-scripts.json')

function readAll(): Record<string, ForgeScript[]> {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, ForgeScript[]> : {}
  } catch { return {} }
}

function writeAll(all: Record<string, ForgeScript[]>): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(file(), JSON.stringify(all, null, 2))
}

const key = (directory: string) => directory.toLowerCase()

export function scriptsOf(directory: string): readonly ForgeScript[] {
  return readAll()[key(directory)] ?? []
}

export function findScript(directory: string, id: string): ForgeScript | null {
  return scriptsOf(directory).find(script => script.id === id) ?? null
}

/** Add a script, or change one by its id. */
export function saveScript(directory: string, input: { readonly id?: string; readonly name: string; readonly command: string; readonly type: string }): ForgeScript {
  const name = input.name.trim().slice(0, 80)
  const command = input.command.trim().slice(0, 4_000)
  if (name === '' || command === '') throw new Error('A script needs a name and a command.')
  const type: ScriptType = input.type === 'dev' || input.type === 'check' ? input.type : 'other'
  const all = readAll()
  const list = all[key(directory)] ?? []
  const script: ForgeScript = { id: input.id && list.some(item => item.id === input.id) ? input.id : randomUUID(), name, command, type }
  all[key(directory)] = list.some(item => item.id === script.id) ? list.map(item => item.id === script.id ? script : item) : [...list, script]
  writeAll(all)
  return script
}

export function deleteScript(directory: string, id: string): void {
  const all = readAll()
  all[key(directory)] = (all[key(directory)] ?? []).filter(item => item.id !== id)
  writeAll(all)
}
