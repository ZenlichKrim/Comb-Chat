/**
 * A static picture of the app, built from the real components.
 *
 * There is no browser in CI, so the only way to look at the window is to render
 * the same React tree to markup and put the real stylesheet next to it. The
 * output (docs/preview.html) is what the layout actually produces.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
const noop = () => {}
const off = () => noop
const now = Date.now()
const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 }
const msg = (o) => ({ id: Math.random().toString(36).slice(2), createdAt: now, ...o })
const thread = {
  id: 't1',
  title: 'Сделай мод про снег',
  createdAt: now - 15 * 60_000,
  updatedAt: now - 15 * 60_000,
  workspace: '/home/dev/projects/minecraft',
  model: 'deepseek-flash',
  usage,
  todos: [],
  messages: [
    msg({ role: 'user', content: 'Добавь в мод зимнюю погоду: снег и мороз.' }),
    msg({
      role: 'assistant',
      content:
        'Посмотрел структуру мода и добавил снег.\n\n`winter/Weather.java` — новый класс погоды: снег идёт, когда температура ниже нуля.\n\n`winter/Registry.java` — погода зарегистрирована в общем списке.',
      reasoning: 'Сначала читаю структуру, потом пишу погоду.',
      tools: [
        { id: 'c1', name: 'read_file', status: 'ok', args: { path: 'src/main/java/winter/Registry.java' }, output: '…' },
        { id: 'c2', name: 'write_file', status: 'ok', args: { path: 'src/main/java/winter/Weather.java' }, output: 'ok' }
      ]
    })
  ]
}
const other = (title, mins) => ({ ...thread, id: title, title, updatedAt: now - mins * 60_000, messages: [] })

const settings = {
  locale: 'ru',
  theme: 'light',
  model: 'deepseek-flash',
  fontSize: 13,
  uiScale: 1,
  accent: 'auto',
  capabilities: { edit: 'auto', run: 'auto' },
  autoContext: true,
  sendOnEnter: true,
  apiKey: 'sk-test',
  bottomPanel: 'none'
}

globalThis.window = {
  confirm: () => false,
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: noop,
  innerWidth: 1440,
  innerHeight: 880,
  localStorage: { getItem: () => null, setItem: noop },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  comb: {
    app: { platform: 'linux', version: '2.0.0', electron: '32', node: '20', getInfo: async () => ({}), attention: noop, setTheme: noop, onMaximized: off, isMaximized: async () => false, showItemInFolder: noop },
    window: { setTheme: noop, setTitle: noop, onCommand: off },
    ui: { onCommand: off },
    settings: { get: async () => settings, set: async () => settings, onChanged: off },
    threads: { list: async () => [thread, other('Привет, напиши что-нибудь', 15), other('Сделай карту для игры', 180)], save: async () => {}, delete: async () => {}, clearAll: async () => {} },
    agent: { run: async () => ({ ok: true }), onEvent: off, stop: async () => {}, approve: async () => {}, vote: async () => {}, steer: async () => {} },
    fs: { list: async () => [], read: async () => ({ content: '' }), onChanged: off, watch: noop, pickFolder: async () => null, pickFiles: async () => [], readImage: async () => ({ ok: false }) },
    notes: { list: async () => [] },
    terminal: { onData: off, onExit: off },
    git: { status: async () => ({ isRepo: true, branch: 'main', ahead: 0, behind: 0, files: [] }) },
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
React.useSyncExternalStore = (_sub, get) => get()

const { useStore } = await import(pathToFileURL(path.join(root, 'src/renderer/src/store.ts')).href)
await useStore.getState().boot()
useStore.getState().settings.locale = 'ru'
useStore.setState({
  settings: { ...useStore.getState().settings, ...settings },
  sidebarOpen: true,
  sidebarSection: 'files',
  workspace: thread.workspace,
  threads: [thread, other('Привет, напиши что-нибудь', 15), other('Сделай карту для игры', 180)],
  activeThreadId: 't1',
  ready: true
})

// The editor and the terminal pull in xterm, which needs a browser. The window
// as it looks the moment you open it has neither of them: title bar, sidebar,
// conversation, status line.
const load = async (f) => import(pathToFileURL(path.join(root, 'src/renderer/src/components', f)).href)
const { TitleBar } = await load('TitleBar.tsx')
const { Sidebar } = await load('Sidebar.tsx')
const { ChatPane } = await load('Chat.tsx')
const { StatusBar } = await load('StatusBar.tsx')
const e = React.createElement
let body = ''
try {
  body = renderToStaticMarkup(
    e('div', { className: 'app' }, e(TitleBar), e('div', { className: 'app-body' }, e(Sidebar), e('div', { className: 'workspace-area' }, e(ChatPane))), e(StatusBar))
  )
} catch (err) {
  console.error('render failed:', err.stack)
  process.exit(1)
}

const css = ['theme.css', 'base.css', 'app.css', 'markdown.css']
  .map((f) => fs.readFileSync(path.join(root, 'src/renderer/src/styles', f), 'utf8'))
  .join('\n')

const html = `<!doctype html>
<html lang="ru" data-theme="light">
<head><meta charset="utf-8"><title>Comb — предпросмотр</title>
<style>${css}</style>
<style>html,body,#root{height:100%;margin:0}</style>
</head>
<body><div id="root">${body}</div></body></html>`

fs.writeFileSync(path.join(root, 'docs/preview.html'), html)
console.log('preview written:', path.join(root, 'docs/preview.html'), `${(html.length / 1024).toFixed(0)} KB`)
