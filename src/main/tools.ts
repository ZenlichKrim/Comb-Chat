import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { createTwoFilesPatch } from 'diff'
import {
  imageMime,
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
import { homeDirs, installedApps, listDrives, renderFound, scoreAppMatch, searchDirs } from './discover'
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

/**
 * Oversized output is not thrown away.
 *
 * Cutting a build log at 24k chars taught the model to re-run the same command
 * and squint at the same first page forever — the failure lines are always at the
 * end. So the full text is written to a file inside the project's cache folder,
 * and the model gets a head, a tail and a path it can read with an offset. The
 * bytes stay reachable; the context stays small.
 */
const SPILL_DIR = '.comb'

export async function spillText(ctx: ToolContext, label: string, text: string, n: number, keepTail = 120): Promise<string> {
  const head = text.slice(0, n)
  const tail = keepTail > 0 ? text.slice(-keepTail) : ''
  try {
    const dir = path.join(ctx.workspace, SPILL_DIR, 'output')
    await fs.mkdir(dir, { recursive: true })
    const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'output'
    const file = path.join(dir, `${Date.now().toString(36)}-${safe}.txt`)
    await fs.writeFile(file, text, 'utf8')
    const rel = path.relative(ctx.workspace, file)
    return (
      head +
      `\n… [output trimmed: ${text.length - n} chars not shown]\n` +
      (tail ? `[last ${tail.length} chars]\n${tail}\n` : '') +
      `[full output (${text.length} chars) saved to ${rel} — read it with read_file({"path":"${rel}","offset":1}) or grep it instead of re-running the command]`
    )
  } catch {
    return clamp(text, n)
  }
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
              tone: Number(args.tone) || 2,
              // What the note *is*: an idea is not a gripe, and the board shows
              // them differently. An agent working on a creative task should be
              // able to think out loud on paper instead of burying the thought
              // in a paragraph nobody scrolls back to.
              kind: ['idea', 'risk', 'todo', 'question'].includes(String(args.kind)) ? String(args.kind) : 'todo'
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
      case 'preview_page':
        return await toolPreviewPage(args, ctx)
      case 'view_image':
        return await toolViewImage(args, ctx)
      case 'web_search':
        return await toolWebSearch(args)
      case 'read_url':
        return await toolReadUrl(args)
      case 'tool_help':
        return toolHelp(args)
      case 'find_path':
        return await toolFindPath(args, ctx)
      case 'find_app':
        return await toolFindApp(args)
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

/**
 * Find a thing on the machine when nobody said where it is.
 *
 * This is the first real step of three of the jobs the user keeps asking for:
 * the Peak game folder, Roblox Studio, a jar that was built somewhere. `glob`
 * only looks inside the open project (and the folder next to it), so the honest
 * answer used to be "no matches" while the game sat on D:\.
 *
 * The search is bounded by entries and by time, and it reports where it looked,
 * so a miss is a fact the model can act on instead of a shrug.
 */
async function toolFindPath(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const query = String(args.name || args.query || '').trim()
  if (!query) return { ok: false, error: 'name is required (a substring or a simple *pattern*)' }
  const kind = args.kind === 'file' || args.kind === 'dir' ? args.kind : 'any'
  const depth = Math.min(Math.max(Number(args.depth) || 4, 1), 8)
  const limit = Math.min(Math.max(Number(args.limit) || 40, 1), 100)
  const maxMs = Math.min(Math.max(Number(args.max_ms) || 20000, 1000), 120000)

  // a pattern with * or ? is a glob over the name; otherwise a case-insensitive substring
  const hasGlob = /[*?]/.test(query)
  const nameRe = hasGlob
    ? new RegExp('^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

  let starts: string[]
  if (args.root) {
    starts = [safeJoin(ctx.roots, String(args.root), true)]
  } else if (ctx.fullDisk) {
    starts = [...homeDirs(), ...(await listDrives())]
  } else {
    starts = ctx.roots.length ? ctx.roots : [ctx.workspace]
  }

  const skipped = new Set(['appdata'])
  const res = await searchDirs(starts, { nameRe, want: kind, depth, maxEntries: 80000, maxMs, skip: skipped })
  const seen = new Set<string>()
  const entries = res.entries.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)))
  if (!entries.length) {
    return {
      ok: true,
      output:
        `Nothing named like "${query}" under ${res.visited.length} folders (${starts.slice(0, 6).join(', ')}${starts.length > 6 ? ', …' : ''}), ${depth} levels deep.` +
        (res.truncated ? '\nThe budget ran out before the search was finished — pass a `root` to search a specific drive, or raise depth.' : '\nThe search finished; the thing is not there under that name.') +
        (ctx.fullDisk ? '' : '\nFull disk access is off, so only the open folders were searched.'),
      meta: { count: 0, truncated: res.truncated }
    }
  }
  return {
    ok: true,
    output:
      `Found ${entries.length}${res.truncated ? '+' : ''} match(es) for "${query}":\n` +
      renderFound(entries, limit) +
      (res.truncated ? '\n(the entry budget ran out — raise `root`/`depth` if the one you need is not listed)' : ''),
    meta: { count: entries.length, truncated: res.truncated }
  }
}

/**
 * Find an installed application and hand back its folder.
 *
 * "Find the studio and start in it" is a request about software the machine
 * already has. Guessing `C:\Program Files\Roblox` wastes rounds; the system
 * knows, so this asks the system.
 */
async function toolFindApp(args: Record<string, any>): Promise<ToolOutcome> {
  const query = String(args.name || '').trim()
  if (!query) return { ok: false, error: 'name is required' }
  const apps = await installedApps()
  const scored = apps
    .map((a) => ({ ...a, score: scoreAppMatch(a.name, query) + scoreAppMatch(path.basename(a.path || ''), query) }))
    .filter((a) => a.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
  if (!scored.length) {
    return {
      ok: true,
      output:
        `No installed application matches "${query}" (checked ${apps.length} registered apps).\n` +
        'Try find_path with a name like "studio.exe" or the product name, or ask the user where they installed it.'
    }
  }
  return {
    ok: true,
    output:
      `Installed apps matching "${query}":\n` +
      scored.map((a) => `${a.name} — ${a.path || '(no install folder)'} [${a.why}]`).join('\n') +
      '\nThe folder listed is the app root: read its files there, or open the project you need inside it.',
    meta: { count: scored.length }
  }
}

/** HTML targets whose picture is worth a real browser: they draw to a canvas. */
const CANVAS_HINT = /<canvas|three\.module|three\.min\.js|new\s+THREE\.|getContext\(['"]webgl/i

/**
 * Take a picture of a page so the agent can see its own design.
 *
 * "Красивый, продуманный интерфейс" is a promise no file listing can keep: a
 * layout is judged by looking at it. Chrome and Edge ship with every Windows and
 * most Linux machines, so a headless screenshot needs no new dependency — the
 * same window the user would open, rendered to a PNG the model can actually see.
 * Canvas/WebGL pages need the real browser; a static HTML file is rendered as is.
 */
async function toolPreviewPage(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  if (!rel) return { ok: false, error: 'path is required (an .html file or an http(s) URL)' }
  const isUrl = /^https?:\/\//i.test(rel)
  const target = isUrl ? rel : safeJoin(ctx.roots, rel, ctx.fullDisk)
  const size = String(args.size || '1440,900')
  if (!/^\d{2,5},\d{2,5}$/.test(size)) return { ok: false, error: 'size must look like "1440,900"' }
  if (!isUrl) {
    const st = await fs.stat(target).catch(() => null)
    if (!st) return { ok: false, error: `Not found: ${rel}` }
  }
  const outDir = path.join(ctx.workspace, '.comb', 'shots')
  await fs.mkdir(outDir, { recursive: true }).catch(() => {})
  const out = path.join(outDir, `${Date.now().toString(36)}-preview.png`)
  const url = isUrl ? target : `file:///${target.replace(/\\/g, '/').replace(/^\//, '')}`
  const waitMs = Math.min(Math.max(Number(args.wait_ms) || 1500, 0), 15000)

  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : []
  const bins = process.platform === 'linux'
    ? ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
    : candidates.filter((c) => true)
  /** a bare command name is only usable if it really is on PATH */
  const onPath = async (name: string): Promise<string> =>
    new Promise((resolve) => {
      exec(process.platform === 'win32' ? `where ${name}` : `command -v ${name}`, { windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').split(/\r?\n/)[0].trim())
      })
    })
  let used = ''
  let bin = ''
  if (args.binary) {
    const wanted = String(args.binary)
    const exists = wanted.includes('/') || wanted.includes('\\')
      ? await fs.access(wanted).then(() => true).catch(() => false)
      : !!(await onPath(wanted))
    if (!exists) {
      return {
        ok: false,
        error:
          `No browser at ${wanted}. Point \`binary\` at a Chromium-based browser, or fix the layout from the CSS and say the design was not seen.`
      }
    }
    bin = wanted
  } else {
    for (const candidate of bins) {
      if (candidate.includes('/') || candidate.includes('\\')) {
        const ok = await fs.access(candidate).then(() => true).catch(() => false)
        if (ok) {
          bin = candidate
          break
        }
      } else {
        const real = await onPath(candidate)
        if (real) {
          bin = real
          break
        }
      }
    }
  }
  if (!bin) {
    return {
      ok: false,
      error:
        'No Chrome, Chromium or Edge found to render the page. Read the CSS and the markup and fix what you can prove is wrong ' +
        '(contrast, spacing, hierarchy), and tell the user the design was not seen — do not claim it looks good. ' +
        'Row of escape: pass `binary` with the full path of a Chromium-based browser if one is installed somewhere unusual.'
    }
  }
  const cmd = [
    `"${bin}"`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    `--virtual-time-budget=${waitMs}`,
    `--window-size=${size}`,
    `--screenshot="${out}"`,
    `"${url}"`
  ].join(' ')

  const res = await new Promise<{ code: number; out: string }>((resolve) => {
    exec(cmd, { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout || ''}${stderr || ''}`.slice(-1200) })
    })
  })
  used = res.out
  const made = await fs.stat(out).catch(() => null)
  if (res.code !== 0 || !made) {
    return {
      ok: false,
      error: `The browser exited with ${res.code} and wrote no picture. ${used}`.trim(),
      output: used
    }
  }
  const data = await fs.readFile(out)
  const mime = imageMime(out) || 'image/png'
  return {
    ok: true,
    output:
      `Screenshot of ${isUrl ? rel : rel} at ${size} (${Math.round(made.size / 1024)} KB) → ${path.relative(ctx.workspace, out)}\n` +
      'It is attached to your next message: look at it and judge the layout — spacing, hierarchy, contrast, what the eye hits first. ' +
      'Fix what looks wrong, then take another picture and compare.',
    meta: { imageUrl: `data:${mime};base64,${data.toString('base64')}`, imageRel: path.relative(ctx.workspace, out), screenshot: out }
  }
}

/**
 * A help page the model can ask for in the middle of a run. Agents do not know
 * the details of the tools they were handed — which arguments matter, what the
 * limits are, how to hand a big output back without drowning the context — and
 * guessing costs a whole failed call. This is the reference, kept in one place so
 * a new tool cannot be added without its own line here.
 */
function toolHelp(args: Record<string, any>): ToolOutcome {
  const brief = toolHelpText().split('\n\n')
  const name = String(args.name || '').trim()
  if (!name) {
    const titles = brief.map((b) => b.split('\n')[0]).join('\n')
    return { ok: true, output: `Tools in this run (\`tool_help({"name":"..."})\` for the full entry):\n${titles}` }
  }
  const hit = brief.find((b) => b.startsWith(name + ' —') || b.startsWith(name + '\n'))
  if (!hit) return { ok: false, error: `No tool named ${name}. Known: ${brief.map((b) => b.split(/[\s—]/)[0]).join(', ')}` }
  return { ok: true, output: hit }
}

function toolHelpText(): string {
  return `read_file — read one file (or up to 8 with \`paths\`). \`offset\`/\`limit\` in lines for a big file; the answer tells you when a file was truncated, so ask for the next range instead of guessing.

write_file — create a file or rewrite it whole. Creates parent folders.

edit_file — exact string replacement. Include enough surrounding lines for a unique match; pass the old text verbatim, indentation included.

multi_edit — several edits in one call, each with path/old/new. Use it instead of five separate rounds.

list_dir — names in a folder, one level. \`recursive\` for a tree; hidden files are skipped unless asked.

glob — path patterns like \`src/**/*.ts\`, newest first.

grep — regex search with file and line numbers; \`glob\` narrows the files.

run_command — non-interactive shell, network allowed, 5 min default, pass \`timeout_ms\` (max 900000) for builds. Big output is saved to .comb/output and you get the path — read or grep that file instead of re-running the command. Workaround: \`GIT_PAGER=cat\`, no vim, no watchers, no servers that never exit.

todo_write — replaces the whole plan. Keep it short and honest: an item you cannot close in this run does not belong there.

attach_file — put a real file into the chat with a path and an open button.

find_path — find a file or folder anywhere on the machine when nobody said where it is: a game on another drive, a mod folder, a jar built earlier. Searches the user folders and every mounted drive under full access; pass root to search one folder.

find_app — the folder of an installed application, from the system's own app list (Roblox Studio, Unity, Blender). Use it instead of guessing a Program Files path.

preview_page — render an HTML page or local app in headless Chrome and look at the screenshot. This is how a design is judged: take the shot, then fix what the eye says.

view_image — look at a screenshot or texture; the picture is added to your next message.

web_search — live search, supports site:, -site:, ""phrase"", lang:, after:YYYY-MM-DD.

read_url — one page as markdown.

ask_user — a real fork in the road; you keep working with \`recommend\` while it waits.

leave_note — a sticky note for something the user must know later.

suggest — 2-4 clickable next steps under the answer.

notify_user — desktop ping when the user is probably away.

finish — after the work, never after the plan; the summary is read as your report.`
}

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
  // Several files in one call: exploration is where runs bleed time, and one call
  // per file costs a whole round trip each.
  if (Array.isArray(args.paths) && args.paths.length) {
    const paths = (args.paths as unknown[]).map((p) => String(p)).filter(Boolean).slice(0, 8)
    if (!paths.length) return { ok: false, error: 'paths is empty' }
    const parts: string[] = []
    let anyOk = false
    for (const p of paths) {
      try {
        const one = await toolReadFile({ ...args, paths: undefined, path: p }, ctx)
        anyOk = anyOk || one.ok
        parts.push(`===== ${p} =====\n${one.ok ? one.output : `ERROR: ${one.error}`}`)
      } catch (e: any) {
        parts.push(`===== ${p} =====\nERROR: ${e?.message || 'failed'}`)
      }
    }
    return { ok: anyOk, output: clamp(parts.join('\n\n')), error: anyOk ? undefined : 'no file could be read' }
  }
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
  // A bare list_dir in full access mode answers the question people actually
  // ask first: where am I, and what is around me. Otherwise the agent has to
  // guess a parent path or ask the user, which is how a run stalls on step one.
  if (!args.path && ctx.fullDisk) {
    const lines: string[] = []
    const ws = ctx.workspace ? path.resolve(ctx.workspace) : ''
    if (ws) lines.push(`workspace: ${ws}`)
    const sibs = await siblingDirs(ctx)
    if (sibs.length) {
      lines.push(`folders next to it (${sibs.length}):`)
      for (const d of sibs) lines.push(`📁 ${path.basename(d)}/`)
    }
    if (!lines.length) lines.push('No workspace is open; full disk access is on, so absolute paths work.')
    return { ok: true, output: lines.join('\n'), meta: { count: sibs.length } }
  }
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

/**
 * Where "look around" may actually look.
 *
 * With full access the workspace is a starting point, not a fence: searching for
 * a project in a neighbouring folder is the first thing anyone does, and the old
 * behaviour answered "path escapes workspace" while the user had already granted
 * YOLO. The parent directory is searched one level deep, skipping the heavy
 * folders nobody means (node_modules, .git, build outputs).
 */
const HEAVY = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', '.next', '.venv', 'venv', '__pycache__'])

async function siblingDirs(ctx: ToolContext): Promise<string[]> {
  if (!ctx.fullDisk) return []
  const base = ctx.workspace ? path.dirname(path.resolve(ctx.workspace)) : ''
  if (!base || base === path.parse(base).root) return []
  try {
    const entries = await fs.readdir(base, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !HEAVY.has(e.name) && !e.name.startsWith('.'))
      .map((e) => path.join(base, e.name))
      .slice(0, 40)
  } catch {
    return []
  }
}

async function toolGlob(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const pattern = String(args.pattern || '*')
  const files = await walkAll(ctx, 20000)
  const re = globToRegex(pattern)
  let matched = files.filter((f) => re.test(f.rel))
  let searchedSiblings = false
  // Nothing here? With full access, look at the folders next to the workspace
  // before answering "no matches": the user's project may simply live there.
  if (!matched.length && ctx.fullDisk) {
    searchedSiblings = true
    for (const dir of await siblingDirs(ctx)) {
      const deep = await walk(dir, { maxFiles: 4000 }).catch(() => [] as string[])
      for (const abs of deep) {
        const rel = path.join(path.basename(dir), path.relative(dir, abs)).split(path.sep).join('/')
        if (re.test(rel)) matched.push({ abs, rel, root: dir })
        if (matched.length > 400) break
      }
      if (matched.length > 400) break
    }
  }
  // with several roots the prefix matters, otherwise two README.md look identical
  const multi = (ctx.roots.length || 1) > 1
  const shown = matched.slice(0, 400).map((f) => (multi ? `${path.basename(f.root)}/${f.rel}` : f.rel))
  const head = searchedSiblings ? `(searched the folders next to ${ctx.workspace})\n` : ''
  return { ok: true, output: head + (shown.join('\n') || 'No files matched'), meta: { count: matched.length } }
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
  const timeout = opts.timeoutMs ?? 300000
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
    timeoutMs: Math.min(Number(args.timeout_ms) || 300000, 900000),
    signal: ctx.signal
  })
  const why = res.ok ? '' : await explainExit(res.exitCode, command, cwd)
  // A big log is evidence, not noise: keep the head and the tail, spill the rest.
  const body = res.output.length > MAX_CMD_OUTPUT
    ? await spillText(ctx, command.split(/\s+/)[0], res.output, MAX_CMD_OUTPUT, 4000)
    : res.output
  return {
    ok: res.ok,
    output: `$ ${command}\n${body}\n[exit ${res.exitCode}]`,
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

/**
 * Look at an image that lives on disk.
 *
 * Without this the model could only ever see images that the user dragged into
 * the composer: a screenshot sitting in the project, a texture it just wrote, a
 * generated icon — all invisible, so it guessed. The result carries a marker the
 * agent loop turns into a real image block on the next request.
 */
async function toolViewImage(
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const rel = String(args.path || '')
  if (!rel) return { ok: false, error: 'path is required' }
  const abs = safeJoin(ctx.roots, rel, ctx.fullDisk)
  const ext = path.extname(abs).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
    return { ok: false, error: `Not an image I can look at: ${ext || 'no extension'}. Supported: png, jpg, webp, gif, bmp.` }
  }
  try {
    const st = await fs.stat(abs)
    if (st.size > 12 * 1024 * 1024) return { ok: false, error: `Image is ${(st.size / 1e6).toFixed(1)} MB — too big to read in one turn (limit 12 MB).` }
    const data = await fs.readFile(abs)
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
    return {
      ok: true,
      output: `Image attached: ${rel} (${st.size} bytes, ${mime}). It will be in your next message — look at it there, do not guess its content.`,
      meta: { imageUrl: `data:${mime};base64,${data.toString('base64')}`, imageRel: rel }
    }
  } catch (e: any) {
    return { ok: false, error: `Could not read ${rel}: ${e?.message || String(e)}` }
  }
}


/* ------------------------------------------------------------------ */
/* Web tools: DeepSeek's own Search & Fetch API                        */
/* ------------------------------------------------------------------ */

/**
 * The model has no internet of its own — its knowledge stops at a date, and
 * guesses about versions and API names are exactly how a run produces code
 * against an interface that never existed. DeepSeek sells search and page
 * fetching as JSON endpoints ($0.75 per 1000 requests, billed per use), so the
 * agent can look things up for real instead of asking the user to paste docs.
 */
async function deepseekWeb(pathname: '/tools/search' | '/tools/fetch', body: Record<string, unknown>): Promise<any> {
  const settings = await getSettings()
  if (!settings.apiKey) throw new Error('No API key: web tools need the DeepSeek key from Settings.')
  const base = (settings.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '').replace(/\/v\d+$/, '')
  const res = await fetch(`${base}/v1${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`web tool failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function toolWebSearch(args: Record<string, any>): Promise<ToolOutcome> {
  const query = String(args.query || '').trim()
  if (!query) return { ok: false, error: 'query is required' }
  const count = Math.max(1, Math.min(10, Number(args.count) || 5))
  try {
    const json = await deepseekWeb('/tools/search', {
      query: query.slice(0, 128),
      count,
      need_content: false
    })
    const results: any[] = Array.isArray(json?.results) ? json.results : []
    if (!results.length) return { ok: true, output: `No results for "${query}".` }
    // summary, not content: 600-800 characters is what a model can actually use,
    // and the full page is one read_url call away when it matters.
    const body = results
      .map((r, i) => {
        const date = r.date ? ` · ${String(r.date).slice(0, 10)}` : ''
        const auth = typeof r.authority === 'number' && r.authority >= 3 ? ' · authoritative' : ''
        return `${i + 1}. ${r.title}\n   ${r.url}${date}${auth}\n   ${(r.summary || r.snippet || '').trim()}`
      })
      .join('\n\n')
    return {
      ok: true,
      output: `Search: ${query}\n\n${body}\n\n(If a page matters, call read_url on it — do not guess what it says.)`,
      meta: { results: results.map((r) => ({ title: r.title, url: r.url, date: r.date })) }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function toolReadUrl(args: Record<string, any>): Promise<ToolOutcome> {
  const url = String(args.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must start with http:// or https://' }
  try {
    const page = await deepseekWeb('/tools/fetch', { url })
    const text = [page?.title ? `# ${page.title}` : '', page?.content || page?.markdown || '']
      .filter(Boolean)
      .join('\n\n')
      .trim()
    if (!text) return { ok: false, error: `Fetched ${url} but got no readable text (page may be JS-only or blocked).` }
    return {
      ok: true,
      output: clamp(text, 40000),
      meta: { url, title: page?.title }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

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
          line_numbers: { type: 'boolean', description: 'prefix each line with its number (default true)' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Read several files in one call instead of one call per file (max 8). Paths only — no ranges.'
          }
        },
        required: []
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
          path: {
            type: 'string',
            description:
              'Relative path from the workspace, or an absolute path (including folders next to the workspace) when full access is on'
          },
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
          tone: { type: 'number', description: '0-5 colour slot, pick something different from the previous note' },
          kind: {
            type: 'string',
            enum: ['idea', 'risk', 'todo', 'question'],
            description: 'What this note is: a design idea worth returning to, a risk you spotted, a loose end for the user, or an open question'
          }
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
      name: 'web_search',
      description:
        'Search the live web (DeepSeek Search API). Use it for anything you would otherwise guess: library versions, API names, error messages, release notes, current prices. Returns ranked results with titles, URLs and long summaries.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query, 1-128 chars. Supports site:, -site:, "exact phrase", lang:, after:YYYY-MM-DD.'
          },
          count: { type: 'integer', description: 'How many results, 1-10 (default 5)' },
          note: { type: 'string', description: 'Optional one line: what you are looking up and why' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description:
        'Fetch one web page and return it as markdown text. Use after web_search when a result matters, or when the user pastes a link.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL' },
          note: { type: 'string', description: 'Optional one line: what you are reading it for' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'preview_page',
      description:
        'Render an HTML page or a local web app in headless Chrome and hand you the screenshot: judge the design by looking at it, not by describing the CSS. Use it for a UI you just built, a landing page, a Blender-like dashboard, a game HUD mockup, or a 3D scene drawn in a canvas.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'An .html file (relative or absolute) or an http(s) URL' },
          size: { type: 'string', description: 'Viewport "width,height", default "1440,900"' },
          wait_ms: { type: 'integer', description: 'How long to let the page run before the shot (animations, WebGL), default 1500' },
          binary: { type: 'string', description: 'Optional full path to a Chromium-based browser, when the default lookup finds none' },
          note: { type: 'string', description: 'Optional one line: what you are checking' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description:
        'Look at an image file on disk (screenshot, texture, icon, photo, mockup). The image is added to your next message so you can actually see it. Use this instead of guessing what a picture contains.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image, relative to the workspace or absolute' },
          note: { type: 'string', description: 'Optional one line: why you are looking at it' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_path',
      description:
        'Find a file or folder anywhere on the machine when nobody told you where it is: a game installed on another drive, a mod folder, a jar that was built earlier. With full disk access it searches the user folders and every mounted drive; pass `root` to search one folder. Bounded by time, and it tells you where it looked when it finds nothing.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name to look for: a substring ("peak") or a simple pattern ("*.jar", "Peak*")'
          },
          kind: { type: 'string', enum: ['file', 'dir', 'any'], description: 'What kind of entry you want (default any)' },
          root: { type: 'string', description: 'Folder to start from, e.g. "D:/" or the folder the user pointed at' },
          depth: { type: 'integer', description: 'How deep below the start folders, 1-8 (default 4)' },
          limit: { type: 'integer', description: 'How many matches to show, 1-100 (default 40)' },
          max_ms: { type: 'integer', description: 'Time budget in milliseconds (default 20000, max 120000)' },
          note: { type: 'string', description: 'Optional one line: what you are looking for and why' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_app',
      description:
        'Find an installed application and its folder ("Roblox Studio", "Unity", "Blender", "idea"). Uses the system app registry on Windows and the app folders elsewhere. Use it before guessing a Program Files path.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product or app name as the user said it' },
          note: { type: 'string', description: 'Optional one line: what you need it for' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tool_help',
      description:
        'Read the reference for a tool before using it: exact arguments, limits, and the workarounds this environment needs. Call with no name for the list. Cheaper than a failed call.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Tool name; omit for the list of tools' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'Call when the task is fully complete — after the work, never after the plan. Provide a concise summary of what changed and how it was verified.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          work_done: {
            type: 'boolean',
            description: 'true only if this run actually changed files or ran commands. false means nothing was done yet.'
          }
        },
        required: ['summary']
      }
    }
  }
]

// Looking things up is reading, not acting: a search never needs a confirmation
// and never counts against the write permission.
export const READ_ONLY_TOOLS = new Set([
  'tool_help',
  'find_path',
  'find_app',
  'preview_page',
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'todo_write',
  'attach_file',
  'web_search',
  'read_url',
  'view_image'
])
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
