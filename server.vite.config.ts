import { defineConfig } from 'vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

/**
 * Headless home server bundle (out/server/index.js). Dependencies stay
 * external and load from node_modules at runtime, like the Electron main.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  define: { __OSL_VERSION__: JSON.stringify(pkg.version) },
  build: {
    ssr: resolve(__dirname, 'src/server/index.ts'),
    outDir: resolve(__dirname, 'out/server'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } }
  },
  ssr: { target: 'node' }
})
