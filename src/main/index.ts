/**
 * The Forge, for the main process of an Electron app. Two ways to carry it:
 * - mountForge: the engine runs in the app's own process (simple; the standalone Forge uses it).
 * - mountForgeProcess: the engine runs in a process of its own, restartable without the app
 *   (the app bundles worker.ts and gives its path).
 */
export { mountForge, shutdownForge } from './inProcess'
export { mountForgeProcess, type ForgeProcessHost } from './supervisor'
export type { ForgeHost } from './electronPort'
export type { ForgeSecurity } from './host'
