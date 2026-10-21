import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchEnv } from './agents'
import { dataDir } from './host'

/**
 * An agent's own branch: a git worktree of the workspace's repository, so agents working side by
 * side never edit the same files. Each lives under the Forge's data folder on the branch forge/<key>,
 * made from what the workspace has checked out. The work stays on its branch for him to merge;
 * a worktree is removed only when nothing in it is left uncommitted.
 */
export interface Worktree {
  readonly key: string
  readonly branch: string
  readonly path: string
  /** Files changed and not committed. */
  readonly changed: number
  /** Commits on its branch that the workspace's checkout does not have. */
  readonly ahead: number
}

const git = (cwd: string, args: readonly string[]) => spawnSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true, env: launchEnv() })

/** The repository's top folder, or null when the workspace is not in one. */
function repositoryOf(directory: string): string | null {
  const top = git(directory, ['rev-parse', '--show-toplevel'])
  return top.status === 0 ? resolve(top.stdout.trim()) : null
}

const safe = (key: string) => key.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'agent'
const branchOf = (key: string) => `forge/${safe(key)}`
const rootOf = (repository: string) => join(dataDir(), 'forge', 'worktrees', createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 12))

/** The worktree for a pane, made the first time; the same one again for the same key (so a session resumes where it ran). */
export function worktreeFor(directory: string, key: string): { readonly path: string; readonly branch: string } {
  const repository = repositoryOf(directory)
  if (!repository) throw new Error('An own branch needs a git repository: this workspace is not in one.')
  if (git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD']).status !== 0) throw new Error('An own branch needs a first commit in this repository.')
  const path = join(rootOf(repository), safe(key))
  const branch = branchOf(key)
  if (existsSync(join(path, '.git'))) return { path, branch }
  mkdirSync(rootOf(repository), { recursive: true })
  // The branch may be left from an earlier worktree: its work is picked up again, not made anew.
  const exists = git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0
  const made = git(repository, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'HEAD'])
  if (made.status !== 0) throw new Error(`The own branch could not be made: ${(made.stderr || made.stdout).trim().split('\n').at(-1) ?? 'git failed'}`)
  return { path, branch }
}

/** The Forge's worktrees of a workspace's repository, with what is in each. */
export function worktreesOf(directory: string): readonly Worktree[] {
  const repository = repositoryOf(directory)
  if (!repository) return []
  const root = rootOf(repository).toLowerCase()
  const listed = git(repository, ['worktree', 'list', '--porcelain'])
  if (listed.status !== 0) return []
  const out: Worktree[] = []
  for (const block of listed.stdout.split(/\r?\n\r?\n/u)) {
    const path = /^worktree (.+)$/mu.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1]
    if (!path || !branch || !resolve(path).toLowerCase().startsWith(root)) continue
    const status = git(path, ['status', '--porcelain'])
    const ahead = git(repository, ['rev-list', '--count', `HEAD..${branch}`])
    out.push({
      key: resolve(path).slice(root.length + 1), branch, path: resolve(path),
      changed: status.status === 0 ? status.stdout.split(/\r?\n/u).filter(Boolean).length : 0,
      ahead: ahead.status === 0 ? Number(ahead.stdout.trim()) || 0 : 0,
    })
  }
  return out
}

/** Remove a worktree whose work is all committed; its branch stays, with the commits, for him to merge. */
export function removeWorktree(directory: string, key: string): void {
  const found = worktreesOf(directory).find(item => item.key === safe(key))
  if (!found) throw new Error('That own branch is not one of this workspace\'s.')
  if (found.changed > 0) throw new Error(`${found.branch} has ${String(found.changed)} uncommitted change${found.changed === 1 ? '' : 's'}: commit or discard them first.`)
  const repository = repositoryOf(directory)!
  const removed = git(repository, ['worktree', 'remove', found.path])
  if (removed.status !== 0) throw new Error(`The worktree could not be removed: ${(removed.stderr || removed.stdout).trim().split('\n').at(-1) ?? 'git failed'}`)
}
