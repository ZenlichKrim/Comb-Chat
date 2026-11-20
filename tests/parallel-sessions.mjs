/**
 * Two sessions at once.
 *
 * The bug this pins down: the renderer had one window-wide `running` flag and one
 * `streamingMessageId`, and every run event was written into whichever thread
 * happened to be open. Starting a second session was refused, and the first one
 * looked like it had "just stopped" because its output went to the other chat.
 *
 * The store is plain zustand, so it runs headless under Node with a fake bridge.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')

/* a bridge just real enough for the store to boot */
const thread = {
  id: 't1',
  title: 'demo',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  workspace: '/ws/demo',
  model: 'deepseek-flash',
  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
  todos: []
}
const runCalls = []
const noop = () => {}
const off = () => noop
globalThis.window = {
  confirm: () => false,
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: noop,
  localStorage: { getItem: () => null, setItem: noop },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  innerWidth: 1440,
  innerHeight: 900,
  comb: {
    app: { platform: 'linux', getInfo: async () => ({ platform: 'linux', homedir: '/home' }), attention: noop, setTheme: noop, onMaximized: off, isMaximized: async () => false },
    window: { setTheme: noop, setTitle: noop, onCommand: off },
    ui: { onCommand: off },
    settings: { get: async () => ({}), set: async () => ({}), onChanged: off },
    threads: { list: async () => [thread], save: async () => {}, delete: async () => {}, clearAll: async () => {} },
    agent: {
      run: async (req) => {
        runCalls.push(req)
        return { ok: true }
      },
      onEvent: off,
      stop: async () => {},
      approve: async () => {},
      vote: async () => {},
      steer: async () => {}
    },
    fs: {
      list: async () => [],
      read: async () => ({ content: '' }),
      onChanged: off,
      watch: noop,
      pickFolder: async () => null,
      pickFiles: async () => []
    },
    notes: { list: async () => [] },
    terminal: { onData: off, onExit: off },
    git: { status: async () => ({ branch: 'main', ahead: 0, behind: 0, files: [] }) },
    checkpoints: { list: async () => [] }
  }
}
globalThis.document = {
  // the store themes the document on boot: give it the three methods it uses
  documentElement: { style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' }, dataset: {} },
  hasFocus: () => true,
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => []
}
globalThis.localStorage = window.localStorage

// tsx resolves the TS store; the test only needs zustand + the store module
const { useStore } = await import(pathToFileURL(path.join(root, 'src/renderer/src/store.ts')).href)

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

await useStore.getState().boot()
console.log('parallel sessions:')

// session A starts
await useStore.getState().sendMessage('первая задача')
const a = useStore.getState().activeThreadId
const runsA = useStore.getState().runs
check('the first session starts a run', !!runsA[a], JSON.stringify(Object.keys(runsA)))

// the user opens a new session while A is still working
useStore.getState().newThread()
const b = useStore.getState().activeThreadId
check('a new session is a different thread', !!b && b !== a, `${a} / ${b}`)
check('the first run is still registered', !!useStore.getState().runs[a])

// ...and sends a message of its own
const accepted = await useStore.getState().sendMessage('вторая задача')
const state = useStore.getState()
check('the second session starts while the first is running', accepted === true && !!state.runs[b], JSON.stringify(Object.keys(state.runs)))
check('both runs are in flight', !!state.runs[a] && !!state.runs[b])
check('two run requests reached the main process', runCalls.length === 2, String(runCalls.length))

// events of A arrive while B is on screen
const runIdA = useStore.getState().runs[a].runId
useStore.getState().handleEvent({ type: 'text-delta', runId: runIdA, text: 'РАБОТА А' })
const threadA = useStore.getState().threads.find((t) => t.id === a)
const threadB = useStore.getState().threads.find((t) => t.id === b)
const textA = threadA.messages.map((m) => m.content).join('|')
const textB = threadB.messages.map((m) => m.content).join('|')
check('output of the background run lands in its own session', textA.includes('РАБОТА А'), textA)
check('the session on screen is not polluted by it', !textB.includes('РАБОТА А'), textB)

// A finishes; B keeps working
useStore.getState().handleEvent({ type: 'run-end', runId: runIdA, reason: 'done' })
const after = useStore.getState()
check('ending one run does not end the other', !!after.runs[b] && after.running === true, JSON.stringify(Object.keys(after.runs)))
check('the ended run is removed from the list', !after.runs[a])

// stopping is per session
await useStore.getState().stopRun()

console.log(`\nparallel sessions: ${pass + fail} checks, ${pass} passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)
