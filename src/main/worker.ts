import { engineLink } from './engineLink'

/**
 * The Forge's engine in a process of its own (an Electron utility process): it goes when the app
 * goes. The messages are engineLink's.
 */

interface ParentPort { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void }
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error('The Forge engine runs as a utility process of an app.')
const link = engineLink((message) => { parent.postMessage(message) }, () => { process.exit(0) })
parent.on('message', (event) => { link.receive(event.data) })
