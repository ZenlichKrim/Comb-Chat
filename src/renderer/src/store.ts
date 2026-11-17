import { create } from 'zustand'
import { tr } from './lib/i18n'
import type { DictKey } from '../../shared/i18n'
import type {
  AgentEvent,
  Attachment,
  ChatMessage,
  Checkpoint,
  DirEntry,
  GitStatus,
  RunRequest,
  Settings,
  Thread,
  ToolResultView,
  TokenUsage,
  TodoItem,
  FileContent
} from '../../shared/types'
import { DEFAULT_SETTINGS, MODELS } from '../../shared/types'

let idCounter = 0
export function uid(prefix = 'id'): string {
  idCounter++
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export interface OpenTab {
  path: string
  rel: string
  language: string
  content: string
  original: string
  dirty: boolean
  mtime: number
  cursor?: { line: number; ch: number }
  view?: 'editor' | 'diff'
}

export interface Toast {
  id: string
  kind: 'info' | 'ok' | 'warn' | 'err'
  text: string
  detail?: string
}

export interface PaletteState {
  open: boolean
  mode: 'commands' | 'files' | 'symbols'
}

export type BottomPanel = 'terminal' | 'problems' | 'output' | 'git'
export type RightPanel = 'plan' | 'context' | 'history' | 'none'

interface State {
  ready: boolean
  settings: Settings
  threads: Thread[]
  activeThreadId: string | null
  workspace: string | null
  /** extra folders attached to the current session */
  extraRoots: string[]
  tabs: OpenTab[]
  activeTabPath: string | null
  expandedDirs: Set<string>
  dirCache: Record<string, DirEntry[]>
  git: GitStatus | null
  sidebarOpen: boolean
  rightPanel: RightPanel
  bottomPanel: BottomPanel | 'none'
  bottomPanelHeight: number
  palette: PaletteState
  running: boolean
  runId: string | null
  streamingMessageId: string | null
  pendingApproval: ToolResultView | null
  /** what the agent is doing right now, derived from the live tool stream */
  activity: { step: number; label: string; since: number } | null
  approvalRunId: string | null
  toasts: Toast[]
  searchOpen: boolean
  aboutOpen: boolean
  checkpoints: Checkpoint[]
  diffPreview: { path: string; rel: string; before: string; after: string; kind: string } | null
  /** file the agent handed over, shown in a preview modal */
  filePreview: { path: string; rel: string; note?: string } | null
  /** model-written one-liners, by absolute path */
  fileSummaries: Record<string, string>
  changedFiles: string[]
  sidebarSection: 'files' | 'search' | 'git' | 'threads'
  commandHistory: string[]
  contextFiles: Attachment[]
  showShortcuts: boolean
  settingsOpen: boolean
  sidebarDensity: 'compact' | 'comfortable'
}

interface Actions {
  boot: () => Promise<void>
  setSettings: (patch: Partial<Settings>) => Promise<void>
  openWorkspace: (dir?: string) => Promise<void>
  /** Attach another folder the agent may read and write, alongside the main one. */
  addRoot: () => Promise<void>
  removeRoot: (dir: string) => Promise<void>
  refreshTree: (dir?: string) => Promise<void>
  toggleDir: (dir: string) => Promise<void>
  openFile: (path: string, rel: string, opts?: { reuse?: boolean }) => Promise<void>
  closeTab: (path: string) => void
  setTabContent: (path: string, content: string) => void
  saveTab: (path?: string) => Promise<void>
  saveAllTabs: () => Promise<void>
  setActiveTab: (path: string) => void
  newThread: () => void
  selectThread: (id: string) => void
  deleteThread: (id: string) => Promise<void>
  renameThread: (id: string, title: string) => void
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>
  stopRun: () => Promise<void>
  approve: (decision: 'allow' | 'allow-always' | 'deny') => Promise<void>
  handleEvent: (e: AgentEvent) => void
  refreshGit: () => Promise<void>
  toast: (kind: Toast['kind'], text: string, detail?: string) => void
  dismissToast: (id: string) => void
  setPalette: (p: Partial<PaletteState>) => void
  setBottomPanel: (p: BottomPanel | 'none') => void
  setRightPanel: (p: RightPanel) => void
  addContextFile: (a: Attachment) => void
  removeContextFile: (id: string) => void
  setActiveThreadTodos: (todos: TodoItem[]) => void
  restoreCheckpoint: (id: string) => Promise<void>
  undoLastRun: () => Promise<void>
  setDiffPreview: (d: State['diffPreview']) => void
  setFilePreview: (d: State['filePreview']) => void
  loadSummaries: (paths: string[]) => Promise<void>
  describeFileNow: (abs: string) => Promise<void>
  closeDiff: () => void
  persistThread: (t: Thread) => void
}

const MAX_HISTORY = 200

function trimThread(t: Thread): Thread {
  return { ...t, messages: t.messages.slice(-MAX_HISTORY) }
}

export const useStore = create<State & Actions>((set, get) => ({
  ready: false,
  settings: { ...DEFAULT_SETTINGS },
  threads: [],
  activeThreadId: null,
  workspace: null,
  extraRoots: [],
  tabs: [],
  activeTabPath: null,
  expandedDirs: new Set(),
  dirCache: {},
  git: null,
  sidebarOpen: true,
  rightPanel: 'plan',
  bottomPanel: 'none',
  bottomPanelHeight: 240,
  palette: { open: false, mode: 'commands' },
  running: false,
  runId: null,
  streamingMessageId: null,
  pendingApproval: null,
  activity: null,
  approvalRunId: null,
  toasts: [],
  searchOpen: false,
  settingsOpen: false,
  aboutOpen: false,
  checkpoints: [],
  diffPreview: null,
  filePreview: null,
  fileSummaries: {},
  changedFiles: [],
  sidebarSection: 'files',
  commandHistory: [],
  contextFiles: [],
  showShortcuts: false,
  sidebarDensity: 'compact',

  /* ---------------------------------------------------------------- */
  boot: async () => {
    const [settings, threads] = await Promise.all([window.comb.settings.get(), window.comb.threads.list()])
    const sorted = (threads as Thread[]).sort((a, b) => b.updatedAt - a.updatedAt)
    set({ settings, threads: sorted, ready: true, activeThreadId: sorted[0]?.id ?? null })
    applyTheme(settings)
    if (settings.lastWorkspace) {
      await get().openWorkspace(settings.lastWorkspace).catch(() => {})
    }
    window.comb.settings.onChanged((s) => {
      set({ settings: s as Settings })
      applyTheme(s as Settings)
    })
    window.comb.agent.onEvent((e) => get().handleEvent(e as AgentEvent))
    window.comb.fs.onChanged(async (ev) => {
      const e = ev as { root: string; paths: string[] }
      // refresh the affected directory listing + reload clean tabs
      const dirs = new Set<string>()
      for (const p of e.paths) {
        const dir = p.replace(/[\\/][^\\/]*$/, '')
        dirs.add(dir)
      }
      for (const d of dirs) await get().refreshTree(d).catch(() => {})
      const { tabs, workspace } = get()
      for (const tab of tabs) {
        const abs = tab.path
        if (!e.paths.some((p) => abs.endsWith(p) || p.endsWith(abs))) continue
        if (tab.dirty) continue
        try {
          const fc = (await window.comb.fs.read(abs)) as FileContent
          if (fc.content !== tab.content) {
            set((s) => ({
              tabs: s.tabs.map((t) => (t.path === abs && !t.dirty ? { ...t, content: fc.content, original: fc.content, mtime: fc.mtime } : t))
            }))
          }
        } catch {
          /* deleted */
        }
      }
      if (workspace) void get().refreshGit()
    })
  },

  setSettings: async (patch) => {
    const next = (await window.comb.settings.set(patch)) as Settings
    set({ settings: next })
    applyTheme(next)
  },

  /* ---------------------------------------------------------------- */
  openWorkspace: async (dir) => {
    const target = dir || ((await window.comb.fs.pickFolder()) as string | null)
    if (!target) return
    set({ workspace: target, extraRoots: [], dirCache: {}, expandedDirs: new Set(), diffPreview: null })
    await get().setSettings({ lastWorkspace: target })
    window.comb.fs.watch(target, 'workspace')
    await get().refreshTree(target)
    await get().refreshGit()
    get().toast('ok', tr('store.workspaceOpened'), target)
  },

  addRoot: async () => {
    const dir = (await window.comb.fs.pickFolder()) as string | null
    if (!dir) return
    const main = get().workspace
    if (main && (dir === main || dir.startsWith(main + '/') || dir.startsWith(main + '\\'))) {
      get().toast('warn', tr('store.rootIsInside'))
      return
    }
    if (get().extraRoots.includes(dir)) return
    const roots = [...get().extraRoots, dir]
    set({ extraRoots: roots, dirCache: {} })
    await get().setSettings({ extraRoots: roots })
    window.comb.fs.watch(dir, `root:${dir}`)
    await get().refreshTree(dir)
    get().toast('ok', tr('store.rootAdded'), dir)
  },

  removeRoot: async (dir) => {
    const roots = get().extraRoots.filter((r) => r !== dir)
    set({ extraRoots: roots })
    await get().setSettings({ extraRoots: roots })
    get().toast('ok', tr('store.rootRemoved'), dir)
  },

  refreshTree: async (dir) => {
    const root = get().workspace
    if (!root) return
    const target = dir || root
    try {
      const entries = (await window.comb.fs.list(target)) as DirEntry[]
      set((s) => ({ dirCache: { ...s.dirCache, [target]: entries } }))
    } catch (e: any) {
      get().toast('err', tr('store.cannotRead'), e?.message)
    }
  },

  toggleDir: async (dir) => {
    const expanded = new Set(get().expandedDirs)
    if (expanded.has(dir)) expanded.delete(dir)
    else {
      expanded.add(dir)
      await get().refreshTree(dir)
    }
    set({ expandedDirs: expanded })
  },

  openFile: async (path, rel) => {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      set({ activeTabPath: path })
      return
    }
    try {
      const fc = (await window.comb.fs.read(path)) as FileContent
      const tab: OpenTab = {
        path,
        rel,
        language: fc.language,
        content: fc.content,
        original: fc.content,
        dirty: false,
        mtime: fc.mtime,
        view: 'editor'
      }
      set((s) => ({ tabs: [...s.tabs, tab], activeTabPath: path }))
    } catch (e: any) {
      get().toast('err', tr('store.cannotOpen'), e?.message)
    }
  },

  closeTab: (path) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path)
      const tabs = s.tabs.filter((t) => t.path !== path)
      let active = s.activeTabPath
      if (active === path) active = tabs[Math.max(0, idx - 1)]?.path ?? null
      return { tabs, activeTabPath: active }
    })
  },

  setTabContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, content, dirty: content !== t.original } : t))
    }))
  },

  saveTab: async (path) => {
    const target = path || get().activeTabPath
    const tab = get().tabs.find((t) => t.path === target)
    if (!tab) return
    try {
      const res = await window.comb.fs.write(tab.path, tab.content)
      set((s) => ({
        tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, original: t.content, dirty: false, mtime: (res as any).mtime } : t))
      }))
    } catch (e: any) {
      get().toast('err', tr('store.saveFailed'), e?.message)
    }
  },

  saveAllTabs: async () => {
    for (const t of get().tabs) if (t.dirty) await get().saveTab(t.path)
  },

  setActiveTab: (path) => set({ activeTabPath: path, diffPreview: null }),

  /* ---------------------------------------------------------------- */
  newThread: () => {
    const thread: Thread = {
      id: uid('th'),
      title: 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      workspace: get().workspace,
      extraRoots: get().extraRoots,
      model: get().settings.model,
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
      todos: []
    }
    set((s) => ({ threads: [thread, ...s.threads], activeThreadId: thread.id, changedFiles: [] }))
    void window.comb.threads.save(thread)
  },

  selectThread: (id) => {
    set({ activeThreadId: id, changedFiles: [], pendingApproval: null })
    const t = get().threads.find((x) => x.id === id)
    if (t) set({ checkpoints: [] })
  },

  deleteThread: async (id) => {
    await window.comb.threads.delete(id)
    set((s) => {
      const threads = s.threads.filter((t) => t.id !== id)
      return { threads, activeThreadId: s.activeThreadId === id ? (threads[0]?.id ?? null) : s.activeThreadId }
    })
  },

  renameThread: (id, title) => {
    set((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, title, updatedAt: Date.now() } : t)) }))
    const t = get().threads.find((x) => x.id === id)
    if (t) get().persistThread(t)
  },

  persistThread: (t) => {
    void window.comb.threads.save(trimThread(t))
  },

  /* ---------------------------------------------------------------- */
  sendMessage: async (text, attachments = []) => {
    const state = get()
    if (state.running) return
    let threadId = state.activeThreadId
    if (!threadId) {
      const thread: Thread = {
        id: uid('th'),
        title: text.slice(0, 60) || 'New session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        workspace: state.workspace,
        model: state.settings.model,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
        todos: []
      }
      set((s) => ({ threads: [thread, ...s.threads], activeThreadId: thread.id }))
      threadId = thread.id
    }
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return

    const userMsg: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      attachments: attachments.length ? attachments : undefined
    }
    const assistantMsg: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: '',
      reasoning: '',
      createdAt: Date.now(),
      model: get().settings.model,
      tools: [],
      streaming: true
    }
    const title = thread.messages.length === 0 ? text.replace(/\s+/g, ' ').trim().slice(0, 64) || 'New session' : thread.title
    const updated: Thread = {
      ...thread,
      title,
      messages: [...thread.messages, userMsg, assistantMsg],
      updatedAt: Date.now(),
      workspace: get().workspace,
      extraRoots: get().extraRoots,
      model: get().settings.model
    }
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? updated : t)),
      running: true,
      runId: uid('run'),
      streamingMessageId: assistantMsg.id,
      changedFiles: [],
      pendingApproval: null,
      contextFiles: []
    }))
    get().persistThread(updated)

    const runId = get().runId!
    const settings = get().settings
    const req: RunRequest = {
      runId,
      threadId: threadId!,
      messageId: assistantMsg.id,
      workspace: get().workspace,
      extraRoots: get().extraRoots,
      fullDiskAccess: settings.fullDiskAccess,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      approvalPolicy: settings.approvalPolicy,
      maxSteps: settings.maxAgentSteps,
      autoContext: settings.autoContext,
      describeFiles: settings.describeFiles,
      customInstructions: settings.customInstructions,
      history: thread.messages,
      userMessage: userMsg,
      attachments,
      openFiles: get().tabs.map((t) => ({ rel: t.rel, path: t.path })),
      disabledTools: []
    }
    const res = await window.comb.agent.run(req)
    if (res && !res.ok) {
      set({ running: false })
    }
  },

  stopRun: async () => {
    const id = get().runId
    if (id) await window.comb.agent.stop(id)
  },

  approve: async (decision) => {
    const call = get().pendingApproval
    const runId = get().approvalRunId
    if (!call || !runId) return
    set({ pendingApproval: null })
    await window.comb.agent.approve(runId, call.id, decision)
  },

  /* ---------------------------------------------------------------- */
  handleEvent: (e) => {
    const state = get()
    const threadId = state.activeThreadId
    if (!threadId) return

    const updateAssistant = (fn: (m: ChatMessage) => ChatMessage): void => {
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: t.messages.map((m) => (m.id === s.streamingMessageId || m.streaming ? fn(m) : m))
              }
            : t
        )
      }))
    }

    switch (e.type) {
      case 'run-start':
        break
      case 'reasoning-delta':
        updateAssistant((m) => ({ ...m, reasoning: (m.reasoning || '') + e.text }))
        break
      case 'text-delta':
        set({ activity: { step: get().activity?.step || 1, label: tr('chat.stepWriting'), since: get().activity?.since || Date.now() } })
        updateAssistant((m) => ({ ...m, content: (m.content || '') + e.text }))
        break
      case 'step':
        set({ activity: { step: e.step, label: tr('chat.stepThinking'), since: Date.now() } })
        break
      case 'tool-call':
        set({ activity: { step: get().activity?.step || 1, label: activityLabel(e.call.name), since: Date.now() } })
        updateAssistant((m) => {
          const tools = m.tools || []
          const exists = tools.some((t) => t.id === e.call.id)
          return { ...m, tools: exists ? tools.map((t) => (t.id === e.call.id ? { ...t, ...e.call } : t)) : [...tools, e.call] }
        })
        break
      case 'tool-update':
        updateAssistant((m) => ({
          ...m,
          tools: (m.tools || []).map((t) => (t.id === e.call.id ? { ...t, ...e.call } : t))
        }))
        break
      case 'tool-approval-request':
        set({ pendingApproval: e.call, approvalRunId: e.runId })
        get().toast('info', tr('chat.awaitingApproval'), e.call.name)
        // make sure the call is visible in the transcript
        updateAssistant((m) => ({
          ...m,
          tools: (m.tools || []).some((t) => t.id === e.call.id) ? m.tools : [...(m.tools || []), e.call]
        }))
        break
      case 'todos':
        set((s) => ({
          threads: s.threads.map((t) => (t.id === threadId ? { ...t, todos: e.todos, updatedAt: Date.now() } : t))
        }))
        break
      case 'usage':
        updateAssistant((m) => ({ ...m, usage: e.usage }))
        break
      case 'checkpoint':
        set((s) => ({ checkpoints: [e.checkpoint, ...s.checkpoints] }))
        break
      case 'files-changed': {
        const rels = e.paths.map((p) => {
          const ws = state.workspace || ''
          return p.startsWith(ws) ? p.slice(ws.length + 1).replace(/\\/g, '/') : p
        })
        set((s) => ({ changedFiles: [...new Set([...s.changedFiles, ...rels])] }))
        void get().refreshGit()
        void get().refreshTree()
        break
      }
      case 'file-summaries': {
        // the agent labelled the files it wrote: the explorer picks these up live
        set((s) => {
          const next = { ...s.fileSummaries }
          for (const f of e.summaries) if (f.description) next[f.path] = f.description
          return { fileSummaries: next }
        })
        break
      }
      case 'error':
        updateAssistant((m) => ({ ...m, error: e.message, streaming: false }))
        get().toast('err', tr('store.agentError'), e.message)
        break
      case 'run-end': {
        // An approval that never got answered must not vanish without a trace:
        // leave the card in the transcript marked as expired.
        const stale = get().pendingApproval
        updateAssistant((m) => ({
          ...m,
          streaming: false,
          stopped: e.reason === 'stopped',
          tools: stale
            ? (m.tools || []).map((t) => (t.id === stale.id && t.status === 'awaiting-approval' ? { ...t, status: 'expired' } : t))
            : m.tools
        }))
        set({ running: false, pendingApproval: null, activity: null })
        if (stale) get().toast('warn', tr('chat.approvalExpired'))
        const t = get().threads.find((x) => x.id === threadId)
        if (t) get().persistThread({ ...t, updatedAt: Date.now() })
        if (e.reason === 'limit') get().toast('warn', tr('store.stepLimit'), tr('store.stepLimitHint'))
        break
      }
      default:
        break
    }
  },

  /* ---------------------------------------------------------------- */
  refreshGit: async () => {
    const ws = get().workspace
    if (!ws) return set({ git: null })
    try {
      const g = (await window.comb.git.status(ws)) as GitStatus
      set({ git: g })
    } catch {
      set({ git: null })
    }
  },

  toast: (kind, text, detail) => {
    const id = uid('toast')
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, detail }].slice(-4) }))
    setTimeout(() => get().dismissToast(id), kind === 'err' ? 7000 : 3800)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setPalette: (p) => set((s) => ({ palette: { ...s.palette, ...p } })),
  setBottomPanel: (p) => set({ bottomPanel: p }),
  setRightPanel: (p) => set({ rightPanel: p }),

  addContextFile: (a) => {
    if (a.kind === 'image') {
      const m = MODELS.find((x) => x.id === get().settings.model)
      if (m && !m.vision) get().toast('warn', tr('chat.imageNotSupported'))
    }
    set((s) => ({
      contextFiles: s.contextFiles.some((c) => c.path === a.path && c.kind === a.kind && c.from === a.from)
        ? s.contextFiles
        : [...s.contextFiles, a]
    }))
  },
  removeContextFile: (id) => set((s) => ({ contextFiles: s.contextFiles.filter((c) => c.id !== id) })),

  setActiveThreadTodos: (todos) =>
    set((s) => ({
      threads: s.threads.map((t) => (t.id === s.activeThreadId ? { ...t, todos } : t))
    })),

  restoreCheckpoint: async (id) => {
    const res = (await window.comb.checkpoints.restore(id)) as { ok: boolean; restored: string[] }
    if (res.ok) {
      get().toast('ok', tr('rp.restored', { n: res.restored.length }))
      await get().refreshTree()
      for (const t of get().tabs) {
        try {
          const fc = (await window.comb.fs.read(t.path)) as FileContent
          set((s) => ({ tabs: s.tabs.map((x) => (x.path === t.path ? { ...x, content: fc.content, original: fc.content, dirty: false } : x)) }))
        } catch {
          /* skip */
        }
      }
    } else get().toast('err', tr('store.nothingToRestore'))
  },

  undoLastRun: async () => {
    const cps = get().checkpoints
    if (!cps.length) return
    await get().restoreCheckpoint(cps[0].id)
  },

  setDiffPreview: (d) => set({ diffPreview: d }),
  setFilePreview: (d) => set({ filePreview: d }),

  loadSummaries: async (paths) => {
    if (!paths.length) return
    const rows = (await window.comb.files.summaries(paths).catch(() => [])) as { path: string; description: string }[]
    if (!rows.length) return
    set((s) => {
      const next = { ...s.fileSummaries }
      for (const r of rows) next[r.path] = r.description
      return { fileSummaries: next }
    })
  },

  describeFileNow: async (abs) => {
    const res = await window.comb.files.describe(abs)
    if (res.ok && res.summary) {
      set((s) => ({ fileSummaries: { ...s.fileSummaries, [abs]: res.summary!.description } }))
      get().toast('ok', tr('store.described'), res.summary.description)
    } else {
      get().toast('err', tr('fp.describeFailed'), res.error)
    }
  },
  closeDiff: () => set({ diffPreview: null })
}))

/* ------------------------------------------------------------------ */
/* Derived selectors                                                   */
/* ------------------------------------------------------------------ */

export function useActiveThread(): Thread | null {
  return useStore((s) => s.threads.find((t) => t.id === s.activeThreadId) || null)
}

export function useActiveTab(): OpenTab | null {
  return useStore((s) => s.tabs.find((t) => t.path === s.activeTabPath) || null)
}

export function totalUsage(threads: Thread[]): TokenUsage {
  return threads.reduce(
    (acc, t) => {
      for (const m of t.messages) {
        if (m.usage) {
          acc.promptTokens += m.usage.promptTokens
          acc.completionTokens += m.usage.completionTokens
          acc.cachedTokens += m.usage.cachedTokens
          acc.cost += m.usage.cost
        }
      }
      return acc
    },
    { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 }
  )
}

export function applyTheme(s: Settings): void {
  const root = document.documentElement
  root.dataset.theme = s.theme
  root.dataset.motion = s.reducedMotion ? 'reduced' : 'full'
  root.dataset.ligatures = String(s.fontLigatures)
  // Only override the theme's own accent when the user picked one explicitly.
  // 'auto' (or a value equal to the default amber) means: follow the theme.
  if (s.accent && s.accent !== 'auto') {
    root.style.setProperty('--accent', s.accent)
  } else {
    root.style.removeProperty('--accent')
  }
  if (s.accent && s.accent !== 'auto') {
    root.style.setProperty('--accent-soft', `color-mix(in oklab, ${s.accent} 16%, transparent)`)
    root.style.setProperty('--accent-line', `color-mix(in oklab, ${s.accent} 45%, transparent)`)
  } else {
    root.style.removeProperty('--accent-soft')
    root.style.removeProperty('--accent-line')
  }
  root.style.setProperty('--fs-sm', `${s.fontSize - 1}px`)
  root.style.setProperty('--fs-md', `${s.fontSize}px`)
  root.style.setProperty('--fs-lg', `${s.fontSize + 2}px`)
  root.style.setProperty('--fs-xl', `${s.fontSize + 5}px`)
  root.style.fontSize = `${s.fontSize}px`
  root.style.zoom = String(s.uiScale || 1)
  window.comb?.window?.setTheme(s.theme, s.accent)
}

/** Human label for the live status line: what the agent is doing right now. */
export function activityLabel(tool: string): string {
  const map: Record<string, DictKey> = {
    read_file: 'tool.read',
    write_file: 'tool.write',
    edit_file: 'tool.edit',
    multi_edit: 'tool.multiEdit',
    list_dir: 'tool.list',
    glob: 'tool.glob',
    grep: 'tool.grep',
    run_command: 'tool.run',
    delete_path: 'tool.delete',
    move_path: 'tool.move',
    todo_write: 'tool.plan',
    ask_user: 'tool.ask',
    finish: 'chat.stepDone',
    attach_file: 'tool.attach_file'
  }
  return map[tool] ? tr(map[tool]) : tool
}

export function formatCost(n: number): string {
  if (!n) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(5)}`
  return `$${n.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function timeAgo(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  if (d < 604_800_000) return `${Math.floor(d / 86_400_000)}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
