import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { createTwoFilesPatch } from 'diff'
import {
  isProbablyBinary,
  languageFor,
  listDir,
  readFileSafe,
  safeJoin,
  toRel,
  walk,
  writeFileSafe
} from './fsops'
import type { FileDiff, TodoItem, ToolResultView } from '../shared/types'
import type { LlmToolSchema } from './llm'

export interface ToolContext {
  workspace: string
  /** Files touched during this run, used for checkpoints and the changed-files list. */
  touched: Set<string>
  beforeState: Map<string, string | null>
  todos: TodoItem[]
  onTodos: (todos: TodoItem[]) => void
  approvalPolicy: 'ask' | 'auto-edit' | 'yolo'
  runId: string
  /** async hook so the UI can approve destructive ops */
  requestApproval: (call: ToolResultView) => Promise<'allow' | 'allow-always' | 'deny'>
  signal: AbortSignal
}

export interface ToolOutcome {
  ok: boolean
  output?: string
  error?: string
  diff?: FileDiff[]
  /** extra data for renderer */
  meta?: Record<string, any>
  /** abort the whole run (e.g. user said stop, or ask_user) */
  halt?: 'done' | 'error' | 'aborted'
}

const MAX_OUTPUT = 30000
const MAX_CMD_OUTPUT = 24000

function clamp(s: string, n = MAX_OUTPUT): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `\n… [truncated ${s.length - n} chars]`
}

function makeDiff(ctx: ToolContext, abs: string, before: string | null, after: string | null): FileDiff {
  const rel = toRel(ctx.workspace, abs)
  const a = before ?? ''
  const b = after ?? ''
  let additions = 0
  let deletions = 0
  for (const line of createTwoFilesPatch(rel, rel, a, b).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return {
    rel,
    path: abs,
    before: a,
    after: b,
    kind: before === null ? 'create' : after === null ? 'delete' : 'modify',
    additions,
    deletions
  }
}

function rememberBefore(ctx: ToolContext, abs: string, content: string | null): void {
  if (!ctx.beforeState.has(abs)) ctx.beforeState.set(abs, content)
}

/** Execute one tool call. Never throws — errors are returned as outcome.error. */
export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'read_file':
        return await toolReadFile(args, ctx)
      case 'write_file':
        return await toolWriteFile(args, ctx)
      case 'edit_file':
        return await toolEditFile(args, ctx)
      case 'multi_edit':
        return await toolMultiEdit(args, ctx)
      case 'list_dir':
        return await toolListDir(args, ctx)
      case 'glob':
        return await toolGlob(args, ctx)
      case 'grep':
        return await toolGrep(args, ctx)
      case 'run_command':
        return await toolRunCommand(args, ctx)
      case 'delete_path':
        return await toolDelete(args, ctx)
      case 'move_path':
        return await toolMove(args, ctx)
      case 'todo_write':
        return toolTodo(args, ctx)
      case 'ask_user':
        return {
          ok: true,
          output: `Question sent to user: ${args.question || ''}`,
          meta: { question: args.question, options: args.options },
          halt: ctx.approvalPolicy === 'yolo' ? undefined : 'done'
        }
      case 'finish':
        return { ok: true, output: args.summary || 'Task finished.', halt: 'done' }
      default:
        return { ok: false, error: `Unknown tool: ${name}` }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/* ------------------------------------------------------------------ */

async function toolReadFile(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  if (!rel) return { ok: false, error: 'path is required' }
  const abs = safeJoin(ctx.workspace, rel)
  const st = await fs.stat(abs)
  if (st.isDirectory()) {
    const entries = await listDir(abs, ctx.workspace)
    return { ok: true, output: entries.map((e) => (e.isDir ? `${e.rel}/` : e.rel)).join('\n'), meta: { isDir: true } }
  }
  if (st.size > 1024 * 1024) {
    const fc = await readFileSafe(abs, ctx.workspace)
    return { ok: true, output: clamp(fc.content), meta: { truncated: true, size: st.size } }
  }
  const fc = await readFileSafe(abs, ctx.workspace)
  if (fc.language === 'binary') return { ok: true, output: `[binary file, ${st.size} bytes]`, meta: { binary: true } }
  const numbered = args.line_numbers !== false
  const from = Number(args.start_line || 1)
  const to = Number(args.end_line || 0)
  let lines = fc.content.split('\n')
  if (from > 1 || to > 0) lines = lines.slice(from - 1, to > 0 ? to : undefined)
  const body = numbered ? lines.map((l, i) => `${from + i}: ${l}`).join('\n') : lines.join('\n')
  return {
    ok: true,
    output: clamp(body),
    meta: { lines: fc.content.split('\n').length, language: fc.language, size: st.size, truncated: fc.truncated }
  }
}

async function toolWriteFile(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  const content = String(args.content ?? '')
  if (!rel) return { ok: false, error: 'path is required' }
  const abs = safeJoin(ctx.workspace, rel)
  let before: string | null = null
  try {
    const prev = await fs.readFile(abs, 'utf8')
    before = prev
  } catch {
    before = null
  }
  if (before === content) return { ok: true, output: `No changes: ${rel}`, meta: { unchanged: true } }
  await writeFileSafe(abs, content)
  rememberBefore(ctx, abs, before)
  ctx.touched.add(abs)
  const diff = makeDiff(ctx, abs, before, content)
  return {
    ok: true,
    output: `${before === null ? 'Created' : 'Updated'} ${rel} (${content.split('\n').length} lines, +${diff.additions} −${diff.deletions})`,
    diff: [diff]
  }
}

function norm(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

async function toolEditFile(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  const oldStr = String(args.old_string ?? args.old_str ?? '')
  const newStr = String(args.new_string ?? args.new_str ?? '')
  const replaceAll = Boolean(args.replace_all)
  if (!rel) return { ok: false, error: 'path is required' }
  if (!oldStr) return { ok: false, error: 'old_string is required (must match the file exactly, including indentation)' }
  const abs = safeJoin(ctx.workspace, rel)
  let current: string
  try {
    current = norm(await fs.readFile(abs, 'utf8'))
  } catch {
    return { ok: false, error: `File not found: ${rel}. Use write_file to create new files.` }
  }
  const target = norm(oldStr)
  const replacement = norm(newStr)
  const count = current.split(target).length - 1
  if (count === 0) {
    return {
      ok: false,
      error: `old_string was not found in ${rel}. Read the file again and copy the exact text (whitespace matters).`
    }
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string appears ${count} times in ${rel}. Add more surrounding context to make it unique, or set replace_all: true.`
    }
  }
  const after = replaceAll ? current.split(target).join(replacement) : current.replace(target, replacement)
  await writeFileSafe(abs, after)
  rememberBefore(ctx, abs, current)
  ctx.touched.add(abs)
  const diff = makeDiff(ctx, abs, current, after)
  return {
    ok: true,
    output: `Edited ${rel} (+${diff.additions} −${diff.deletions})${replaceAll ? ` · ${count} occurrences` : ''}`,
    diff: [diff]
  }
}

async function toolMultiEdit(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const edits: any[] = Array.isArray(args.edits) ? args.edits : []
  if (!edits.length) return { ok: false, error: 'edits array is required' }
  const touched: FileDiff[] = []
  let currentTouched = ''
  for (const e of edits) {
    const res = await toolEditFile({ path: e.path, old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all }, ctx)
    if (!res.ok) return { ok: false, error: `${e.path}: ${res.error}`, diff: [...touched, ...(res.diff || [])] }
    if (res.diff) touched.push(...res.diff)
    currentTouched = e.path
  }
  return {
    ok: true,
    output: `Applied ${edits.length} edits across ${new Set(edits.map((e) => e.path)).size} file(s)${currentTouched ? ` — last: ${currentTouched}` : ''}`,
    diff: touched
  }
}

async function toolListDir(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '.')
  const abs = safeJoin(ctx.workspace, rel)
  const entries = await listDir(abs, ctx.workspace)
  const filtered = entries.filter((e) => !e.ignored || args.all)
  const lines = filtered.map((e) => (e.isDir ? `📁 ${e.rel}/` : `📄 ${e.rel} (${e.size}b)`))
  return { ok: true, output: lines.join('\n') || '(empty directory)', meta: { count: filtered.length } }
}

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`, 'i')
}

async function toolGlob(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const pattern = String(args.pattern || '*')
  const files = await walk(ctx.workspace, { maxFiles: 20000 })
  const re = globToRegex(pattern)
  const matched = files.filter((f) => re.test(toRel(ctx.workspace, f))).slice(0, 400)
  return { ok: true, output: matched.map((f) => toRel(ctx.workspace, f)).join('\n') || 'No files matched', meta: { count: matched.length } }
}

async function toolGrep(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const pattern = String(args.pattern || '')
  if (!pattern) return { ok: false, error: 'pattern is required' }
  let re: RegExp
  try {
    re = new RegExp(pattern, args.case_sensitive ? 'g' : 'gi')
  } catch (e: any) {
    return { ok: false, error: `Invalid regex: ${e.message}` }
  }
  const max = Number(args.max_results || 100)
  const files = await walk(ctx.workspace, { maxFiles: 8000 })
  const hits: string[] = []
  for (const f of files) {
    if (hits.length >= max) break
    const rel = toRel(ctx.workspace, f)
    if (args.glob && !globToRegex(String(args.glob)).test(rel)) continue
    if (isProbablyBinary(f)) continue
    try {
      const st = await fs.stat(f)
      if (st.size > 2 * 1024 * 1024) continue
      const text = await fs.readFile(f, 'utf8')
      if (!re.test(text)) continue
      re.lastIndex = 0
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (re.test(lines[i])) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
          if (hits.length >= max) break
        }
      }
    } catch {
      /* skip unreadable */
    }
  }
  return { ok: true, output: hits.join('\n') || 'No matches', meta: { count: hits.length } }
}

/** Run a shell command, capturing output. Interactive commands get a timeout. */
export async function runCommand(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; output: string; exitCode: number }> {
  const timeout = opts.timeoutMs ?? 180000
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/bash'
    const child = exec(
      command,
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        shell,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', CI: '1', TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const code = (err as any)?.code ?? 0
        const out = `${stdout || ''}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.replace(/\u001b\[[0-9;]*m/g, '')
        const timedOut = (err as any)?.killed
        resolve({
          ok: !err || code === 0,
          output: clamp(out || (err ? `${(err as any).message}` : ''), MAX_CMD_OUTPUT) + (timedOut ? `\n[command timed out after ${timeout}ms]` : ''),
          exitCode: code
        })
      }
    )
    if (opts.signal) {
      const onAbort = () => child.kill('SIGKILL')
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function toolRunCommand(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const command = String(args.command || '')
  if (!command) return { ok: false, error: 'command is required' }
  const cwd = args.cwd ? safeJoin(ctx.workspace, String(args.cwd)) : ctx.workspace
  const res = await runCommand(command, cwd, {
    timeoutMs: Math.min(Number(args.timeout_ms) || 120000, 600000),
    signal: ctx.signal
  })
  return {
    ok: res.ok,
    output: `$ ${command}\n${res.output}\n[exit ${res.exitCode}]`,
    error: res.ok ? undefined : `Command failed with exit code ${res.exitCode}`,
    meta: { command, exitCode: res.exitCode, cwd: toRel(ctx.workspace, cwd) || '.' }
  }
}

async function toolDelete(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  if (!rel) return { ok: false, error: 'path is required' }
  const abs = safeJoin(ctx.workspace, rel)
  if (path.resolve(abs) === path.resolve(ctx.workspace)) return { ok: false, error: 'Refusing to delete the workspace root' }
  const st = await fs.stat(abs).catch(() => null)
  if (!st) return { ok: false, error: `Not found: ${rel}` }
  let before: string | null = null
  if (st.isFile()) before = await fs.readFile(abs, 'utf8').catch(() => null)
  rememberBefore(ctx, abs, before)
  ctx.touched.add(abs)
  await fs.rm(abs, { recursive: true, force: true })
  return {
    ok: true,
    output: `Deleted ${rel}${st.isDirectory() ? '/' : ''}`,
    diff: st.isFile() ? [makeDiff(ctx, abs, before, null)] : undefined
  }
}

async function toolMove(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const from = String(args.from || '')
  const to = String(args.to || '')
  if (!from || !to) return { ok: false, error: 'from and to are required' }
  const absFrom = safeJoin(ctx.workspace, from)
  const absTo = safeJoin(ctx.workspace, to)
  await fs.mkdir(path.dirname(absTo), { recursive: true })
  await fs.rename(absFrom, absTo)
  ctx.touched.add(absFrom)
  ctx.touched.add(absTo)
  return { ok: true, output: `Moved ${from} → ${to}` }
}

function toolTodo(args: Record<string, any>, ctx: ToolContext): ToolOutcome {
  const raw: any[] = Array.isArray(args.todos) ? args.todos : []
  const todos: TodoItem[] = raw.map((t, i) => ({
    id: String(t.id || `todo-${i}-${Date.now()}`),
    text: String(t.text || t.content || ''),
    status: t.status === 'done' || t.status === 'completed' ? 'done' : t.status === 'in_progress' || t.status === 'active' ? 'in_progress' : 'pending'
  }))
  ctx.todos = todos
  ctx.onTodos(todos)
  const counts = { done: 0, in_progress: 0, pending: 0 } as Record<string, number>
  for (const t of todos) counts[t.status]++
  return {
    ok: true,
    output: `Plan updated: ${counts.done}/${todos.length} done, ${counts.in_progress} in progress`,
    meta: { todos }
  }
}

/* ------------------------------------------------------------------ */
/* Tool schemas exposed to the model                                   */
/* ------------------------------------------------------------------ */

export const TOOL_SCHEMAS: LlmToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the workspace. Returns content with line numbers so you can craft precise edits. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          start_line: { type: 'integer', description: '1-based first line (optional)' },
          end_line: { type: 'integer', description: 'last line inclusive (optional)' },
          line_numbers: { type: 'boolean', description: 'prefix each line with its number (default true)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or fully overwrite an existing one. Prefer edit_file for small changes. Content must be the complete final file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact string in a file. old_string must match character-for-character, including indentation and surrounding lines. Include 2-3 lines of context to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: 'replace every occurrence (default false)' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'multi_edit',
      description: 'Apply several exact-string edits in one call, across one or more files.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' }
              },
              required: ['path', 'old_string', 'new_string']
            }
          }
        },
        required: ['edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries of a directory in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path, defaults to workspace root' },
          all: { type: 'boolean', description: 'include normally-ignored folders like node_modules' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.test.tsx".',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regular expression. Returns "path:line: text" matches. Use to find usages before refactoring.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression' },
          glob: { type: 'string', description: 'optional file glob filter, e.g. "**/*.ts"' },
          case_sensitive: { type: 'boolean' },
          max_results: { type: 'integer' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace (builds, tests, package managers, git). Non-interactive only. Use && to chain. Never run commands that need interactive input.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'optional working directory relative to workspace' },
          timeout_ms: { type: 'integer' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Delete a file or directory in the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description: 'Move or rename a file or directory.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Maintain the visible task plan. Call it first for any multi-step task, and update statuses as you go. Exactly one item may be in_progress.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'] }
              },
              required: ['text', 'status']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a clarifying question when a decision is genuinely ambiguous or risky. Stops the run until they answer.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: '2-4 suggested answers' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call when the task is fully complete. Provide a concise summary of what changed and how it was verified.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary']
      }
    }
  }
]

export const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'todo_write'])
export const DESTRUCTIVE_TOOLS = new Set(['run_command', 'delete_path', 'move_path'])
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'delete_path', 'move_path'])

export function toolNeedsApproval(name: string, policy: 'ask' | 'auto-edit' | 'yolo'): boolean {
  if (policy === 'yolo') return false
  if (READ_ONLY_TOOLS.has(name)) return false
  if (policy === 'auto-edit') return DESTRUCTIVE_TOOLS.has(name)
  // ask policy
  if (MUTATING_TOOLS.has(name)) return true
  if (name === 'run_command') return true
  return false
}

export function languageOf(p: string): string {
  return languageFor(p)
}
