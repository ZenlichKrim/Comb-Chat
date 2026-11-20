/**
 * Runs the agent harness with the Electron stand-in installed.
 *
 * The main process imports `electron`, which throws outside the desktop app; the
 * harness needs the loop, not the window. The require hook lives in
 * `electron-require.cjs`, and passing it through NODE_OPTIONS keeps the harness
 * itself a plain ESM file that `tsx` can run.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const hook = path.join(here, 'electron-require.cjs')
// the file to run: the agent loop by default, any other harness by name
const harness = path.join(here, process.argv[2] || 'harness.mjs')

const res = spawnSync(
  process.execPath,
  [path.join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), harness],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${hook}`.trim() }
  }
)
process.exit(res.status ?? 1)
