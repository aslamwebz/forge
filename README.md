# Forge

A workplace for coding agents. Real terminals for Claude Code, Codex, OpenCode, Antigravity and your own shells, side by side, in the folders you work in.

- **Harness**: start agents from the side bar and arrange them (side by side, stacked, grid, or one lead on half the screen). See what each is doing (working, needs you, done) and get a desktop notice when one needs you. Resume past sessions, and restore what ran after a restart (nothing starts on its own).
- **Lead**: one Claude Code pane commands the others (start, message, read, wait, stop) through a local MCP endpoint. Every call is decided first by the host app's security core. Without one, the lead is off.
- **Review**: your checks, then read-only auditors (correctness, security, intent, test integrity, AI slop, architecture) and a verifier.
- **Live previews**: the dev servers your scripts start, shown in place.
- **Scripts**: your commands, started and stopped in a terminal panel.

## Run it on its own

```
npm install
npm start
```

Its data (workspaces, scripts, reviews) lives in `%APPDATA%/Forge`.

## Inside another Electron app

The Forge is built into Freya from `packages/forge` (this repository, checked out there).

```ts
// main process
import { mountForge, shutdownForge } from '@freya/forge/main'
mountForge({ window: () => mainWindow, security, navigate })   // security and navigate are optional
app.on('will-quit', shutdownForge)

// page
import { ForgeWorkspace, setForgeBridge } from '@freya/forge/ui'
setForgeBridge(window.yourPreloadBridge)   // forge(), onForgeEvent, onForgeState, onForgeTerminal
<ForgeWorkspace />
```

The host's preload must forward the `freya:forge` invoke channel and the `freya:forge:event`, `freya:forge:state` and `freya:forge:term` push channels (see `app/preload.ts`). The host must also give the CSS tokens `--f-bg`, `--f-ink`, `--f-muted`, `--f-line` and `--f-accent` (see `app/theme.css`).
