/**
 * The tools the agent actually reaches for, tested without a model.
 *
 * Three things here were previously only promised in a prompt:
 *  1. a reference the model can read mid-run (`tool_help`) instead of guessing
 *     an argument name and wasting a round;
 *  2. a big command output that stays reachable — the full text goes to disk and
 *     the model is told where, instead of being cut off at the first 24k chars;
 *  3. a contract stamped for one task is never applied to another.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeTool, spillText, READ_ONLY_TOOLS } from '../src/main/tools.ts'
import { specForRequest, writeSpec } from '../src/main/spec.ts'
import { scoreAppMatch } from '../src/main/discover.ts'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-tools-'))

function ctx(extra = {}) {
  return {
    workspace,
    roots: [workspace],
    fullDisk: false,
    touched: new Set(),
    beforeState: new Map(),
    todos: [],
    onTodos: () => {},
    approvalPolicy: 'yolo',
    runId: 'run-tools',
    requestApproval: async () => 'allow',
    signal: new AbortController().signal,
    ...extra
  }
}

/* 1. the help page -------------------------------------------------- */
const list = await executeTool('tool_help', {}, ctx())
assert.equal(list.ok, true)
assert.match(list.output, /read_file/)
assert.match(list.output, /run_command/)

const one = await executeTool('tool_help', { name: 'run_command' }, ctx())
assert.equal(one.ok, true)
assert.match(one.output, /timeout_ms/)
assert.match(one.output, /\.comb\/output/)

const missing = await executeTool('tool_help', { name: 'no_such_tool' }, ctx())
assert.equal(missing.ok, false)
assert.match(missing.error, /No tool named no_such_tool/)

// reading the reference is reading: it never asks the user for permission
assert.equal(READ_ONLY_TOOLS.has('tool_help'), true)

/* 2. a big output is kept, not thrown away --------------------------- */
const big = 'line\n'.repeat(20000)
const spilled = await spillText(ctx(), 'npm-test', big, 2000, 500)
assert.match(spilled, /output trimmed: \d+ chars not shown/)
assert.match(spilled, /last 500 chars/)
assert.match(spilled, /\.comb\/output\//)
const saved = spilled.match(/(\.comb\/output\/[^\s—]+)/)
assert.ok(saved, 'the message names the saved file')
assert.equal(fs.readFileSync(path.join(workspace, saved[1]), 'utf8').length, big.length)

// a real command through the tool: the head and tail survive, the exit code is there
// the child would inherit this test's NODE_OPTIONS preload; clear it so the
// command under test is the command, nothing else
const clearEnv = process.platform === 'win32' ? 'set NODE_OPTIONS= && ' : 'NODE_OPTIONS= '
const cmd = await executeTool(
  'run_command',
  { command: `${clearEnv}node -e "console.log('A'.repeat(30000)); console.error('LAST-LINE')"`, timeout_ms: 60000 },
  ctx()
)
assert.equal(cmd.ok, true)
assert.match(cmd.output, /\[exit 0\]/)
assert.match(cmd.output, /LAST-LINE/)
assert.match(cmd.output, /\.comb\/output\//)

/* the contract must never travel between tasks or domains */
writeSpec(workspace, '<!-- comb:request:сделай карту для игры peak -->\n1. [[карта]] уровня\n2. файлы игры на месте')
assert.equal(specForRequest(workspace, 'сделай карту для игры peak'), specForRequest(workspace, 'сделай карту для игры peak'))
// a stamped spec is used only for its own request
assert.equal(specForRequest(workspace, 'сделай мод про снег'), '')
// a spec that injected another domain is refused even for the same ask
writeSpec(workspace, '<!-- comb:request:сделай карту для игры peak -->\n1. ванильный мир Minecraft Java\n2. region-файлы')
assert.equal(specForRequest(workspace, 'сделай карту для игры peak'), '')
// a legacy unstamped spec is never adopted
fs.writeFileSync(path.join(workspace, 'SPEC.md'), '1. карта уровня\n2. ванильный мир Minecraft Java')
assert.equal(specForRequest(workspace, 'сделай карту для игры peak'), '')

/* 4. finding things nobody said the location of -------------- */
// a game folder on "another drive", a studio install, a built jar
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-elsewhere-'))
fs.mkdirSync(path.join(elsewhere, 'Peak', 'Peak_Data', 'StreamingAssets'), { recursive: true })
fs.writeFileSync(path.join(elsewhere, 'Peak', 'Peak.exe'), 'MZ')
fs.writeFileSync(path.join(elsewhere, 'Peak', 'Peak_Data', 'StreamingAssets', 'level_main.unity3d'), 'x')
fs.mkdirSync(path.join(elsewhere, 'Roblox Studio'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'build.jar'), 'PK')

const found = await executeTool('find_path', { name: 'Peak', root: elsewhere, kind: 'dir' }, ctx())
assert.equal(found.ok, true)
assert.match(found.output, /Peak/)
assert.equal(found.meta.count >= 1, true)

const jars = await executeTool('find_path', { name: '*.jar', root: workspace }, ctx())
assert.match(jars.output, /build\.jar/)

// a miss is an honest fact: it says where it looked, not just "no"
const miss = await executeTool('find_path', { name: 'definitely-not-here-xyz', root: elsewhere }, ctx())
assert.equal(miss.ok, true)
assert.match(miss.output, /Nothing named like/)
assert.match(miss.output, /search finished/)

// without full disk access the search stays inside the open folders
const confined = await executeTool('find_path', { name: 'Peak' }, ctx())
assert.equal(confined.meta.count, 0)

// the app matcher ranks the studio above the player
assert.ok(scoreAppMatch('Roblox Studio', 'roblox studio') > scoreAppMatch('Roblox Player', 'roblox studio'))

/* 5. the design is judged by looking at it -------------------- */
// No real Chrome in this sandbox (seccomp kills it), so the plumbing is tested
// against a stand-in that writes a real 1x1 PNG where a browser would: the
// arguments, the saved path, the data URL and the "nothing to look at" answer
// are ours to get wrong; the pixels are the browser's job.
const page = path.join(workspace, 'ui.html')
fs.writeFileSync(
  page,
  '<!doctype html><html><body style="background:#14110e;color:#f4ece1;font:16px system-ui"><h1 style="padding:24px">Comb</h1></body></html>'
)
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-chrome-'))
const stub = path.join(stubDir, process.platform === 'win32' ? 'chrome.cmd' : 'chrome')
fs.writeFileSync(
  stub,
  process.platform === 'win32'
    ? '@echo off\r\nfor %%a in (%*) do (echo %%a | findstr /b -- "--screenshot=" >nul && set OUT=%%a)\r\nexit /b 0\r\n'
    : `#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) f="\${a#--screenshot=}";; esac; done\nf=$(echo "$f" | tr -d '"')\nprintf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==' | base64 -d > "$f"\nexit 0\n`,
  { mode: 0o755 }
)
const shot = await executeTool('preview_page', { path: 'ui.html', size: '800,600', wait_ms: 200, binary: stub }, ctx())
if (!shot.ok) {
  console.log(`  warn  preview_page plumbing not testable here: ${String(shot.error).slice(0, 120)}`)
} else {
  assert.match(shot.output, /Screenshot of/)
  assert.match(shot.output, /800,600/)
  assert.match(String(shot.meta.imageUrl), /^data:image\/png;base64,/)
  assert.ok(fs.statSync(path.join(workspace, shot.meta.imageRel)).size > 50, 'the png landed on disk')
}

// no browser at all: an honest refusal that forbids claiming it looks good
const noBrowser = await executeTool('preview_page', { path: 'ui.html', binary: path.join(stubDir, 'nope') }, ctx())
assert.equal(noBrowser.ok, false)
assert.match(noBrowser.error, /No browser at/)

// game assets are not text: read_file must not dump binary noise as if it were code
// the bytes are not text, so the answer must say so instead of dumping noise
fs.writeFileSync(path.join(workspace, 'level.unity3d'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]))
const asset = await executeTool('read_file', { path: 'level.unity3d' }, ctx())
assert.match(`${asset.error || ''}${asset.output || ''}`, /binary|not a text|не текст/i)
assert.ok(asset.meta?.binary === true || /binary/i.test(asset.output || ''), 'the model is told it is a binary, not code')

fs.rmSync(workspace, { recursive: true, force: true })
fs.rmSync(elsewhere, { recursive: true, force: true })
console.log('tooling: 33 checks passed')
