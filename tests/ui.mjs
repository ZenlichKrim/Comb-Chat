/**
 * The screen the user called "too loaded".
 *
 * The reference they sent has a sidebar of names — Search, Sessions, Settings —
 * a list of sessions, and nothing else. This app had a rail of four icons, a
 * panel of headers behind it, a right-hand plan panel, a filled title bar, a
 * filled status bar and an avatar with a spine next to every message.
 *
 * The test renders the real Sidebar against the real store and checks the two
 * things that matter to a person opening the app:
 *  1. the left side is a column of readable names, and clicking one switches
 *     the body (a name list, not an icon rail);
 *  2. the extra panels and the message gutter are gone from the layout.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')

const noop = () => {}
const off = () => noop
const thread = {
  id: 't1',
  title: 'Сделай мод про снег',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  workspace: '/ws/demo',
  model: 'deepseek-flash',
  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
  todos: []
}
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
    settings: { get: async () => ({ locale: 'ru' }), set: async () => ({}), onChanged: off },
    threads: { list: async () => [thread], save: async () => {}, delete: async () => {}, clearAll: async () => {} },
    agent: { run: async () => ({ ok: true }), onEvent: off, stop: async () => {}, approve: async () => {}, vote: async () => {}, steer: async () => {} },
    fs: { list: async () => [], read: async () => ({ content: '' }), onChanged: off, watch: noop, pickFolder: async () => null, pickFiles: async () => [] },
    notes: { list: async () => [] },
    terminal: { onData: off, onExit: off },
    git: { status: async () => ({ branch: 'main', ahead: 0, behind: 0, files: [] }) },
    checkpoints: { list: async () => [] }
  }
}
globalThis.document = {
  documentElement: { style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' }, dataset: {} },
  hasFocus: () => true,
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => []
}
globalThis.localStorage = window.localStorage

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { useStore } = await import(pathToFileURL(path.join(root, 'src/renderer/src/store.ts')).href)
const { Sidebar } = await import(pathToFileURL(path.join(root, 'src/renderer/src/components/Sidebar.tsx')).href)

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
console.log('calm layout:')

// react-dom/server has no store to subscribe to and falls back to zustand's
// *initial* snapshot, which is the boot state. Read the live state instead: the
// components, the store and the markup are all the real ones.
React.useSyncExternalStore = (_sub, get) => get()

const render = () => {
  const el = React.createElement(Sidebar)
  return renderToStaticMarkup(el)
}

/* 1. names, not icons ------------------------------------------------ */
// the test reads the Russian labels, as the user's own screenshots do
useStore.setState({ settings: { ...useStore.getState().settings, locale: 'ru' } })
useStore.setState({ sidebarOpen: true, sidebarSection: 'threads' })
let html = render()
for (const label of ['Сессии', 'Проводник', 'Поиск', 'Контроль версий', 'Настройки']) {
  check(`the sidebar says "${label}" in words`, html.includes(label), html.slice(0, 400))
}
check('there is no icon-only rail any more', !/class="sb-tab/.test(html), html.slice(0, 300))
check('the open/close control is a real button in the header', html.includes('sb-tool'))
check('the session list is the body of "Сессии"', html.includes('thread-row') && html.includes('Сделай мод про снег'))

/* 2. a click switches the body -------------------------------------- */
useStore.setState({ sidebarSection: 'files' })
html = render()
check('picking "Проводник" swaps the body to the file tree', !html.includes('thread-row'))
check('and marks the chosen row', /data-active="true"/.test(html))

/* 3. the panel behind the sidebar is gone --------------------------- */
check('the right-hand plan panel is removed from the store', !('rightPanel' in useStore.getState()))

/* 4. a message has no avatar and no spine --------------------------- */
const css = require('node:fs').readFileSync(path.join(root, 'src/renderer/src/styles/app.css'), 'utf8')
check('no gutter/spine rules left in the stylesheet', !/\.msg-(gutter|spine|avatar)/.test(css))
check('the transcript is one column of readable width', /\.messages\s*\{[^}]*max-width/.test(css))
check('the title bar is part of the page, not a filled strip', /\.titlebar\s*\{[^}]*background: var\(--bg-0\)/.test(css))

console.log(`\ncalm layout: ${pass + fail} checks, ${pass} passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)
