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
import { getSettings } from './store'
import type { FileDiff, TodoItem, ToolResultView } from '../shared/types'
import type { LlmToolSchema } from './llm'

export interface ToolContext {
  workspace: string
  /** every folder the session may touch: primary first, then extras */
  roots: string[]
  /** no sandbox: absolute paths anywhere on the machine are allowed */
  fullDisk?: boolean
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
  /** human explanation shown next to the error in the transcript */
  locale?: string
  /** extra data for renderer */
  meta?: Record<string, any>
  /**
   * Something the user should hear about even if they are not looking at the
   * window: a completion, a blocker, a decision they may want to veto.
   */
  notify?: { title: string; body: string; urgent?: boolean }
  /** abort the whole run (e.g. user said stop, or ask_user) */
  halt?: 'done' | 'error' | 'aborted'
}

const MAX_OUTPUT = 30000
const MAX_CMD_OUTPUT = 24000

function clamp(s: string, n = MAX_OUTPUT): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `\n… [truncated ${s.length - n} chars]`
}

/** Roots for fs helpers that take an optional base for relative paths. */
function rootsOf(ctx: ToolContext): string | string[] {
  return ctx.roots.length ? ctx.roots : ctx.workspace
}

/** Relative to a root when inside one, otherwise the absolute path. */
function relOrAbs(ctx: ToolContext, abs: string): string {
  const roots = ctx.roots.length ? ctx.roots : [ctx.workspace]
  for (const r of roots) {
    const rr = path.resolve(r)
    const a = path.resolve(abs)
    if (a === rr) return '.'
    if (a.startsWith(rr + path.sep)) return path.relative(rr, a).split(path.sep).join('/')
  }
  return abs
}

function makeDiff(ctx: ToolContext | { workspace: string; roots?: string[]; fullDisk?: boolean }, abs: string, before: string | null, after: string | null): FileDiff {
  const full = ctx as ToolContext
  const rel = full.roots ? relOrAbs(full, abs) : toRel(ctx.workspace, abs)
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
      case 'notify_user':
        return {
          ok: true,
          output: 'The user was notified on their desktop.',
          notify: {
            title: String(args.title || 'Comb Chat'),
            body: String(args.body || ''),
            urgent: !!args.urgent
          }
        }
      case 'ask_user':
        // A non-blocking vote: the question is shown as pickable cards while the
        // run continues. The loop decides what to do with a missing answer.
        return {
          ok: true,
          output: `Question shown to the user: ${args.question || ''}${args.recommend ? ` (your default: ${args.recommend})` : ''}`,
          meta: { question: args.question, options: args.options },
          notify:
            args.quiet === true
              ? undefined
              : {
                  title: String(args.title || 'Нужно ваше решение'),
                  body: String(args.question || ''),
                  urgent: false
                }
        }
      case 'leave_note':
        // the agent's own sticky note for the user: a loose end, a warning, a
        // "you still need to do X". It shows up in the notes panel, not the log.
        return {
          ok: true,
          output: 'Note left on the board for the user.',
          meta: {
            note: {
              text: String(args.text || '').slice(0, 400),
              target: args.target ? String(args.target) : undefined,
              tone: Number(args.tone) || 2
            }
          }
        }
      case 'suggest':
        // Follow-up chips under the answer: one click starts the next task.
        return {
          ok: true,
          output: `Suggested: ${(args.options || []).join(' | ')}`,
          meta: { suggestions: (Array.isArray(args.options) ? args.options : []).slice(0, 4) }
        }
      case 'attach_file':
        return await toolAttachFile(args, ctx)
      case 'finish':
        return { ok: true, output: args.summary || 'Task finished.', halt: 'done' }
      default:
        return { ok: false, error: `Unknown tool: ${name}` }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** Kept as a named export so the agent can read the line the model wrote. */
export function toolNote(args: Record<string, any>): string {
  const v = args?.note
  return typeof v === 'string' ? v.trim().slice(0, 600) : ''
}

/* ------------------------------------------------------------------ */

async function toolAttachFile(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  if (!rel) return { ok: false, error: 'path is required' }
  const abs = safeJoin(ctx.roots, rel, ctx.fullDisk)
  let isDir = false
  try {
    isDir = (await fs.stat(abs)).isDirectory()
  } catch {
    return { ok: false, error: `File not found: ${rel}` }
  }
  if (isDir) return { ok: false, error: `${rel} is a directory — attach a single file` }
  const shown = relOrAbs(ctx, abs)
  return {
    ok: true,
    output: `Attached ${shown} to the chat${args.note ? ` — ${args.note}` : ''}`,
    meta: { attach: { path: abs, rel: shown, note: String(args.note || '') } }
  }
}

async function toolReadFile(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  if (!rel) return { ok: false, error: 'path is required' }
  const abs = safeJoin(ctx.roots, rel, ctx.fullDisk)
  const st = await fs.stat(abs)
  if (st.isDirectory()) {
    const entries = await listDir(abs, rootsOf(ctx))
    return { ok: true, output: entries.map((e) => (e.isDir ? `${e.rel}/` : e.rel)).join('\n'), meta: { isDir: true } }
  }
  if (st.size > 1024 * 1024) {
    const fc = await readFileSafe(abs, rootsOf(ctx))
    return { ok: true, output: clamp(fc.content), meta: { truncated: true, size: st.size } }
  }
  const fc = await readFileSafe(abs, rootsOf(ctx))
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
  const abs = safeJoin(ctx.roots, rel, ctx.fullDisk)
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
  const abs = safeJoin(ctx.roots, rel, ctx.fullDisk)
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
  const abs = safeJoin(ctx.roots, rel, ctx.fullDisk)
  const entries = await listDir(abs, rootsOf(ctx))
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

/** Walk every attached root, tagging files with the root they came from. */
async function walkAll(ctx: ToolContext, maxFiles: number): Promise<{ abs: string; rel: string; root: string }[]> {
  const roots = ctx.roots.length ? ctx.roots : [ctx.workspace]
  const out: { abs: string; rel: string; root: string }[] = []
  for (const root of roots) {
    if (out.length >= maxFiles) break
    const files = await walk(root, { maxFiles: maxFiles - out.length })
    for (const abs of files) out.push({ abs, rel: toRel(root, abs), root })
  }
  return out
}

async function toolGlob(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const pattern = String(args.pattern || '*')
  const files = await walkAll(ctx, 20000)
  const re = globToRegex(pattern)
  const matched = files.filter((f) => re.test(f.rel))
  // with several roots the prefix matters, otherwise two README.md look identical
  const multi = (ctx.roots.length || 1) > 1
  const shown = matched.slice(0, 400).map((f) => (multi ? `${path.basename(f.root)}/${f.rel}` : f.rel))
  return { ok: true, output: shown.join('\n') || 'No files matched', meta: { count: matched.length } }
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
  const files = await walkAll(ctx, 8000)
  const hits: string[] = []
  for (const f of files) {
    if (hits.length >= max) break
    const rel = f.rel
    if (args.glob && !globToRegex(String(args.glob)).test(rel)) continue
    if (isProbablyBinary(f.abs)) continue
    try {
      const st = await fs.stat(f.abs)
      if (st.size > 2 * 1024 * 1024) continue
      const text = await fs.readFile(f.abs, 'utf8')
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
/**
 * Turn "exit 255" into something a person can act on.
 *
 * 255 is what `git` returns when it cannot find a repository (and what a shell
 * returns for an unknown command in some setups), so we check for that and say
 * it plainly instead of echoing the number.
 */
async function explainExit(code: number, command: string, cwd: string): Promise<string> {
  if (code === 0) return ''
  const ru = (await getSettings().catch(() => null))?.locale === 'ru'
  if (code === 255) {
    const looksGit = /^\s*git\b/.test(command)
    const inRepo = await fs
      .stat(path.join(cwd, '.git'))
      .then(() => true)
      .catch(() => false)
    if (looksGit && !inRepo) {
      return ru
        ? `255 — git не видит здесь репозиторий (в ${cwd} нет папки .git). Либо сделайте \`git init\`, либо откройте корень проекта.`
        : `exit 255 — git says this folder is not a repository (no .git in ${cwd}). Initialize it with \`git init\`, or open the project root instead.`
    }
    return ru
      ? '255 — программа не смогла запуститься: чаще всего git без репозитория, отсутствующий файл или сетевая/SSH-ошибка.'
      : 'exit 255 — the program could not run here (usually: git with no repository, a missing executable, or an SSH/network failure).'
  }
  if (code === 127)
    return ru ? '127 — команда не найдена: оболочка не знает такой программы.' : 'exit 127 — command not found: the shell does not know this program.'
  if (code === 126) return ru ? '126 — файл не является исполняемым.' : 'exit 126 — file is not executable.'
  if (code === 128)
    return ru
      ? '128 — git завершился с фатальной ошибкой (плохое состояние репозитория или неверная ревизия).'
      : 'exit 128 — git failed fatally (bad repository state or a bad revision).'
  if (code === 2)
    return ru
      ? '2 — команда использована неверно: неправильные аргументы или нет такого пути.'
      : 'exit 2 — the command was used incorrectly (bad arguments or a missing path).'
  return ru ? `код выхода ${code}` : `exit ${code}`
}

/* ------------------------------------------------------------------ */
/* Command output decoding                                             */
/* ------------------------------------------------------------------ */

const CP866_HIGH =
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюяЁё░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■\u00a0'

/**
 * Windows' cmd.exe writes in the OEM code page (866 for Russian, 850/437 for
 * others), so Cyrillic file names arrive as "ЁюфхЁ" garbage. Recover them by
 * mapping the high bytes through CP866 when the text is not valid UTF-8 anyway.
 */
export function decodeCommandOutput(buf: Buffer): string {
  if (process.platform !== 'win32') return buf.toString('utf8')
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\ufffd')) return utf8
  let out = ''
  for (const b of buf) {
    if (b < 0x80) out += String.fromCharCode(b)
    else {
      const idx = b - 0x80
      out += idx < CP866_HIGH.length ? CP866_HIGH[idx] : '\ufffd'
    }
  }
  return out
}

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
        windowsHide: true,
        encoding: 'buffer'
      },
      (err, stdoutBuf, stderrBuf) => {
        const stdout = Buffer.isBuffer(stdoutBuf) ? decodeCommandOutput(stdoutBuf) : String(stdoutBuf || '')
        const stderr = Buffer.isBuffer(stderrBuf) ? decodeCommandOutput(stderrBuf) : String(stderrBuf || '')
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
  const cwd = args.cwd ? safeJoin(ctx.roots, String(args.cwd), ctx.fullDisk) : ctx.workspace
  const res = await runCommand(command, cwd, {
    timeoutMs: Math.min(Number(args.timeout_ms) || 120000, 600000),
    signal: ctx.signal
  })
  const why = res.ok ? '' : await explainExit(res.exitCode, command, cwd)
  return {
    ok: res.ok,
    output: `$ ${command}\n${res.output}\n[exit ${res.exitCode}]`,
    error: res.ok ? undefined : `Command failed with exit code ${res.exitCode}`,
    locale: why || undefined,
    meta: { command, exitCode: res.exitCode, cwd: toRel(ctx.roots, cwd) || '.' }
  }
}

async function toolDelete(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  if (!rel) return { ok: false, error: 'path is required' }
  const abs = safeJoin(ctx.roots, rel, ctx.fullDisk)
  if (ctx.roots.some((r) => path.resolve(abs) === path.resolve(r))) return { ok: false, error: 'Refusing to delete a workspace root' }
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
  const absFrom = safeJoin(ctx.roots, from, ctx.fullDisk)
  const absTo = safeJoin(ctx.roots, to, ctx.fullDisk)
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
/* Dry-run previews (no writes) — used for approval prompts            */
/* ------------------------------------------------------------------ */

export async function previewTool(
  name: string,
  args: Record<string, any>,
  workspace: string,
  fullDisk = false
): Promise<FileDiff[] | undefined> {
  const readCurrent = async (abs: string): Promise<string | null> => {
    try {
      return norm(await fs.readFile(abs, 'utf8'))
    } catch {
      return null
    }
  }
  try {
    if (name === 'write_file') {
      const abs = safeJoin(workspace, String(args.path || ''), fullDisk)
      const before = await readCurrent(abs)
      const after = String(args.content ?? '')
      if (before === after) return undefined
      return [makeDiff({ workspace } as ToolContext, abs, before, after)]
    }
    if (name === 'edit_file' || name === 'multi_edit') {
      const edits: { path: string; oldStr: string; newStr: string; all?: boolean }[] =
        name === 'edit_file'
          ? [{ path: String(args.path || ''), oldStr: String(args.old_string ?? ''), newStr: String(args.new_string ?? ''), all: !!args.replace_all }]
          : (Array.isArray(args.edits) ? args.edits : []).map((e: any) => ({
              path: String(e.path || ''),
              oldStr: String(e.old_string ?? ''),
              newStr: String(e.new_string ?? ''),
              all: !!e.replace_all
            }))
      const byFile = new Map<string, { before: string | null; after: string }>()
      for (const e of edits) {
        const abs = safeJoin(workspace, e.path, fullDisk)
        const current = byFile.has(abs) ? byFile.get(abs)!.after : await readCurrent(abs)
        if (current === null) continue
        const target = norm(e.oldStr)
        if (!target || !current.includes(target)) continue
        const after = e.all ? current.split(target).join(norm(e.newStr)) : current.replace(target, norm(e.newStr))
        byFile.set(abs, { before: byFile.get(abs)?.before ?? current, after })
      }
      const diffs: FileDiff[] = []
      for (const [abs, { before, after }] of byFile) {
        if (before === after) continue
        diffs.push(makeDiff({ workspace } as ToolContext, abs, before, after))
      }
      return diffs.length ? diffs : undefined
    }
  } catch {
    /* preview is best-effort */
  }
  return undefined
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
          path: {
            type: 'string',
            description: 'Path relative to the workspace root, or an absolute path anywhere on disk when full-disk access is on'
          },
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
      description:
        'List the entries of a directory. With several folders attached, prefix the path with the folder name (e.g. "api/src") or pass an absolute path inside one of them.',
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
      description:
        'Ask the user for a decision you cannot make for them — a product choice, a taste call, missing knowledge ("which particles should I use? are we adding particles at all?"), or a permission to do something surprising. It does NOT block the run: the question appears as cards and you keep working with your recommended option if nobody answers in time. Phrase options as short pickable answers. Never use it for things you can settle by reading the code, and never twice in a row.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One short question, in the interface language' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description:
              '2-4 short concrete answers, starting with the default you would pick ("Да, делаю", "Нет, не надо", …). Do not add "something else" — the user can always type their own.'
          },
          recommend: { type: 'string', description: 'The option you will go with if the user stays silent, verbatim from the list' },
          waitSeconds: {
            type: 'number',
            description: 'How long to hold before continuing with `recommend` (15-180, default 90). Use a larger value when the answer really matters.'
          },
          quiet: { type: 'boolean', description: 'true = do not ring the desktop, just show the card (for a low-stakes question)' }
        },
        required: ['question', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'leave_note',
      description:
        'Leave a sticky note on the user board: something they must know or do that is not part of the current task ("the mock data is fake, replace before release", "I did not touch the legacy billing page"). Use it instead of burying the warning in prose. Never more than 3 per run.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One sentence, in the interface language' },
          target: { type: 'string', description: 'Optional file or folder this note is about' },
          tone: { type: 'number', description: '0-5 colour slot, pick something different from the previous note' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'suggest',
      description:
        'Offer follow-up actions as clickable chips under your answer — the user clicks one and it becomes their next request. Use it when a natural next step exists, so the user does not have to type it. Never more than 4, never generic filler.',
      parameters: {
        type: 'object',
        properties: {
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2-4 imperative follow-ups, in the interface language, e.g. "Добавить тесты на этот экран"'
          }
        },
        required: ['options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notify_user',
      description:
        'Send a desktop notification to the user when they are probably not watching the app: the task finished, a long step finished, you are blocked, or you found something they should know now. Never use it for progress chatter — at most a few times per task.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short headline, in the interface language' },
          body: { type: 'string', description: 'One or two sentences: what happened and what happens next' },
          urgent: { type: 'boolean', description: 'true when the run is blocked and needs them' }
        },
        required: ['title', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'attach_file',
      description:
        'Hand a file to the user in the chat instead of telling them to go find it: a report, a generated asset, a config, a diff. The file must exist. The user gets a preview window with an "open" button and its path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, relative to the workspace or absolute' },
          note: { type: 'string', description: 'One line: why this file matters' }
        },
        required: ['path']
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

export const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'todo_write', 'attach_file'])
export const DESTRUCTIVE_TOOLS = new Set(['run_command', 'delete_path', 'move_path'])
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'delete_path', 'move_path'])

/**
 * Does this tool call need a human before it runs?
 *
 * `granted` holds tool names the user already allowed with "always" (persisted in
 * Settings → Agent). It is checked here, not only inside the approval request:
 * a surface that never asks would otherwise silently ignore the grant.
 */
export function toolNeedsApproval(
  name: string,
  policy: 'ask' | 'auto-edit' | 'yolo',
  granted?: Iterable<string> | Set<string>
): boolean {
  if (policy === 'yolo') return false
  if (READ_ONLY_TOOLS.has(name)) return false
  if (granted && [...granted].includes(name)) return false
  if (policy === 'auto-edit') return DESTRUCTIVE_TOOLS.has(name)
  // ask policy
  if (MUTATING_TOOLS.has(name)) return true
  if (name === 'run_command') return true
  return false
}

export function languageOf(p: string): string {
  return languageFor(p)
}
