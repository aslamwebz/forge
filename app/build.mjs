import { build as bundle } from 'esbuild'
import { build as page } from 'vite'
import react from '@vitejs/plugin-react'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** The Forge on its own: the main process and preload (esbuild), the page (Vite), in dist-app. */
const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const out = here('../dist-app')
await rm(out, { recursive: true, force: true })

const shared = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true, logLevel: 'info' }
// node-pty carries a native part: it is loaded from node_modules, not bundled.
await bundle({ ...shared, entryPoints: [here('./main.ts')], outfile: `${out}/main.cjs`, external: ['electron', '@lydell/node-pty'] })
await bundle({ ...shared, entryPoints: [here('./preload.ts')], outfile: `${out}/preload.cjs`, external: ['electron'] })

await page({
  root: here('.'),
  base: './',
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: `${out}/renderer`, emptyOutDir: true, target: 'chrome130', assetsInlineLimit: 0 },
})
console.log('Forge built in dist-app; start it with: npx electron dist-app/main.cjs')
