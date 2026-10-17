import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { saveScript, type ScriptType } from './scripts'
import { addWorkspace, type ForgeWorkspace } from './workspaces'

/**
 * New projects for the Forge: a folder made where the owner chooses, set up by the template's own
 * official starter, run in the workspace's terminal so he sees and answers it. Each template also
 * saves the scripts such a project usually has (its dev server, its checks). Only these can be used.
 */

export interface ForgeTemplate {
  readonly id: string
  readonly name: string
  readonly description: string
  /** The starter, run inside the new empty folder; empty for none. */
  readonly command: string
  readonly scripts: readonly { readonly name: string; readonly command: string; readonly type: ScriptType }[]
}

export const FORGE_TEMPLATES: readonly ForgeTemplate[] = Object.freeze([
  { id: 'empty', name: 'Empty', description: 'A new folder with git. Start an agent and build from an idea.', command: 'git init', scripts: [] },
  { id: 'vite-react', name: 'React + Vite', description: 'A TypeScript single-page app.', command: 'npm create vite@latest . -- --template react-ts', scripts: [
    { name: 'Dev server', command: 'npm run dev', type: 'dev' }, { name: 'Lint', command: 'npm run lint', type: 'check' }, { name: 'Build', command: 'npm run build', type: 'check' }] },
  { id: 'next', name: 'Next.js', description: 'A full-stack React app (its starter asks its questions).', command: 'npx create-next-app@latest .', scripts: [
    { name: 'Dev server', command: 'npm run dev', type: 'dev' }, { name: 'Lint', command: 'npm run lint', type: 'check' }, { name: 'Build', command: 'npm run build', type: 'check' }] },
  { id: 'laravel', name: 'Laravel', description: 'A PHP web app with Composer.', command: 'composer create-project laravel/laravel .', scripts: [
    { name: 'Dev server', command: 'php artisan serve', type: 'dev' }, { name: 'Tests', command: 'php artisan test', type: 'check' }] },
  { id: 'astro', name: 'Astro', description: 'A content site or blog.', command: 'npm create astro@latest .', scripts: [
    { name: 'Dev server', command: 'npm run dev', type: 'dev' }, { name: 'Build', command: 'npm run build', type: 'check' }] },
  { id: 'hono', name: 'Hono API', description: 'A small TypeScript web API.', command: 'npm create hono@latest .', scripts: [
    { name: 'Dev server', command: 'npm run dev', type: 'dev' }] },
  { id: 'python', name: 'Python (uv)', description: 'A Python project managed by uv.', command: 'uv init .', scripts: [
    { name: 'Run', command: 'uv run main.py', type: 'other' }] },
])

/** Where new projects go unless he picks another place. */
export function defaultLocation(): string {
  return join(app.getPath('documents'), 'Forge Projects')
}

const chosenFile = () => join(app.getPath('userData'), 'forge-locations.json')
function chosenLocations(): string[] {
  try { const list = JSON.parse(readFileSync(chosenFile(), 'utf8')) as unknown; return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}
/** A location he chose in the folder dialog (now or before), or the default. */
export function isChosenLocation(location: string): boolean {
  const wanted = resolve(location.trim() || defaultLocation()).toLowerCase()
  return wanted === resolve(defaultLocation()).toLowerCase() || chosenLocations().some(item => resolve(item).toLowerCase() === wanted)
}

/** He picks the folder new projects go in; null when he cancels. */
export async function pickLocation(window: BrowserWindow | null): Promise<string | null> {
  const options = { title: 'Where new projects go', properties: ['openDirectory' as const, 'createDirectory' as const] }
  const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  const picked = chosen.canceled ? null : chosen.filePaths[0] ?? null
  if (picked) writeFileSync(chosenFile(), JSON.stringify([...new Set([...chosenLocations(), picked])].slice(-20), null, 2))
  return picked
}

/** Make the project's folder, list it as a workspace and save its scripts; the starter is for the terminal. */
export function createProject(input: { readonly location: string; readonly name: string; readonly template: string }): { readonly workspace: ForgeWorkspace; readonly command: string } {
  const template = FORGE_TEMPLATES.find(item => item.id === input.template)
  if (!template) throw new Error('That is not one of the templates.')
  const name = input.name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(name) || name.endsWith('.')) throw new Error('A project name uses letters, numbers, spaces, dots, dashes or underscores (up to 64).')
  const location = input.location.trim() || defaultLocation()
  if (!isAbsolute(location)) throw new Error('Choose a full folder path for the location.')
  if (location === defaultLocation()) mkdirSync(location, { recursive: true })
  if (!existsSync(location) || !statSync(location).isDirectory()) throw new Error('That location does not exist.')
  const directory = resolve(location, name)
  if (existsSync(directory) && readdirSync(directory).length > 0) throw new Error(`${directory} already exists and is not empty. Open it as a folder instead.`)
  mkdirSync(directory, { recursive: true })
  const workspace = addWorkspace(directory)
  for (const script of template.scripts) saveScript(workspace.directory, script)
  return { workspace, command: template.command }
}
