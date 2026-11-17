/**
 * Shared types between the Electron main process, preload and renderer.
 * Keep this file dependency-free so it can be imported from any layer.
 */

export type ApprovalPolicy = 'ask' | 'auto-edit' | 'yolo'
export type ThemeId = 'comb' | 'midnight' | 'graphite' | 'electric' | 'nord' | 'paper'
export type Role = 'user' | 'assistant' | 'system'
/** UI language. 'auto' follows the OS locale on first run. */
export type Locale = 'en' | 'ru'

export interface ModelInfo {
  id: string
  label: string
  family: 'deepseek' | 'custom'
  /** picks the mode in the UI; thinking is a request parameter on V4+, not a separate model */
  reasoning: boolean
  contextWindow: number
  maxOutput: number
  /** USD per 1M tokens, peak rates (off-peak is half) */
  priceIn: number
  priceInCached: number
  priceOut: number
  /** accepts image input */
  vision: boolean
  blurbKey: 'model.blurbFlash' | 'model.blurbPro'
}

/**
 * DeepSeek V4 lineup (see api-docs.deepseek.com/quick_start/pricing).
 * `deepseek-chat` / `deepseek-reasoner` were retired on 2026-07-24; thinking mode
 * moved into the request body, so both entries below are the same wire model
 * with a different `thinking` flag.
 */
export const MODELS: ModelInfo[] = [
  {
    id: 'deepseek-flash',
    label: 'deepseek-flash',
    family: 'deepseek',
    reasoning: false,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    priceIn: 0.3,
    priceInCached: 0.006,
    priceOut: 1.2,
    vision: true,
    blurbKey: 'model.blurbFlash'
  },
  {
    id: 'deepseek-flash-thinking',
    label: 'deepseek-flash · thinking',
    family: 'deepseek',
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    priceIn: 0.3,
    priceInCached: 0.006,
    priceOut: 1.2,
    vision: true,
    blurbKey: 'model.blurbPro'
  }
]

/** Wire model name for a UI model id — thinking is a request flag, not a model. */
export function wireModel(id: string): string {
  return id === 'deepseek-flash-thinking' ? 'deepseek-flash' : id
}

/** Extra request fields a UI model id implies. */
export function modelOptions(id: string): { thinking?: { type: 'enabled' | 'disabled' } } {
  if (id === 'deepseek-flash-thinking') return { thinking: { type: 'enabled' } }
  if (id === 'deepseek-flash') return { thinking: { type: 'disabled' } }
  return {}
}

/**
 * How much the app protects a run that nobody is watching. `stable` is only ever
 * picked automatically (long task, full-disk access, or the user asked for it in
 * the prompt) — it is a guaranteed baseline, not a switch people have to know.
 */
export type RunMode = 'normal' | 'stable'

export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  approvalPolicy: ApprovalPolicy
  theme: ThemeId
  accent: string
  fontSize: number
  uiScale: number
  fontLigatures: boolean
  reducedMotion: boolean
  sendOnEnter: boolean
  autoContext: boolean
  maxAgentSteps: number
  shell: string
  terminalFontSize: number
  showLineNumbers: boolean
  wordWrap: boolean
  tabSize: number
  autoSave: boolean
  telemetry: boolean
  customInstructions: string
  lastWorkspace: string | null
  recentWorkspaces: string[]
  /** extra roots the agent may read/write besides lastWorkspace */
  extraRoots: string[]
  /** let the agent read/write anywhere on the machine, not just open folders */
  fullDiskAccess: boolean
  alphaFeatures: boolean
  /** let the model label the files it wrote, in the background */
  describeFiles: boolean
  /** extra-hardening on top of the always-on guards: verification, cost ceiling, stuck detection */
  stableMode: boolean
  /** stop a run when it costs more than this, in USD (0 = no ceiling) */
  costCap: number
  /** command the stable mode runs before claiming success, e.g. `npm test` (empty = auto) */
  verifyCommand: string
  /** pick up a run by itself after an approval or a guard, instead of waiting for the user */
  autoContinue: boolean
  /** desktop notifications for finished tasks, blockers and decisions */
  notifyDesktop: boolean
  /** let the agent offer a vote when a decision really matters (at most once per run) */
  proposeVotes: boolean
  allowedTools: string[]
  locale: Locale
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: 0.2,
  maxTokens: 16384,
  approvalPolicy: 'ask',
  theme: 'comb',
  /** 'auto' = the accent that belongs to the chosen theme */
  accent: 'auto',
  fontSize: 13,
  uiScale: 1,
  fontLigatures: true,
  reducedMotion: false,
  sendOnEnter: true,
  autoContext: true,
  maxAgentSteps: 40,
  shell: '',
  terminalFontSize: 13,
  showLineNumbers: true,
  wordWrap: false,
  tabSize: 2,
  autoSave: true,
  telemetry: false,
  customInstructions: '',
  lastWorkspace: null,
  recentWorkspaces: [],
  extraRoots: [],
  fullDiskAccess: false,
  alphaFeatures: false,
  describeFiles: true,
  stableMode: true,
  costCap: 0.5,
  verifyCommand: '',
  autoContinue: true,
  notifyDesktop: true,
  proposeVotes: true,
  allowedTools: [],
  locale: 'en'
}

/* ------------------------------------------------------------------ */
/* Workspace / filesystem                                              */
/* ------------------------------------------------------------------ */

export interface DirEntry {
  name: string
  path: string
  rel: string
  isDir: boolean
  size: number
  mtime: number
  ignored?: boolean
}

export interface FileContent {
  path: string
  rel: string
  content: string
  language: string
  size: number
  mtime: number
  truncated?: boolean
}

export interface SearchHit {
  path: string
  rel: string
  line: number
  column: number
  text: string
}

export interface FileSearchResult {
  path: string
  rel: string
}

export interface GitFile {
  path: string
  index: string
  worktree: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
  /** short git log lines: "<hash> <subject>" */
  log: { hash: string; subject: string; date: string }[]
  error?: string
}

/* ------------------------------------------------------------------ */
/* Agent protocol                                                      */
/* ------------------------------------------------------------------ */

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'multi_edit'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'run_command'
  | 'delete_path'
  | 'move_path'
  | 'todo_write'
  | 'ask_user'
  | 'notify_user'
  | 'finish'

export interface ToolCall {
  id: string
  name: ToolName | string
  args: Record<string, any>
  /** raw json string as streamed by the model */
  raw?: string
}

export type ToolStatus = 'pending' | 'running' | 'awaiting-approval' | 'ok' | 'error' | 'denied' | 'aborted' | 'expired'

export interface ToolResultView {
  id: string
  name: string
  args: Record<string, any>
  status: ToolStatus
  output?: string
  error?: string
  /** diff shown inline for file mutations */
  diff?: FileDiff[]
  /** file handed to the user by attach_file */
  attach?: { path: string; rel: string; note?: string }
  /** plain-language explanation of a failure, e.g. what exit 255 means here */
  locale?: string
  durationMs?: number
  collapsed?: boolean
}

/** A question the agent wants the user to decide, shown as pickable cards. */
export interface AgentVote {
  id: string
  question: string
  options: string[]
  /** the option the agent would choose itself */
  recommend?: string
  /** filled in once the user picks or types an answer */
  answer?: string
}

export interface FileDiff {
  rel: string
  path: string
  before: string
  after: string
  kind: 'create' | 'modify' | 'delete'
  additions: number
  deletions: number
  /** binary / too large to diff */
  binary?: boolean
}

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  reasoningTokens: number
  cost: number
}

/** One-line description of a file, written by the model and cached on disk. */
export interface FileSummary {
  /** why the file exists: the intent behind writing it (set when the agent wrote it) */
  purpose?: string
  path: string
  description: string
  mtime: number
  size: number
  generatedAt: number
}

export interface Attachment {
  id: string
  kind: 'file' | 'selection' | 'image'
  path?: string
  rel?: string
  name: string
  content: string
  /** SVG dropped in chat: attached as text (it is code), not as pixels */
  vector?: boolean
  /** for selections, 1-based line range */
  from?: number
  to?: number
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  reasoning?: string
  createdAt: number
  model?: string
  tools?: ToolResultView[]
  usage?: TokenUsage
  attachments?: Attachment[]
  /** assistant message still streaming */
  streaming?: boolean
  /** stable-mode guard notes attached to the turn they happened in */
  guards?: { id: string; kind: string; title: string; detail?: string }[]
  /** an open/answered question from the agent */
  vote?: AgentVote
  error?: string
  stopped?: boolean
}

export interface Thread {
  extraRoots?: string[]
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  workspace: string | null
  model: string
  usage: TokenUsage
  todos: TodoItem[]
  pinned?: boolean
  archived?: boolean
}

export interface Checkpoint {
  id: string
  label: string
  createdAt: number
  threadId: string
  files: { rel: string; content: string | null }[]
}

/* ------------------------------------------------------------------ */
/* Agent streaming events (main -> renderer)                           */
/* ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'run-start'; runId: string; threadId: string; messageId: string }
  | { type: 'reasoning-delta'; runId: string; text: string }
  | { type: 'text-delta'; runId: string; text: string }
  | { type: 'tool-call'; runId: string; call: ToolResultView }
  | { type: 'tool-update'; runId: string; call: ToolResultView }
  | { type: 'tool-approval-request'; runId: string; call: ToolResultView }
  | { type: 'todos'; runId: string; todos: TodoItem[] }
  | { type: 'usage'; runId: string; usage: TokenUsage }
  | { type: 'checkpoint'; runId: string; checkpoint: Checkpoint }
  | { type: 'step'; runId: string; step: number }
  | { type: 'files-changed'; runId: string; paths: string[] }
  | { type: 'file-summaries'; runId: string; summaries: FileSummary[] }
  | { type: 'error'; runId: string; message: string }
  | {
      type: 'notify'
      runId: string
      title: string
      body: string
      urgent?: boolean
    }
  | {
      type: 'guard'
      runId: string
      kind: 'cost' | 'verify' | 'stuck' | 'errors' | 'done'
      /** short headline for the transcript */
      title: string
      detail?: string
    }
  | { type: 'run-end'; runId: string; reason: 'done' | 'stopped' | 'error' | 'limit' | 'guard' }

export interface RunRequest {
  runId: string
  threadId: string
  messageId: string
  workspace: string | null
  /** additional folders the agent may touch, beyond `workspace` */
  extraRoots?: string[]
  /** no sandbox: absolute paths anywhere on the machine are allowed */
  fullDiskAccess?: boolean
  model: string
  temperature: number
  maxTokens: number
  approvalPolicy: ApprovalPolicy
  maxSteps: number
  autoContext: boolean
  /** label freshly written files with a one-liner (default on) */
  describeFiles?: boolean
  customInstructions: string
  /** full prior conversation (without the new user message) */
  history: ChatMessage[]
  userMessage: ChatMessage
  /** extra context: open files, selections */
  attachments: Attachment[]
  openFiles?: { rel: string; path: string }[]
  /** only run these tool ids: used by "apply" flows */
  disabledTools?: string[]
  /** stable = verification pass + guards; defaults to normal */
  mode?: RunMode
  /** USD ceiling for this run (0 = off) */
  costCap?: number
  /** what "done" has to pass; empty = auto-detect from manifests */
  verifyCommand?: string
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface PtyCreateOptions {
  id: string
  cwd: string
  cols: number
  rows: number
  shell?: string
}

/* ------------------------------------------------------------------ */
/* Preload API surface                                                 */
/* ------------------------------------------------------------------ */

export interface CombApi {
  app: {
    platform: string
    version: string
    electron: string
    node: string
    chrome: string
    homedir: string
    getInfo(): Promise<AppInfo>
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximized(cb: (v: boolean) => void): () => void
    openExternal(url: string): void
    showItemInFolder(path: string): void
    /** taskbar progress + window flash while a long run is in flight */
    attention(on: boolean, label?: string): void
    openPath(path: string): Promise<string>
  }
  files: {
    readonly describe: (abs: string, ctx?: { task?: string }) => Promise<{ ok: boolean; summary?: FileSummary | null; error?: string }>
    readonly summaries: (paths: string[]) => Promise<FileSummary[]>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChanged(cb: (s: Settings) => void): () => void
  }
  threads: {
    list(): Promise<Thread[]>
    save(thread: Thread): Promise<void>
    delete(id: string): Promise<void>
    clearAll(): Promise<void>
  }
  fs: {
    readonly readImage: (path: string) => Promise<{ ok: boolean; dataUrl?: string | null; error?: string }>
    pickFolder(): Promise<string | null>
    pickFiles(): Promise<string[]>
    list(dir: string): Promise<DirEntry[]>
    tree(root: string, depth?: number): Promise<DirEntry[]>
    read(path: string): Promise<FileContent>
    write(path: string, content: string): Promise<{ size: number; mtime: number }>
    create(path: string, isDir: boolean): Promise<void>
    rename(from: string, to: string): Promise<void>
    remove(path: string): Promise<void>
    exists(path: string): Promise<boolean>
    search(root: string, query: string, opts?: { regex?: boolean; caseSensitive?: boolean; max?: number; glob?: string }): Promise<SearchHit[]>
    findFiles(root: string, query: string, opts?: { max?: number }): Promise<FileSearchResult[]>
    watch(root: string, id: string): Promise<void>
    unwatch(id: string): Promise<void>
    onChanged(cb: (e: { root: string; paths: string[] }) => void): () => void
  }
  git: {
    status(root: string): Promise<GitStatus>
    diff(root: string, path: string): Promise<string>
    commit(root: string, message: string, paths?: string[]): Promise<{ ok: boolean; out: string }>
    init(root: string): Promise<{ ok: boolean; out: string }>
    stage(root: string, paths: string[]): Promise<{ ok: boolean; out: string }>
    unstage(root: string, paths: string[]): Promise<{ ok: boolean; out: string }>
    checkout(root: string, path: string): Promise<{ ok: boolean; out: string }>
  }
  agent: {
    run(req: RunRequest): Promise<{ ok: boolean; error?: string }>
    stop(runId: string): Promise<void>
    approve(runId: string, callId: string, decision: 'allow' | 'allow-always' | 'deny', editedArgs?: Record<string, any>): Promise<void>
    onEvent(cb: (e: AgentEvent) => void): () => void
    testKey(apiKey: string, baseUrl: string): Promise<{ ok: boolean; message: string; models?: string[] }>
  }
  terminal: {
    create(opts: PtyCreateOptions): Promise<{ ok: boolean; error?: string; backend: string }>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(cb: (e: TerminalDataEvent) => void): () => void
    onExit(cb: (e: { id: string; code: number }) => void): () => void
  }
  checkpoints: {
    list(threadId: string): Promise<Checkpoint[]>
    restore(id: string): Promise<{ ok: boolean; restored: string[] }>
    create(threadId: string, label: string, rels: string[], workspace: string): Promise<Checkpoint>
  }
  clipboard: {
    write(text: string): void
    read(): Promise<string>
  }
  window: {
    setTheme(theme: string, accent: string): void
  }
}

export interface AppInfo {
  platform: string
  version: string
  electron: string
  node: string
  chrome: string
  homedir: string
  userData: string
}
