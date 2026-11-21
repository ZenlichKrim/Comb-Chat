import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Menu, Notification } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  Checkpoint,
  RunRequest,
  Settings,
  TerminalDataEvent,
  Thread,
  PtyCreateOptions
} from '../shared/types'
import * as store from './store'
import * as fsops from './fsops'
import { runTeam, stopRun, resolveApproval, answerVote, steerRun } from './agent'
import { describeFile, getSummaries } from './describe'
import { testApiKey } from './llm'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal, killAllTerminals } from './terminal'

const isDev = !!process.env.ELECTRON_RENDERER_URL
let mainWindow: BrowserWindow | null = null

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow(): void {
  const iconPath = path.join(__dirname, '../../resources/icon.png')
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0c0b09',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (!isDev) mainWindow?.focus()
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep external links outside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://') && !url.startsWith('devtools')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => mainWindow?.webContents.send('ui:command', 'settings') },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('ui:command', 'open-folder') },
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('ui:command', 'new-chat') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send('ui:command', 'palette') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('ui:command', 'settings') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow?.webContents.send('ui:command', 'undo')
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => mainWindow?.webContents.send('ui:command', 'redo')
        },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find in File',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('ui:command', 'find')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ */
/* Git helpers                                                         */
/* ------------------------------------------------------------------ */

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_PAGER: 'cat' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` })
    })
  })
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  /* app */
  ipcMain.handle('app:info', async () => ({
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    homedir: os.homedir(),
    userData: app.getPath('userData')
  }))
  ipcMain.on('app:minimize', () => mainWindow?.minimize())
  ipcMain.on('app:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('app:close', () => mainWindow?.close())
  ipcMain.handle('app:isMaximized', () => mainWindow?.isMaximized() ?? false)
  ipcMain.on('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  ipcMain.on('app:showItemInFolder', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('app:openPath', (_e, p: string) => shell.openPath(p))

  /* settings */
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    const next = await store.setSettings(patch)
    nativeTheme.themeSource = 'dark'
    return next
  })
  store.onSettingsChanged((s) => mainWindow?.webContents.send('settings:changed', s))

  /* threads */
  ipcMain.handle('threads:list', () => store.listThreads())
  ipcMain.handle('threads:save', (_e, t: Thread) => store.saveThread(t))
  ipcMain.handle('threads:delete', (_e, id: string) => store.deleteThread(id))
  ipcMain.handle('threads:clearAll', () => store.clearThreads())

  /* filesystem */
  ipcMain.handle('fs:pickFolder', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('fs:pickFiles', async () => {
    if (!mainWindow) return []
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('fs:list', (_e, dir: string) => fsops.listDir(dir))
  ipcMain.handle('files:describe', async (_e, abs: string, ctx?: { task?: string }) => {
    try {
      return { ok: true, summary: await describeFile(abs, ctx || {}) }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
  ipcMain.handle('files:summaries', (_e, paths: string[]) => getSummaries(paths))
  ipcMain.handle('fs:readImage', async (_e, file: string) => {
    try {
      return { ok: true, dataUrl: await fsops.readImageDataUrl(file) }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })
  ipcMain.handle('fs:tree', async (_e, root: string, depth = 2) => {
    const out: any[] = []
    const walk = async (dir: string, d: number): Promise<void> => {
      if (d < 0) return
      const entries = await fsops.listDir(dir, root)
      for (const e of entries) {
        out.push(e)
        if (e.isDir && !e.ignored && d > 0) await walk(e.path, d - 1)
      }
    }
    await walk(root, depth)
    return out
  })
  ipcMain.handle('fs:read', (_e, p: string) => fsops.readFileSafe(p))
  ipcMain.handle('fs:write', (_e, p: string, content: string) => fsops.writeFileSafe(p, content))
  ipcMain.handle('fs:create', async (_e, p: string, isDir: boolean) => {
    if (isDir) await fs.mkdir(p, { recursive: true })
    else {
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, '')
    }
  })
  ipcMain.handle('fs:rename', (_e, from: string, to: string) => fs.rename(from, to))
  ipcMain.handle('fs:remove', (_e, p: string) => fs.rm(p, { recursive: true, force: true }))
  ipcMain.handle('fs:exists', async (_e, p: string) => {
    try {
      await fs.stat(p)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('fs:search', (_e, root: string, query: string, opts: any) => fsops.searchText(root, query, opts))
  ipcMain.handle('fs:findFiles', (_e, root: string, query: string, opts: any) => fsops.findFiles(root, query, opts))
  ipcMain.handle('fs:watch', (_e, root: string, id: string) => {
    fsops.watchRoot(root, id, (r, paths) => mainWindow?.webContents.send('fs:changed', { root: r, paths }))
  })
  ipcMain.handle('fs:unwatch', (_e, id: string) => fsops.unwatchRoot(id))

  /* git */
  ipcMain.handle('git:status', async (_e, root: string) => {
    const check = await git(['rev-parse', '--is-inside-work-tree'], root)
    if (!check.ok || !check.out.trim().startsWith('true')) {
      return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [], log: [] }
    }
    const branchRaw = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    const branch = branchRaw.out.trim()
    const statusRaw = await git(['status', '--porcelain=v1', '--untracked-files=all'], root)
    const files = statusRaw.out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ index: line[0], worktree: line[1], path: line.slice(3).trim() }))
      .filter((f) => f.index !== '!' && !f.path.startsWith('.git/'))
    let ahead = 0
    let behind = 0
    const rev = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], root)
    if (rev.ok) {
      const [b, a] = rev.out.trim().split(/\s+/).map(Number)
      behind = b || 0
      ahead = a || 0
    }
    const logRaw = await git(['log', '-12', '--pretty=%h\u0001%s\u0001%ad', '--date=short'], root)
    const log = logRaw.ok
      ? logRaw.out
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [hash, subject, date] = l.split('\u0001')
            return { hash, subject, date }
          })
      : []
    return { isRepo: true, branch, ahead, behind, files, log }
  })
  ipcMain.handle('git:diff', async (_e, root: string, p: string) => {
    const tracked = await git(['diff', '--', p], root)
    if (tracked.out.trim()) return tracked.out
    const staged = await git(['diff', '--cached', '--', p], root)
    if (staged.out.trim()) return staged.out
    // untracked file: diff against empty
    try {
      const content = await fs.readFile(path.join(root, p), 'utf8')
      return content
        .split('\n')
        .map((l) => `+${l}`)
        .join('\n')
    } catch {
      return ''
    }
  })
  ipcMain.handle('git:commit', async (_e, root: string, message: string, paths?: string[]) => {
    if (paths?.length) await git(['add', '--', ...paths], root)
    else await git(['add', '-A'], root)
    return git(['commit', '-m', message], root)
  })
  ipcMain.handle('git:init', (_e, root: string) => git(['init'], root))
  ipcMain.handle('git:stage', (_e, root: string, paths: string[]) => git(['add', '--', ...paths], root))
  ipcMain.handle('git:unstage', (_e, root: string, paths: string[]) => git(['reset', 'HEAD', '--', ...paths], root))
  ipcMain.handle('git:checkout', (_e, root: string, p: string) => git(['checkout', '--', p], root))

  /* agent */
  /**
   * Which session an event belongs to.
   *
   * The renderer knows the run id it started, but a run is a family of ids:
   * `run:build`, `run:review`, `run:goal3`. Stamping the session here — where the
   * run was started and the request is in hand — means the renderer never has to
   * guess, and a stage can never surface in the wrong conversation.
   */
  const runThreads = new Map<string, string>()
  const threadOfRun = (runId: string): string | undefined => {
    const exact = runThreads.get(runId)
    if (exact) return exact
    const base = [...runThreads.keys()].find((k) => runId.startsWith(`${k}:`))
    return base ? runThreads.get(base) : undefined
  }
  const emit = (e: AgentEvent): void => {
    const threadId = e.threadId || threadOfRun(e.runId) || runThreads.get(e.type === 'run-start' ? e.runId : '')
    mainWindow?.webContents.send('agent:event', threadId ? { ...e, threadId } : e)
    // Native toast for the things worth interrupting someone for. Clicking it
    // brings the window back instead of leaving them hunting for it.
    if (e.type === 'notify' && Notification.isSupported()) {
      try {
        const n = new Notification({ title: e.title, body: e.body, urgency: e.urgent ? 'critical' : 'normal' })
        n.on('click', () => {
          if (!mainWindow) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        })
        n.show()
      } catch {
        /* notifications are best-effort: no tray, no server, no problem */
      }
    }
  }
  ipcMain.handle('agent:run', async (_e, req: RunRequest) => {
    // approvals are dispatched by the agent loop through agent.ts' resolver;
    // the renderer answers via the 'agent:approve' channel below.
    // the team, not a single agent: author -> builder -> author review
    runThreads.set(req.runId, req.threadId)
    try {
      return await runTeam(req, {
        emit,
        requestApproval: async () => 'deny'
      })
    } finally {
      // keep the mapping a moment past the end: the last events of a run are
      // emitted while it unwinds, and dropping the key first would unplace them
      setTimeout(() => runThreads.delete(req.runId), 60_000)
    }
  })
  ipcMain.handle('agent:approve', (_e, runId: string, callId: string, decision: 'allow' | 'allow-always' | 'deny') => {
    resolveApproval(runId, callId, decision)
  })
  ipcMain.handle('agent:stop', (_e, runId: string) => stopRun(runId))
  // a vote answer can arrive while the run is going: it is delivered in-place
  ipcMain.handle('agent:vote', (_e, runId: string, voteId: string, answer: string) => answerVote(runId, voteId, answer))
  // "не трогай сайдбар" typed while the agent is mid-run
  ipcMain.handle('agent:steer', (_e, runId: string, note: string) => steerRun(runId, note))
  ipcMain.on('app:attention', (_e, on: boolean, label?: string) => {
    if (!mainWindow) return
    mainWindow.setProgressBar(on ? 2 : -1)
    if (on && !mainWindow.isFocused()) mainWindow.flashFrame(true)
    else if (!on) mainWindow.flashFrame(false)
    void label
  })
  ipcMain.handle('agent:testKey', (_e, key: string, baseUrl: string) => testApiKey(key, baseUrl))

  /* terminal */
  const termData = (e: TerminalDataEvent): void => mainWindow?.webContents.send('terminal:data', e)
  ipcMain.handle('terminal:create', (_e, opts: PtyCreateOptions) => {
    const settings = store.getSettings()
    void settings
    return createTerminal(
      opts,
      (data) => termData({ id: opts.id, data }),
      (code) => mainWindow?.webContents.send('terminal:exit', { id: opts.id, code })
    )
  })
  ipcMain.on('terminal:write', (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.on('terminal:kill', (_e, id: string) => killTerminal(id))

  /* checkpoints */
  ipcMain.handle('checkpoints:list', (_e, threadId: string) => store.listCheckpoints(threadId))
  ipcMain.handle('checkpoints:create', async (_e, threadId: string, label: string, rels: string[], workspace: string) => {
    const cp: Checkpoint = { id: randomUUID(), threadId, label, createdAt: Date.now(), files: [] }
    for (const rel of rels) {
      try {
        const content = await fs.readFile(path.join(workspace, rel), 'utf8')
        cp.files.push({ rel, content })
      } catch {
        cp.files.push({ rel, content: null })
      }
    }
    await store.saveCheckpoint(cp)
    return cp
  })
  ipcMain.handle('checkpoints:restore', async (_e, id: string) => {
    const cp = await store.getCheckpoint(id)
    if (!cp) return { ok: false, restored: [] }
    const settings = await store.getSettings()
    const workspace = settings.lastWorkspace
    if (!workspace) return { ok: false, restored: [] }
    const restored: string[] = []
    for (const f of cp.files) {
      const abs = path.join(workspace, f.rel)
      try {
        if (f.content === null) await fs.rm(abs, { force: true })
        else {
          await fs.mkdir(path.dirname(abs), { recursive: true })
          await fs.writeFile(abs, f.content, 'utf8')
        }
        restored.push(f.rel)
      } catch {
        /* skip */
      }
    }
    return { ok: true, restored }
  })

  /* clipboard */
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  /* theme */
  ipcMain.on('window:setTheme', (_e, theme: string, accent: string) => {
    void accent
    // The paper theme is a light surface: native menus, dialogs and the window
    // frame must follow it, or the app looks like a light page in a dark shell.
    const light = theme === 'paper' || theme === 'light'
    nativeTheme.themeSource = light ? 'light' : 'dark'
    if (mainWindow && process.platform !== 'darwin') {
      mainWindow.setBackgroundColor(light ? '#ffffff' : '#100e0c')
    }
  })
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const bootSettings = await store.getSettings()
    nativeTheme.themeSource = bootSettings.theme === 'light' || bootSettings.theme === 'paper' ? 'light' : 'dark'
    const settings = bootSettings
    if (!settings.apiKey && !process.env.COMB_NO_ONBOARD) {
      /* first run: renderer shows onboarding */
    }
    registerIpc()
    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  killAllTerminals()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killAllTerminals()
})

process.on('uncaughtException', (err) => {
  console.error('[comb] uncaught', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[comb] unhandledRejection', err)
})
