// Runs the headless home server inside Electron's Node runtime so the
// Electron-ABI build of better-sqlite3 loads without a rebuild. (Docker uses
// plain Node with a Node-ABI build instead — see Dockerfile.)
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const child = spawn(electronPath, ['out/server/index.js', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
child.on('exit', (code) => process.exit(code ?? 0))
