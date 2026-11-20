/** Runs the two-session store test with the Electron stand-in installed. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'electron-require.cjs')

const res = spawnSync(
  process.execPath,
  [path.join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(here, 'parallel-sessions.mjs')],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${hook}`.trim() }
  }
)
process.exit(res.status ?? 1)
