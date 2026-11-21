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
  StickyNote,
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
  /** what the user typed while the agent was busy: sent, not lost */
  queued: string[]
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
  /** at least one run is in flight (the active one normally) */
  running: boolean
  runId: string | null
  /** runs in flight, by thread: two sessions can work at the same time */
  runs: Record<string, { runId: string; messageId: string }>
  streamingMessageId: string | null
  pendingApproval: ToolResultView | null
  /** what the agent is doing right now, derived from the live tool stream */
  activity: { step: number; label: string; since: number; thoughtMs?: number; role?: 'author' | 'builder' } | null
  /** who is speaking in the current run: author talks, builder works */
  activeRole: 'author' | 'builder' | null
  approvalRunId: string | null
  /** which session is waiting for the approval dialog */
  approvalThreadId: string | null
  toasts: Toast[]
  searchOpen: boolean
  aboutOpen: boolean
  checkpoints: Checkpoint[]
  diffPreview: { path: string; rel: string; before: string; after: string; kind: string } | null
  /** file the agent handed over, shown in a preview modal */
  filePreview: { path: string; rel: string; note?: string } | null
  /** the request currently in flight, shown by the "agent is working" row */
  lastPrompt: string
  /** how many times this task resumed itself after hitting the step budget */
  /** stable-mode guard notes for the current run */
  guards: { id: string; kind: string; title: string; detail?: string }[]
  /** sticky notes: project task list the agent also reads */
  notes: StickyNote[]
  /** notes panel open state */
  notesOpen: boolean
  /** set while the API call is being retried */
  retryInfo: { attempt: number; max: number; reason: string; at: number; waitMs: number } | null
  /** desktop pings this session, shown in the bell menu */
  /** a run finished / needs you while you were elsewhere: shown as an overlay */
  attention: { id: string; kind: 'done' | 'error' | 'question'; title: string; body?: string; at: number } | null
  dismissAttention: () => void
  notifications: { id: string; title: string; body: string; at: number }[]
  /** model-written one-liners, by absolute path */
  fileSummaries: Record<string, string>
  /** why each file exists, when the agent wrote it and explained itself */
  filePurposes: Record<string, string>
  changedFiles: string[]
  /** folders we already showed a read error for, so a broken root cannot spam toasts */
  errorToasted: Record<string, boolean>
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
  queueMessage: (text: string) => void
  dropQueued: (index: number) => void
  flushQueue: () => Promise<void>
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<boolean>
  stopRun: () => Promise<void>
  /** answer an agent question: records the pick and starts the next turn */
  answerVote: (answer: string) => Promise<void>
  /** answer while the run is still in flight */
  answerLiveVote: (voteId: string, answer: string) => Promise<void>
  /** say something to the running agent without stopping it */
  steer: (text: string) => Promise<boolean>
  addNote: (n: { text: string; target?: string; targetLabel?: string; tone?: number }) => void
  updateNote: (id: string, patch: Partial<StickyNote>) => void
  removeNote: (id: string) => void
  setNotesOpen: (open: boolean) => void
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

/** sessions the user deleted: in-flight events for them are dropped, not placed */
const deletedThreads = new Set<string>()

function trimThread(t: Thread): Thread {
  return { ...t, messages: t.messages.slice(-MAX_HISTORY) }
}

/** Two short tones, synthesised: recognisable, quiet, and no asset to ship. */
function chime(kind: 'done' | 'error' | 'question'): void {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const now = ctx.currentTime
    const notes = kind === 'error' ? [392, 294] : kind === 'question' ? [523, 659] : [523, 784]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const at = now + i * 0.12
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(kind === 'error' ? 0.12 : 0.09, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.3)
    })
    setTimeout(() => void ctx.close().catch(() => undefined), 900)
  } catch {
    /* audio is a nicety, not a requirement */
  }
}

/** Show the overlay only when the user is looking somewhere else. */
export function showAttention(kind: 'done' | 'error' | 'question', title: string, body?: string): void {
  const s = useStore.getState()
  if (s.settings.attentionOverlay === false) return
  if (document.hasFocus()) return
  if (s.settings.attentionSound !== false) chime(kind)
  useStore.setState({ attention: { id: `att_${Date.now()}`, kind, title, body, at: Date.now() } })
  setTimeout(() => {
    if (useStore.getState().attention?.title === title) useStore.setState({ attention: null })
  }, 12000)
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
  // shut by default: a panel full of zeros is furniture, not information
  rightPanel: 'none',
  bottomPanel: 'none',
  bottomPanelHeight: 240,
  palette: { open: false, mode: 'commands' },
  running: false,
  runId: null,
  runs: {},
  streamingMessageId: null,
  pendingApproval: null,
  queued: [],
  activity: null,
  activeRole: null,
  approvalRunId: null,
  approvalThreadId: null,
  toasts: [],
  searchOpen: false,
  settingsOpen: false,
  aboutOpen: false,
  checkpoints: [],
  diffPreview: null,
  filePreview: null,
  lastPrompt: '',
  guards: [],
  attention: null,
  notifications: [],
  retryInfo: null,
  notes: [],
  notesOpen: false,
  fileSummaries: {},
  filePurposes: {},
  changedFiles: [],
  errorToasted: {},
  sidebarSection: 'files',
  commandHistory: [],
  contextFiles: [],
  showShortcuts: false,
  sidebarDensity: 'compact',

  /* ---------------------------------------------------------------- */
  boot: async () => {
    const [settings, threads] = await Promise.all([window.comb.settings.get(), window.comb.threads.list()])
    // Old threads carry empty steps from stage announcements that used to be
    // written into the trace; they render as a stray "0". Clean on load.
    const sorted = (threads as Thread[])
      .map((t) => ({
        ...t,
        messages: (t.messages || []).map((m) =>
          m.steps?.length ? { ...m, steps: m.steps.filter((st) => !!st.say?.trim() || st.actions.length > 0) } : m
        )
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    set({
      settings,
      threads: sorted,
      ready: true,
      activeThreadId: sorted[0]?.id ?? null,
      notes: sorted[0]?.notes ?? [],
    })
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
      set((s) => {
        const flags = { ...s.errorToasted }
        delete flags[target]
        return { dirCache: { ...s.dirCache, [target]: entries }, errorToasted: flags }
      })
    } catch (e: any) {
      if (get().workspace !== root) return
      const missing = /ENOENT|no such file|cannot find/i.test(e?.message || '')
      if (missing) {
        // the folder was moved or renamed under us: stop hammering it with requests
        const state = get()
        set({ dirCache: { ...state.dirCache, [target]: [] } })
        if (target === root) {
          void get().setSettings({ lastWorkspace: null })
          set({ workspace: null, dirCache: {}, expandedDirs: new Set(), tabs: [] })
          get().toast('warn', tr('store.folderGone'), root)
        }
        return
      }
      if (get().errorToasted?.[target]) return
      set((s) => ({ errorToasted: { ...s.errorToasted, [target]: true } }))
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
      todos: [],
      notes: []
    }
    set((s) => ({ threads: [thread, ...s.threads], activeThreadId: thread.id, changedFiles: [], notes: [] }))
    void window.comb.threads.save(thread)
  },

  selectThread: (id) => {
    const thread = get().threads.find((t) => t.id === id)
    const live = get().runs[id]
    set({
      activeThreadId: id,
      changedFiles: [],
      notes: thread?.notes ?? [],
      // Switching sessions restores the live state of the one you switched to —
      // but an *approval* is not tab state. When it is answered the agent that
      // asked keeps working, and while it is unanswered that agent is blocked.
      // Clearing it on a tab switch lost the request and left a background session
      // waiting on a card nobody could see any more. So it stays, labelled with
      // the session it belongs to, until it is answered or its run ends.
      // Keep it wherever it belongs: an approval for *this* session is this
      // session's live state, an approval for another one is still owed to that
      // one. Only a run that ended clears it (in `run-end`).
      pendingApproval: get().pendingApproval,
      approvalRunId: get().approvalRunId,
      approvalThreadId: get().approvalThreadId,
      retryInfo: null,
      activity: null,
      activeRole: null,
      running: !!live,
      runId: live?.runId ?? null,
      streamingMessageId: live?.messageId ?? null
    })
    const t = get().threads.find((x) => x.id === id)
    if (t) set({ checkpoints: [] })
  },

  deleteThread: async (id) => {
    // A deleted session is deleted: its run is stopped (otherwise it keeps
    // working and its messages arrive from nowhere — the exact bug the user
    // reported), and its id is remembered so any event still in flight is dropped
    // instead of being written into the session that took its place.
    const gone = get().runs[id]?.runId
    deletedThreads.add(id)
    if (gone) void window.comb.agent.stop(gone)
    await window.comb.threads.delete(id)
    set((s) => {
      const threads = s.threads.filter((t) => t.id !== id)
      const runs = { ...s.runs }
      delete runs[id]
      return {
        threads,
        runs,
        activeThreadId: s.activeThreadId === id ? (threads[0]?.id ?? null) : s.activeThreadId,
        approvalThreadId: s.approvalThreadId === id ? null : s.approvalThreadId,
        approvalRunId: s.approvalThreadId === id ? null : s.approvalRunId,
        pendingApproval: s.approvalThreadId === id ? null : s.pendingApproval
      }
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
    // Only this session matters: another conversation may be working at the same
    // time and that is exactly what the user asked for. The old guard read one
    // window-wide flag and refused the second session with nothing on screen.
    if (state.activeThreadId && state.runs[state.activeThreadId]) return false
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
    if (!thread || get().runs[threadId]) return false

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
    const runId = uid('run')
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? updated : t)),
      running: true,
      runId,
      runs: { ...s.runs, [threadId]: { runId, messageId: assistantMsg.id } },
      streamingMessageId: assistantMsg.id,
      changedFiles: [],
      pendingApproval: null,
      retryInfo: null,
      lastPrompt: text,
      guards: [],
      contextFiles: []
    }))
    get().persistThread(updated)

    // notes written between runs are on their way now
    const pendingIds = get().notes.filter((n) => n.status === 'pending' && !n.byAgent).map((n) => n.id)
    if (pendingIds.length) {
      set((s) => ({
        notes: s.notes.map((n) => (pendingIds.includes(n.id) ? { ...n, status: 'sent', runId: get().runId || undefined } : n))
      }))
    }
    void window.comb.app.attention(true, text.slice(0, 40))
    const settings = get().settings
    const req: RunRequest = {
      runId,
      threadId: threadId!,
      messageId: assistantMsg.id,
      workspace: get().workspace,
      extraRoots: get().extraRoots,
      // YOLO (edits and commands without asking) is the promise of full access:
      // the flag travels with it, so the main process never has to guess.
      fullDiskAccess:
        settings.fullDiskAccess ||
        ((settings.capabilities || { edit: 'ask', run: 'ask' }).edit === 'auto' &&
          (settings.capabilities || { edit: 'ask', run: 'ask' }).run === 'auto'),
      model: settings.model,
      thoughtEffort: settings.thoughtEffort || 'deep',
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      approvalPolicy: settings.approvalPolicy,
      capabilities: settings.capabilities || { edit: 'ask', run: 'ask', planner: 'auto' },
      maxSteps: settings.maxAgentSteps,
      autoContext: settings.autoContext,
      describeFiles: settings.describeFiles,
      customInstructions: settings.customInstructions,
      history: thread.messages,
      userMessage: userMsg,
      attachments,
      openFiles: get().tabs.map((t) => ({ rel: t.rel, path: t.path })),
      disabledTools: [],
      // notes taken between runs: they were not delivered yet, so they go with this task
      notes: get()
        .notes.filter((n) => n.status === 'pending' && !n.byAgent)
        .map((n) => ({ text: n.text, target: n.target })),
      mode: settings.stableMode ? 'stable' : 'normal',
      costCap: settings.costCap,
      verifyCommand: settings.verifyCommand
    }
    const res = await window.comb.agent.run(req)
    if (res && !res.ok) {
      set({ running: false })
    }
    return true
  },

  queueMessage: (text) => set((s) => ({ queued: [...s.queued, text] })),
  dropQueued: (index) => set((s) => ({ queued: s.queued.filter((_, i) => i !== index) })),
  flushQueue: async () => {
    const q = get().queued
    if (!q.length || get().running) return
    set({ queued: [] })
    await get().sendMessage(q[0])
    if (q.length > 1) set({ queued: q.slice(1) })
  },

  steer: async (text: string) => {
    const runId = get().runId
    const threadId = get().activeThreadId
    if (!runId || !threadId) return false
    // show it in the transcript as a message from the user: they said it, and it
    // should be part of the record even though the agent was already running
    const msg: ChatMessage = { id: uid('m'), role: 'user', content: text, createdAt: Date.now() }
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, messages: [...t.messages, msg], updatedAt: Date.now() } : t))
    }))
    await window.comb.agent.steer(runId, text)
    return true
  },

  answerLiveVote: async (voteId: string, answer: string) => {
    // The answer goes back to the run that asked the question. With two sessions
    // in flight, `get().runId` is the session on screen — answering a question
    // from the background one used to deliver the answer to the wrong agent, and
    // the question it was meant for timed out. Find the asker by the vote id.
    const st = get()
    let asker: string | null = null
    let askerThread: string | null = null
    for (const t of st.threads) {
      const vote = t.messages.find((m) => m.vote?.id === voteId)?.vote
      if (vote) {
        asker = vote.runId || st.runs[t.id]?.runId || null
        askerThread = t.id
        break
      }
    }
    const runId = asker || (askerThread ? st.runs[askerThread]?.runId : undefined) || st.runId
    if (runId) await window.comb.agent.vote(runId, voteId, answer)
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === (askerThread || get().activeThreadId)
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.vote && m.vote.id === voteId ? { ...m, vote: { ...m.vote, answer, live: true } } : m
              )
            }
          : t
      )
    }))
    get().toast('ok', tr('vote.sent'), answer)
  },

  answerVote: async (answer: string) => {
    const threads = get().threads
    const thread = threads.find((t) => t.id === get().activeThreadId)
    const msg = thread?.messages.find((m) => m.vote && !m.vote.answer)
    if (!msg?.vote) return
    const text = answer.trim()
    if (!text) return
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === thread?.id
          ? { ...t, messages: t.messages.map((m) => (m.id === msg.id ? { ...m, vote: { ...m.vote!, answer: text } } : m)) }
          : t
      )
    }))
    // the pick becomes the next user turn
    await get().sendMessage(text)
  },

  stopRun: async () => {
    // Stop applies to the session on screen. With two runs in flight, a global
    // stop would have killed the one the user was not looking at.
    const s = get()
    const id = s.activeThreadId ? s.runs[s.activeThreadId]?.runId : s.runId
    // A stop stays a stop: nothing queued or scheduled may start the next turn.
    set({ queued: [] })
    if (id) await window.comb.agent.stop(id)
  },

  approve: async (decision) => {
    const call = get().pendingApproval
    const runId = get().approvalRunId
    if (!call || !runId) return
    set({ pendingApproval: null })
    if (decision === 'allow-always') {
      // reflect the grant immediately: the list in Settings and future runs read this,
      // and it has to outlive the app too, so it is written to disk here
      const tools = Array.from(new Set([...(get().settings.allowedTools || []), call.name]))
      void get()
        .setSettings({ allowedTools: tools })
        .catch(() => set((s) => ({ settings: { ...s.settings, allowedTools: tools } })))
      get().toast('ok', tr('store.alwaysAllowed'), call.name)
    }
    await window.comb.agent.approve(runId, call.id, decision)
  },

  /* ---------------------------------------------------------------- */
  handleEvent: (e) => {
    const state = get()
    // Events belong to the run that produced them, not to the tab the user has
    // open. Writing them into the active thread is what made a session look like
    // it had "just stopped": its output was landing in the other conversation.
    // A run is not one id: the team runs `run:build`, `run:review`, and the goal
    // opens `run:goal2`, `run:goal3`. Comparing ids exactly found no owner for
    // every stage after the first, and the fallback below then poured that stage
    // into whichever session happened to be on screen — the "messages from one
    // session arrive in another" the user sees. Prefix match, longest first, so
    // `run7` never claims the events of `run70`.
    const owner =
      Object.entries(state.runs).find(([, r]) => e.runId === r.runId)?.[0] ??
      Object.entries(state.runs).find(([, r]) => e.runId.startsWith(`${r.runId}:`))?.[0] ??
      // last resort: the session the main process stamped on the event
      (e.threadId ? state.threads.find((t) => t.id === e.threadId)?.id : undefined) ??
      // and only if the event belongs to nothing we track at all, the open tab —
      // never for an event that belongs to a run we know
      (e.runId ? undefined : state.activeThreadId)
    const threadId = owner ?? null
    if (!threadId) return
    // A deleted session must not keep talking: the run was stopped, but events
    // already in the channel would otherwise find a new home.
    if (deletedThreads.has(threadId) || !state.threads.some((t) => t.id === threadId)) return
    const activeRun = state.runs[threadId]
    // Same story for the message: a child stage writes into the bubble of the
    // session on screen if we let it fall back while another session is streaming.
    const messageId = activeRun ? activeRun.messageId : state.activeThreadId === threadId ? state.streamingMessageId : undefined

    const updateAssistant = (fn: (m: ChatMessage) => ChatMessage): void => {
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                // Which bubble this event belongs to: the run's own message id.
                // The old fallbacks (`streaming && roleOf === activeRole`) pointed
                // at whatever bubble in *this* thread happened to match, and with
                // two sessions in flight the role chip came from the other one —
                // so text streamed into a bubble that was then swept, and the
                // author's answer disappeared. Only a run with no message id falls
                // back to the last streaming bubble of this same thread.
                messages: t.messages.map((m) => {
                  if (messageId) return m.id === messageId ? fn(m) : m
                  return m.streaming && m.role === 'assistant' ? fn(m) : m
                })
              }
            : t
        )
      }))
    }
    /** state that only makes sense for the session on screen */
    const isVisible = (): boolean => get().activeThreadId === threadId

    switch (e.type) {
      case 'run-start':
        break
      case 'role': {
        // The pipeline announces who is at the table — and each stage is its own
        // message. The author's answer and the builder's work used to share one
        // message id, so the first step-note of the builder blanked the text the
        // author had just streamed: the answer visibly vanished mid-run.
        const prev = get()
        const stageKey = e.runId
        void stageKey
        // The role chip and the activity line describe the session on screen. A
        // second session working in the background must not relabel this one.
        if (isVisible()) {
          set((s) => ({ activeRole: e.role, activity: s.activity ? { ...s.activity, role: e.role } : s.activity }))
        }
        updateAssistant((m) => (m.streaming ? { ...m, streaming: false } : m))
        // Each stage announces itself at least twice (author → builder → author)
        // and the goal opens new builder rounds. A stage that produced nothing is
        // not a new bubble: it would render as a stray avatar with an empty trace.
        const cur = get().threads.find((t) => t.id === threadId)?.messages.find((m) => m.id === messageId)
        const curEmpty =
          !!cur &&
          !cur.content?.trim() &&
          !cur.reasoning?.trim() &&
          !(cur.tools || []).length &&
          !(cur.steps || []).length &&
          !cur.specReport
        if (curEmpty && cur && cur.roleOf === e.role) {
          updateAssistant((m) => ({ ...m, streaming: true }))
          break
        }
        if (curEmpty && cur) {
          set((s) => ({
            threads: s.threads.map((t) =>
              t.id !== threadId ? t : { ...t, messages: t.messages.filter((m) => m.id !== cur.id) }
            )
          }))
        }
        const fresh: ChatMessage = {
          id: uid('msg'),
          role: 'assistant',
          content: '',
          reasoning: '',
          createdAt: Date.now(),
          model: prev.settings.model,
          tools: [],
          streaming: true,
          roleOf: e.role,
          stage: e.phase
        }
        set((s) => ({
          // the stage message belongs to this run, not to the window
          runs: s.runs[threadId]
            ? { ...s.runs, [threadId]: { ...s.runs[threadId], messageId: fresh.id } }
            : s.runs,
          streamingMessageId: s.activeThreadId === threadId ? fresh.id : s.streamingMessageId,
          threads: s.threads.map((t) =>
            t.id === threadId ? { ...t, messages: [...t.messages, fresh], updatedAt: Date.now() } : t
          )
        }))
        // Who is speaking is already said by the stage chip and the avatar; the
        // stage announcement itself is not a step. Empty steps rendered as a lone
        // ">>" and then as a stray number once the trace compacted.
        break
      }
      case 'reasoning-delta': {
        // The clock is main's, not ours: `deltaMs` is time since this burst of
        // thought began, so the number can only grow and can never lie.
        updateAssistant((m) => ({
          ...m,
          reasoning: (m.reasoning || '') + e.text,
          thinkingMs: Math.max(m.thinkingMs || 0, e.deltaMs),
          thinkingStartedAt: m.thinkingStartedAt || Date.now() - e.deltaMs
        }))
        // while it is thinking the header must say so, not keep the stale label
        const prev = get().activity
        if (prev) {
          set({
            activity: {
              ...prev,
              label: tr('chat.thinkingNow'),
              thoughtMs: Math.max(prev.thoughtMs || 0, e.deltaMs)
            }
          })
        }
        break
      }
      case 'text-delta':
        set({
          activity: { step: get().activity?.step || 1, label: tr('chat.stepWriting'), since: get().activity?.since || Date.now(), thoughtMs: get().activity?.thoughtMs },
          retryInfo: null
        })
        updateAssistant((m) => ({ ...m, content: (m.content || '') + e.text }))
        break
      case 'attachments':
        updateAssistant((m) => ({
          ...m,
          attachments: [...(m.attachments || []), ...e.attachments.filter((a) => !(m.attachments || []).some((x) => x.path === a.path))]
        }))
        break
      case 'step-note': {
        // The prose STAYS in the message: it is the answer the user is waiting
        // for. It used to move into the trace (content = ''), which is why a long
        // reply vanished the moment the agent called finish — the round had a
        // tool call, so the note fired and wiped the text.
        // No duplication: when the round's narration is the body itself, the
        // trace keeps only the actions.
        updateAssistant((m) => {
          const body = (m.content || '').trim()
          const say = (e.say || '').trim()
          const duplicate = !!say && (body === say || body.startsWith(say) || say.startsWith(body))
          return {
            ...m,
            steps: [
              ...(m.steps || []),
              { id: uid('stp'), step: e.step, say: duplicate ? '' : say, actions: e.actions }
            ].slice(-80)
          }
        })
        break
      }
      case 'step':
        if (isVisible()) set({ activity: { step: e.step, label: tr('chat.stepThinking'), since: Date.now() } })
        break
      case 'tool-call':
        if (isVisible()) {
          set({ activity: { step: get().activity?.step || 1, label: activityLabel(e.call.name, e.call.args), since: Date.now() } })
        }
        updateAssistant((m) => {
          const tools = m.tools || []
          const exists = tools.some((t) => t.id === e.call.id)
          return { ...m, tools: exists ? tools.map((t) => (t.id === e.call.id ? { ...t, ...e.call } : t)) : [...tools, e.call] }
        })
        // suggest: follow-up chips, not a tool row
        if (e.call.name === 'suggest') {
          const opts: string[] = Array.isArray(e.call.args?.options) ? e.call.args.options.map(String).slice(0, 4) : []
          if (opts.length) updateAssistant((m) => ({ ...m, suggestions: opts }))
        }
        // ask_user is not a tool row: it becomes a vote card the user can click
        if (e.call.name === 'ask_user' && e.call.status !== 'error') {
          const opts: string[] = Array.isArray(e.call.args?.options) ? e.call.args.options.map(String) : []
          const question = String(e.call.args?.question || '')
          if (question && opts.length >= 2) {
            updateAssistant((m) => ({
              ...m,
              vote: { id: e.call.id, question, options: opts.slice(0, 4), recommend: e.call.args?.recommend, runId: e.runId }
            }))
          }
        }
        break
      case 'tool-update':
        updateAssistant((m) => ({
          ...m,
          tools: (m.tools || []).map((t) => (t.id === e.call.id ? { ...t, ...e.call } : t))
        }))
        break
      case 'tool-approval-request':
        // A background session asking for permission must be visible: the modal
        // is tied to the run it came from, and the sidebar marks that session.
        set({ pendingApproval: e.call, approvalRunId: e.runId, approvalThreadId: threadId })
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
        // The change list belongs to the session that made the changes.
        if (!isVisible()) {
          void get().refreshGit()
          void get().refreshTree()
          break
        }
        const rels = e.paths.map((p) => {
          const ws = state.workspace || ''
          return p.startsWith(ws) ? p.slice(ws.length + 1).replace(/\\/g, '/') : p
        })
        set((s) => ({ changedFiles: [...new Set([...s.changedFiles, ...rels])] }))
        void get().refreshGit()
        void get().refreshTree()
        break
      }
      case 'activity':
        // The app itself is busy (writing the spec, checking the work): keep the
        // header alive instead of leaving the last label from three steps ago.
        if (isVisible()) set({ activity: { step: e.step, label: e.label, since: Date.now() }, retryInfo: null })
        break
      case 'goal-round': {
        // The run is not over: it is continuing, and the user should see that
        // instead of a stopped transcript that looks abandoned.
        set((s) => ({
          activity: {
            step: e.round,
            since: Date.now(),
            label:
              (e.reason === 'criteria' ? tr('goal.roundCriteria') : tr('goal.roundPlan')) +
              ` · ${e.round}/${e.maxRounds}` +
              (e.detail ? ` · ${e.detail}` : '')
          }
        }))
        updateAssistant((m) => ({
          ...m,
          guards: [
            ...(m.guards || []),
            {
              id: uid('guard'),
              kind: 'goal',
              title: tr('goal.roundTitle', { n: String(e.round), max: String(e.maxRounds) }),
              detail: e.detail || (e.reason === 'criteria' ? tr('goal.roundCriteria') : tr('goal.roundPlan'))
            }
          ]
        }))
        break
      }
      case 'goal-end': {
        const label =
          e.stop === 'contract-met'
            ? tr('goal.met', { n: String(e.rounds) })
            : e.stop === 'rounds-used'
              ? tr('goal.roundsUsed', { n: String(e.rounds) })
              : e.stop === 'no-progress'
                ? tr('goal.stalled', { n: String(e.rounds) })
                : tr('goal.failed')
        updateAssistant((m) => ({
          ...m,
          guards: [...(m.guards || []), { id: uid('guard'), kind: e.stop === 'contract-met' ? 'done' : 'rework', title: label }]
        }))
        break
      }
      case 'spec-check': {
        // The evidence behind «готово»: what was checked and what it rests on.
        // A refused check is not the end — the goal opens another round — so the
        // header must say that instead of freezing on the old label.
        if (e.refused) {
          set((s) => ({
            activity: {
              step: s.activity?.step || 1,
              label: tr('goal.specRefused'),
              since: s.activity?.since || Date.now()
            }
          }))
        }
        updateAssistant((m) => ({
          ...m,
          specReport: e.report,
          guards: e.refused
            ? [
                ...(m.guards || []),
                {
                  id: uid('guard'),
                  kind: 'rework',
                  title: `Приёмка не прошла: ${e.report.checks.filter((c) => c.status === 'fail').length} из ${e.report.checks.length}`,
                  detail: e.report.summary
                }
              ]
            : m.guards
        }))
        break
      }
      case 'guard': {
        const note = { id: uid('guard'), kind: e.kind, title: e.title, detail: e.detail }
        updateAssistant((m) => ({ ...m, guards: [...(m.guards || []), note] }))
        if (e.kind === 'cost' || e.kind === 'stuck') get().toast('warn', e.title, e.detail)
        break
      }
      case 'run-retry': {
        // the stream died mid-answer: wipe the partial text so the retry does not
        // duplicate it, and show what is happening instead of a frozen spinner
        if (isVisible()) {
          set((s) => ({
            activity: {
              step: e.step,
              label: tr('chat.reconnecting', { n: Math.round(e.waitMs / 1000) }),
              since: s.activity?.since || Date.now()
            },
            retryInfo: { attempt: e.attempt, max: e.max, reason: e.reason, at: Date.now(), waitMs: e.waitMs }
          }))
        }
        updateAssistant((m) => ({ ...m, content: '', reasoning: '' }))
        break
      }
      case 'vote-auto': {
        // nobody answered in time: the run carried on with the agent's own pick
        updateAssistant((m) =>
          m.vote && m.vote.id === e.voteId ? { ...m, vote: { ...m.vote, answer: e.answer, auto: e.answer } } : m
        )
        break
      }
      case 'note': {
        set((s) => ({ notes: [...s.notes, { ...e.note, byAgent: true }] }))
        const thread = get().threads.find((t) => t.id === threadId)
        if (thread) get().persistThread({ ...thread, notes: [...(thread.notes || []), e.note] })
        break
      }
      case 'notify': {
        // the native toast is main's job; in-app we keep a quiet record
        set((s) => ({ notifications: [...s.notifications, { id: uid('note'), title: e.title, body: e.body, at: Date.now() }].slice(-20) }))
        showAttention(e.urgent ? 'error' : 'done', e.title, e.body)
        break
      }
      case 'present':
        updateAssistant((m) => ({
          ...m,
          presented: [
            ...(m.presented || []),
            ...e.files.filter((f) => !(m.presented || []).some((x) => x.path === f.path))
          ]
        }))
        break
      case 'file-summaries': {
        // the agent labelled the files it wrote: the explorer picks these up live
        set((s) => {
          const next = { ...s.fileSummaries }
          const purposes = { ...s.filePurposes }
          for (const f of e.summaries) {
            if (f.description) next[f.path] = f.description
            if (f.purpose) purposes[f.path] = f.purpose
          }
          return { fileSummaries: next, filePurposes: purposes }
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
        updateAssistant((m) => {
          // A stage that produced neither prose, a tool call nor a thought is
          // noise: the review pass often adds nothing, and an empty bubble reads
          // as "the app lost my answer".
          const empty = !m.content?.trim() && !m.reasoning?.trim() && !(m.tools || []).length && !(m.steps || []).length
          if (empty) return m
          // The finish tool carries the summary; if the model never wrote prose
          // afterwards, that summary IS the answer — show it instead of a turn
          // that just ends.
          const fin = (m.tools || []).find((x) => x.name === 'finish' && typeof x.args?.summary === 'string')
          const summary = fin && !m.content?.trim() ? String(fin.args.summary) : ''
          return {
          ...m,
          content: m.content?.trim() ? m.content : summary,
          streaming: false,
          stopped: e.reason === 'stopped',
          tools: stale
            ? (m.tools || []).map((t) => (t.id === stale.id && t.status === 'awaiting-approval' ? { ...t, status: 'expired' } : t))
            : m.tools
          }
        })
        // Only this run ends; the other session keeps its own state.
        set((s) => {
          const runs = { ...s.runs }
          delete runs[threadId]
          const stillRunning = Object.keys(runs).length > 0
          const visible = s.activeThreadId === threadId
          return {
            runs,
            running: stillRunning,
            runId: visible ? s.runId : s.runId,
            ...(visible
              ? {
                  pendingApproval: null,
                  activity: null,
                  retryInfo: null,
                  activeRole: null,
                  runId: null
                }
              : {})
          }
        })
        void window.comb.app.attention(false)
        if (stale) get().toast('warn', tr('chat.approvalExpired'))
        // A stage that streamed nothing leaves an empty bubble: remove it, or the
        // transcript ends with a blank block that looks like lost content.
        // Only a stage that said nothing at all is removed. The old rule also
        // looked at tools and steps, but a stage can hand its text to the next
        // message and still own the calls — and the user watched the author's
        // answer vanish when the builder's empty bubble was swept. Keep anything
        // with any trace of work in it.
        set((s) => ({
          threads: s.threads.map((th) =>
            th.id !== threadId
              ? th
              : {
                  ...th,
                  messages: th.messages.filter(
                    (m) =>
                      m.role !== 'assistant' ||
                      !!m.content?.trim() ||
                      !!m.reasoning?.trim() ||
                      !!(m.tools || []).length ||
                      !!(m.steps || []).length ||
                      !!(m.guards || []).length ||
                      !!m.vote ||
                      !!m.specReport ||
                      !!m.error
                  )
                }
          )
        }))
        const t = get().threads.find((x) => x.id === threadId)
        if (t) get().persistThread({ ...t, updatedAt: Date.now() })
        if (e.reason === 'limit') get().toast('warn', tr('store.stepLimit'), tr('store.stepLimitHint'))
        if (e.reason === 'guard') get().toast('warn', tr('store.guardStopped'), tr('store.guardStoppedHint'))
        // "walk away for two hours": hitting the step budget mid-task is a pause,
        // not a failure — pick the run back up by itself, a bounded number of times.
        // What the user typed while the agent was busy goes out now, in order.
        // What the user typed while the agent was busy goes out when the run is
        // over — on a stop too, because those lines are theirs and they wrote
        // them. The queue is cleared by `stopRun`, so pressing Stop means the
        // queue is dropped with it: nothing starts behind their back.
        const queuedNow = get().queued
        if (queuedNow.length) {
          set({ queued: queuedNow.slice(1) })
          const next = queuedNow[0]
          setTimeout(() => {
            if (!get().running) void get().sendMessage(next)
          }, 400)
        }
        // A run that stopped, stopped. The old behaviour sent a scripted
        // "Продолжай с того места" message into the chat on its own — a sentence
        // the user never wrote, appearing under their name while they were still
        // typing. That is the app talking as the user, and it is gone: continuing
        // is one click (or one line) away, and it is the user's to make.
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

  addNote: (n) => {
    const text = n.text.trim()
    if (!text) return
    const note: StickyNote = {
      id: uid('note'),
      text,
      target: n.target,
      targetLabel: n.targetLabel,
      tone: n.tone ?? Math.floor(Math.random() * 6),
      createdAt: Date.now(),
      status: 'pending'
    }
    const runId = get().runId
    const live = get().running && runId
    // a note taken mid-run is a clarification for the agent right now; one taken
    // between runs waits for the next task instead of getting lost
    const stored: StickyNote = live ? { ...note, status: 'sent', runId: runId! } : note
    set((s) => ({ notes: [...s.notes, stored] }))
    const thread = get().threads.find((t) => t.id === get().activeThreadId)
    if (thread) get().persistThread({ ...thread, notes: [...(thread.notes || []), stored] })
    if (live) {
      void window.comb.agent.steer(runId!, stored.target ? `${stored.targetLabel || stored.target}: ${text}` : text)
      get().toast('ok', tr('note.delivered'), text.slice(0, 60))
    }
  },

  updateNote: (id, patch) => {
    set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }))
    const thread = get().threads.find((t) => t.id === get().activeThreadId)
    if (thread) {
      get().persistThread({
        ...thread,
        notes: (thread.notes || []).map((n) => (n.id === id ? { ...n, ...patch } : n))
      })
    }
  },

  removeNote: (id) => {
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }))
    const thread = get().threads.find((t) => t.id === get().activeThreadId)
    if (thread) get().persistThread({ ...thread, notes: (thread.notes || []).filter((n) => n.id !== id) })
  },

  setNotesOpen: (open) => set({ notesOpen: open }),

  dismissAttention: () => set({ attention: null }),

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
    const rows = (await window.comb.files.summaries(paths).catch(() => [])) as { path: string; description: string; purpose?: string }[]
    if (!rows.length) return
    set((s) => {
      const next = { ...s.fileSummaries }
      const purposes = { ...s.filePurposes }
      for (const r of rows) {
        next[r.path] = r.description
        if (r.purpose) purposes[r.path] = r.purpose
      }
      return { fileSummaries: next, filePurposes: purposes }
    })
  },

  describeFileNow: async (abs) => {
    // give the model the same context the background pass gets, so the line says
    // what the file is FOR, not what it contains
    const thread = get().threads.find((t) => t.id === get().activeThreadId)
    const task = (thread?.messages.filter((m) => m.role === 'user').slice(-1)[0]?.content || '').slice(0, 600)
    const res = await window.comb.files.describe(abs, task ? { task } : undefined)
    if (res.ok && res.summary) {
      set((s) => ({
        fileSummaries: { ...s.fileSummaries, [abs]: res.summary!.description },
        filePurposes: res.summary!.purpose ? { ...s.filePurposes, [abs]: res.summary!.purpose } : s.filePurposes
      }))
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

/** What a step is actually touching: a file, a command, a folder. */
function activityTarget(args?: Record<string, any>): string {
  if (!args) return ''
  const raw = args.path ?? args.file ?? args.rel ?? args.target ?? args.pattern ?? args.query ?? args.command ?? ''
  const s = String(raw || '').trim().replace(/\s+/g, ' ')
  if (!s) return ''
  const short = s.length > 48 ? `${s.slice(0, 47)}…` : s
  return short
}

/** Human label for the live status line: what the agent is doing right now. */
export function activityLabel(tool: string, args?: Record<string, any>): string {
  const target = activityTarget(args)
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
    notify_user: 'tool.notify',
    suggest: 'tool.suggest',
    leave_note: 'tool.note',
    finish: 'chat.stepDone',
    attach_file: 'tool.attach_file'
  }
  const label = map[tool] ? tr(map[tool]) : tool
  return target && !['finish', 'suggest', 'ask_user'].includes(tool) ? `${label} · ${target}` : label
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

/**
 * Is the session on screen the one that is running?
 *
 * The composer, the Stop button, the plan panel and the "thinking" row all act on
 * one session. With two sessions in flight, `running` was a single window-wide
 * flag: the second session refused to start ("already running") and, worse, the
 * events of whichever run was live were written into whichever thread happened to
 * be open — the first chat simply stopped mid-answer. Work is tracked per thread
 * now, and these selectors are how the UI asks "about this one".
 */
export const useThreadBusy = (threadId: string | null | undefined): boolean =>
  useStore((s) => !!threadId && !!s.runs[threadId])

export const threadBusy = (threadId: string | null | undefined): boolean =>
  !!threadId && !!useStore.getState().runs[threadId]

export const useLiveRun = (): string | null =>
  useStore((s) => (s.activeThreadId ? s.runs[s.activeThreadId]?.runId ?? null : null))
