---
name: forge
description: Run other coding agents (Claude Code, Codex, OpenCode, Antigravity and more) beside you in Forge, each in a real terminal and optionally on its own git branch; hand them tasks, read their screens, wait for them and stop them. Use when work splits into parts that can go in parallel, or a second opinion from another agent would help.
---

# Forge

Forge runs coding agents side by side in real terminals. The `forge` command drives the same
engine the Forge app shows, so the owner sees every agent you start, live.

## Before you start

- `forge agents` lists the agents that can be started here (an id, its name, and why one is unavailable).
- `forge ps` lists what already runs in this workspace. Do not start a second agent for work one is doing.
- The workspace is the one the current folder is in. Elsewhere, add `--in <folder>`.
  A folder that is not a workspace yet: `forge add <folder>` (only when the owner asked for it).

## Hand off a task

```bash
forge start codex --branch --task "Add input validation to src/api/users.ts and its tests. Commit when the tests pass."
```

- `--branch` gives the agent a git worktree of its own on the branch `forge/<pane>`, so it never edits
  the files you are editing. Use it whenever two agents could touch the same files.
  Its commits stay on that branch; tell the owner the branch name so they can review and merge.
- The task is typed in once the agent is ready. Give it everything it needs: the goal, the files, how
  to know it is done, and whether to commit. It cannot see your conversation.
- If it asks something before it can work, `start` says so; `forge read <pane>` shows the question.

## Follow it

```bash
forge wait codex-1 --timeout 600   # until done, idle or blocked (exit code 2 if time ran out)
forge read codex-1 --lines 80      # the last lines of its screen
forge send codex-1 "Also cover the empty-email case."
forge branches                     # each own branch: commits ahead, uncommitted files
forge stop codex-1                 # when its work is finished
```

- `blocked` means it is waiting for an answer. Read the screen; answer only what you are sure the
  owner would agree to (a plan you asked for, a question about the task). Approvals to run commands,
  spend money, or touch anything outside the workspace are the owner's: tell them instead.
- Check the result yourself before you report it: read the diff on its branch
  (`git diff main...forge/codex-1`) and run the tests.

## Rules

- Start only as many agents as the work needs; each one costs the owner money.
- Never stop an agent you did not start unless the owner asked.
- `--json` gives machine-readable output for any command.
