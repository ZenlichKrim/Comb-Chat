/**
 * The tools the agent actually reaches for, tested without a model.
 *
 * Three things here were previously only promised in a prompt:
 *  1. a reference the model can read mid-run (`tool_help`) instead of guessing
 *     an argument name and wasting a round;
 *  2. a big command output that stays reachable — the full text goes to disk and
 *     the model is told where, instead of being cut off at the first 24k chars;
 *  3. the round ledger that carries settled facts into the next goal round
 *     instead of starting from a blank context.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeTool, spillText, READ_ONLY_TOOLS } from '../src/main/tools.ts'
import { mergeLedger, roundPrompt, shouldContinue } from '../src/main/goal.ts'

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

/* 3. the ledger carries facts between rounds ------------------------- */
const written = path.join(workspace, 'src', 'Main.java')
fs.mkdirSync(path.dirname(written), { recursive: true })
fs.writeFileSync(written, 'class Main {}')

let ledger = mergeLedger({ done: [], ruledOut: [] }, { touched: [written], report: 'Сделал Main.java.', workspace })
assert.equal(ledger.done.length, 1)
assert.match(ledger.done[0], /src\/Main\.java/)

ledger = mergeLedger(ledger, { touched: [written], report: 'Невозможно собрать: нет JDK на этой машине.', workspace })
assert.equal(ledger.done.length, 1, 'the same file is not recorded twice')
assert.equal(ledger.ruledOut.length, 1)
assert.match(ledger.ruledOut[0], /нет JDK/)

const prompt = roundPrompt({
  objective: 'Собрать мод',
  round: 2,
  maxRounds: 4,
  signal: { unmet: ['Билд проходит'], openTodos: [] },
  criteria: ['Билд проходит', 'Есть jar'],
  attemptsSoFar: 1,
  ledger,
  previousReport: 'Сделал Main.java.'
})
assert.match(prompt, /Уже сделано и проверено/)
assert.match(prompt, /src\/Main\.java/)
assert.match(prompt, /не повторяй/)
assert.match(prompt, /Раунд 2 из 4/)

// the ledger never grows without bound
let grown = { done: [], ruledOut: [] }
for (let i = 0; i < 40; i++) grown = mergeLedger(grown, { touched: [path.join(workspace, `f${i}.txt`)], workspace })
assert.ok(grown.done.length <= 14, `ledger stayed at ${grown.done.length}`)
assert.ok(grown.ruledOut.length <= 6)

// a clean verdict still ends the goal: bookkeeping never outranks the checker
assert.equal(shouldContinue('1. Билд проходит', { verdict: 'done', checks: [{ claim: 'Билд проходит', status: 'pass' }] }, []), null)

fs.rmSync(workspace, { recursive: true, force: true })
console.log('tooling: 22 checks passed')
