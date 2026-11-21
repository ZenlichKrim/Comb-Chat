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

// Stage events: the team runs `run:build` / `run:review`, the goal opens
// `run:goal2`. These ids were not in `runs`, so the store could not place them
// and dumped every later stage into whatever session was on screen.
useStore.getState().handleEvent({ type: 'text-delta', runId: `${runIdA}:build`, text: 'СБОРКА А' })
useStore.getState().handleEvent({ type: 'text-delta', runId: `${runIdA}:goal2`, text: 'РАУНД А' })
const stageA = useStore.getState().threads.find((t) => t.id === a).messages.map((m) => m.content).join('|')
const stageB = useStore.getState().threads.find((t) => t.id === b).messages.map((m) => m.content).join('|')
check('a stage of a run stays in that run\'s session', stageA.includes('СБОРКА А') && stageA.includes('РАУНД А'), stageA.slice(-120))
check('a stage never lands in the other session', !stageB.includes('СБОРКА А') && !stageB.includes('РАУНД А'), stageB.slice(-120))

// An event stamped with its session is placed by that stamp even when the run id
// is one the renderer never registered (a resumed run, or a stage opened in main).
useStore.getState().handleEvent({ type: 'text-delta', runId: 'run-unknown-to-renderer:build', text: 'ПОМЕТКА СЕССИИ', threadId: a })
const stamped = useStore.getState().threads.find((t) => t.id === a).messages.map((m) => m.content).join('|')
check('an event carries its session and is placed by it', stamped.includes('ПОМЕТКА СЕССИИ'), stamped.slice(-120))

// An answer must go back to the run that asked, not to the tab on screen.
const voteSeen = []
window.comb.agent.vote = async (runId, voteId) => { voteSeen.push([runId, voteId]) }
const runIdB = useStore.getState().runs[b].runId
useStore.getState().handleEvent({
  type: 'tool-approval-request',
  runId: runIdB,
  call: { id: 'call-vote', name: 'ask_user', args: { question: 'Какую?', options: ['первую', 'вторую'], recommend: 'вторую' } }
})
useStore.getState().handleEvent({ type: 'tool-call', runId: runIdB, call: { id: 'call-vote', name: 'ask_user', args: { question: 'Какую?', options: ['первую', 'вторую'], recommend: 'вторую' } } })
useStore.getState().handleEvent({ type: 'text-delta', runId: runIdB, text: 'СПРАШИВАЮ' })
useStore.getState().selectThread(a)
await useStore.getState().answerLiveVote('call-vote', 'первую')
check('an answer is delivered to the run that asked, not the open tab', voteSeen.some(([r, v]) => v === 'call-vote' && r === runIdB), JSON.stringify(voteSeen))
useStore.getState().selectThread(b)

// A finishes; B keeps working
useStore.getState().handleEvent({ type: 'run-end', runId: runIdA, reason: 'done' })
const after = useStore.getState()
check('ending one run does not end the other', !!after.runs[b] && after.running === true, JSON.stringify(Object.keys(after.runs)))
check('the ended run is removed from the list', !after.runs[a])

// Approval: the modal must name the session that asked, and the decision must go
// back to that run even when another session is on screen.
const approvals = []
window.comb.agent.approve = async (runId, callId, decision) => { approvals.push([runId, callId, decision]) }
const liveB = useStore.getState().runs[b] ? runIdB : useStore.getState().runs[a].runId
const liveThread = useStore.getState().runs[b] ? b : a
const otherThread = liveThread === a ? b : a
useStore.getState().handleEvent({
  type: 'tool-approval-request',
  runId: liveB,
  call: { id: 'call-write', name: 'write_file', args: { path: 'x.txt' } }
})
useStore.getState().selectThread(otherThread)
const pending = useStore.getState()
check('an approval from a background session is attributed to it', pending.approvalThreadId === liveThread && pending.approvalRunId === liveB, `${pending.approvalThreadId} / ${pending.approvalRunId}`)
// and it survives a tab switch: the session that asked is still blocked
useStore.getState().selectThread(liveThread)
check('switching tabs does not lose a pending approval', useStore.getState().approvalRunId === liveB, String(useStore.getState().approvalRunId))
await useStore.getState().approve('allow')
check('the decision goes to the run that asked', approvals.some(([r, c, d]) => r === liveB && c === 'call-write' && d === 'allow'), JSON.stringify(approvals))
useStore.getState().selectThread(b)

// A deleted session is deleted: its run is stopped and later events are dropped
const stopCalls = []
window.comb.agent.stop = async (id) => { stopCalls.push(id) }
await useStore.getState().sendMessage('третья задача')
const c = useStore.getState().activeThreadId
const runIdC = useStore.getState().runs[c].runId
await useStore.getState().deleteThread(c)
const afterDelete = useStore.getState()
check('deleting a session stops its run', stopCalls.includes(runIdC), JSON.stringify(stopCalls))
check('a deleted session is gone from the list', !afterDelete.threads.some((t) => t.id === c))
useStore.getState().handleEvent({ type: 'text-delta', runId: runIdC, text: 'ПРИЗРАК' })
check('no messages arrive from a deleted session', !useStore.getState().threads.some((t) => t.messages.some((m) => (m.content || '').includes('ПРИЗРАК'))))

// The author's answer must survive the stage that follows it
useStore.getState().selectThread(a)
await useStore.getState().sendMessage('четвёртая задача')
const d = useStore.getState().activeThreadId
const runIdD = useStore.getState().runs[d].runId
useStore.getState().handleEvent({ type: 'role', runId: runIdD, role: 'author', phase: 'thinking' })
useStore.getState().handleEvent({ type: 'text-delta', runId: runIdD, text: 'ВОТ ЧТО Я ДУМАЮ О ЗАДАЧЕ' })
useStore.getState().handleEvent({ type: 'role', runId: `${runIdD}:build`, role: 'builder', phase: 'working', threadId: d })
useStore.getState().handleEvent({ type: 'run-end', runId: `${runIdD}:build`, reason: 'done', threadId: d })
const threadD = useStore.getState().threads.find((t) => t.id === d)
check('the author\'s answer does not vanish when the next stage starts', threadD.messages.some((m) => (m.content || '').includes('ВОТ ЧТО Я ДУМАЮ')), threadD.messages.map((m) => (m.content || '').slice(0, 20)).join(' | '))

// stopping is per session
await useStore.getState().stopRun()

console.log(`\nparallel sessions: ${pass + fail} checks, ${pass} passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)
