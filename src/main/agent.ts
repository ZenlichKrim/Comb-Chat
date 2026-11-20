import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  Attachment,
  ChatMessage,
  Checkpoint,
  RunRequest,
  ToolResultView,
  TokenUsage,
  TodoItem
} from '../shared/types'
import { streamChat, toApiHistory, type LlmContentPart, type LlmMessage } from './llm'
import { TOOL_SCHEMAS, executeTool, toolNeedsApproval, previewTool, READ_ONLY_TOOLS, type ToolContext } from './tools'
import { describeInBackground } from './describe'
import {
  authorPrompt,
  builderPrompt,
  modelForRole,
  parseBrief,
  planRoles,
  resolvePolicy,
  toolsForRole
} from './roles'
import type { AgentRole, Brief, Capabilities, FileSummary, SpecReport } from '../shared/types'
import {
  changedFileExcerpts,
  checkAgainstSpec,
  ensureSpec,
  needsSpec,
  reworkBrief,
  specForBuilder
} from './spec'
import { driveGoal, shouldContinue, type GoalOutcome } from './goal'

/** never spend a request describing media, bundles or lockfiles */
const SKIP_DESCRIBE = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp3|mp4|zip|tar|gz|7z|dmg|exe|dll|so|dylib|pdf|apk|jar)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i
import { IGNORED_DIRS, toRel } from './fsops'
import { getSettings, saveCheckpoint, setSettings } from './store'

/** `.comb/memory.md` — what the team decided, kept between sessions. */
async function readMemory(workspace: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(workspace, '.comb', 'memory.md'), 'utf8')
    return raw.slice(-6000)
  } catch {
    return ''
  }
}

export async function appendMemory(workspace: string, line: string): Promise<void> {
  try {
    const dir = path.join(workspace, '.comb')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'memory.md')
    const head = await fs.readFile(file, 'utf8').catch(() => '# Память проекта\n')
    const stamp = new Date().toISOString().slice(0, 10)
    await fs.writeFile(file, `${head.trimEnd()}\n- ${stamp}: ${line.trim()}\n`, 'utf8')
  } catch {
    /* memory is a convenience, never a reason to fail a run */
  }
}

export interface AgentDeps {
  emit: (e: AgentEvent) => void
  requestApproval: (runId: string, call: ToolResultView) => Promise<'allow' | 'allow-always' | 'deny'>
}

interface ActiveRun {
  controller: AbortController
  approvals: Map<string, (d: 'allow' | 'allow-always' | 'deny') => void>
  autoApproved: Set<string>
  /** open questions the user may still answer; answered ones land here as promises */
  votes: Map<string, (answer: string) => void>
}

/** Votes whose default option already fired: a late reply still reaches the model. */
const answeredVotes = new Map<string, string>()

/** Notes the user typed while the agent was working, keyed by run. */
const steerNotes = new Map<string, string[]>()

/**
 * The user typed while a run was in flight ("перестань трогать sidebar, правь
 * только header"). The agent does not stop: the note is dropped into its context
 * before the next round, which is what a person would do mid-conversation.
 */
export function steerRun(runId: string, note: string): void {
  const list = steerNotes.get(runId) || []
  list.push(note.slice(0, 2000))
  steerNotes.set(runId, list.slice(-5))
}

const active = new Map<string, ActiveRun>()

export function stopRun(runId: string): void {
  const run = active.get(runId)
  if (run) {
    for (const [, fn] of run.approvals) fn('deny')
    run.approvals.clear()
    run.votes.clear()
    run.controller.abort()
  }
}

/**
 * The user picked an option (or typed their own answer) for a question the agent
 * asked. The vote never blocks the run, so this may arrive after the default was
 * already used — in that case the answer is queued for the model instead.
 */
export function answerVote(runId: string, voteId: string, answer: string): void {
  const run = active.get(runId)
  const fn = run?.votes.get(voteId)
  if (fn && run) {
    run.votes.delete(voteId)
    fn(answer)
    return
  }
  answeredVotes.set(voteId, answer)
  if (answeredVotes.size > 40) answeredVotes.delete(answeredVotes.keys().next().value as string)
}

export function resolveApproval(runId: string, callId: string, decision: 'allow' | 'allow-always' | 'deny'): void {
  const run = active.get(runId)
  if (!run) return
  // Approvals are keyed by `${tool}:${id}` so two calls with the same id never
  // collide, but the renderer only knows the id — accept both shapes.
  const key = run.approvals.has(callId) ? callId : [...run.approvals.keys()].find((k) => k.endsWith(`:${callId}`))
  const fn = key ? run.approvals.get(key) : undefined
  if (!fn || !key) return
  if (decision === 'allow-always') run.autoApproved.add(key.split(':')[0])
  run.approvals.delete(key)
  fn(decision)
}

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

function systemPrompt(opts: {
  workspace: string | null
  /** every attached folder; `workspace` is the first one */
  roots?: string[]
  platform: string
  shell: string
  now: string
  approvalPolicy: string
  fullDisk?: boolean
  custom: string
  contextFiles: string[]
  locale: string
}): string {
  const extra = (opts.roots || []).slice(1)
  const rootsLine = extra.length
    ? `You have direct read/write access to ${extra.length + 1} folders:\n- \`${opts.workspace}\` (primary — bare paths resolve here)\n${extra.map((r) => `- \`${r}\` (address it with an absolute path, e.g. \`${r}/src/app.ts\`)`).join('\n')}`
    : `You have direct read/write access to the user's project at \`${opts.workspace}\`. All paths you pass to tools are relative to that root.`
  const toolsGuide = opts.fullDisk
    ? `
# Tools
You have access to the WHOLE machine, not just the open project${opts.workspace ? ` (project root: \`${opts.workspace}\`)` : ''}. Absolute paths are allowed anywhere: \`/home/...\`, \`/etc/...\`, \`C:\\Users\\...\`.
- Prefer the project root for code changes unless the user asks about something elsewhere.
- Anything outside the project is still gated by the approval policy: writes, deletes and commands ask first.
- Never read or print secrets (SSH keys, .env with credentials, browser profiles, keychains) unless the user explicitly points at them.
- Do not wander: search purposefully, and say which paths outside the project you touched.
- \`run_command\` is non-interactive and has network access; use \`todo_write\` for anything with more than 2 steps.`
    : opts.workspace
    ? `
# Tools
${rootsLine}${extra.length ? '\nGlob and grep search all of them; results from extra folders come prefixed with the folder name.' : ''}
- Explore before you edit: \`list_dir\`, \`glob\`, \`grep\`, \`read_file\`. Never guess file contents.
- Explore fast, then work. Read several files at once with \`read_file({paths:[...]})\` instead of one call per file, never read the same file twice, and after about a dozen reads stop and start editing: a run that only reads is a run that did nothing.
- Change code with \`edit_file\` (exact string replacement). Include enough context lines so the match is unique. Use \`write_file\` only for new files or full rewrites.
- Verify your work: run the project's type checker, tests or linter with \`run_command\` when they exist. Read package.json / Makefile / pyproject.toml first to learn the right commands.
- \`run_command\` is non-interactive: no vim, no prompts, no servers that never exit (background them or skip).
- Long builds (gradle, maven, cargo, npm install) take minutes: pass \`timeout_ms\` (e.g. 600000) instead of letting the default cut them off, and print a short line to the user first so the wait is expected.
- You have real web access: \`web_search\` for anything you would otherwise guess (library versions, API names, error text, release notes) and \`read_url\` to read a page properly. Search first, then read the one page that matters — do not read five.
- You also have network access through \`run_command\`: \`curl\`/\`wget\`/\`git clone\`/package managers all work. When the task needs an asset (an icon, a font, a package, a repo) download it into the project and verify the bytes landed (size, format) instead of asking the user to do it.
- The model accepts images: if the user attached a screenshot, read it and act on what it shows.
- Use \`todo_write\` for anything with more than 2 steps, and keep it current.
- Use the tools instead of describing their results. Every claim about the code must come from a call you actually made: a file you read, a command you ran, a build you started. It should work is not a result; a green build is.
- Hand the user the artifact, do not point at it. When the work produced a file they should take away (a jar, an exe, a report, a config), attach it with attach_file so it appears in the chat with its path and an open button, and mention it by name.
- Name paths so they are clickable: write them in backticks, like src/app.ts:42, or as a markdown link to the path. A path in plain prose is a path the user has to hunt for.

- You are the author, not a clerk — for every task, not just creative ones. Before starting, think about what this is judged on, what the request left out, and what a professional would add unasked. Then add it. Work that only satisfies the literal list reads as cheap and the user notices immediately.
- Before finishing, do the check a careful author does: what will the user look at first, what is missing that would make this feel finished, which edge case will bite them in five minutes.
- Never ship a stub: no TODO comments as your work, no empty class that "will be filled later", no method that returns a hardcoded value where behaviour was asked for. If you cannot do a thing, say it in the summary instead of leaving a placeholder that pretends.
- The user's spec is a contract, not a mood board. Every numbered item in it is work you owe them: implement it or say explicitly which ones you could not and why. Never call finish while a plan item is open.
- "Compiles" is not "works" and neither is "the code looks right". For a real project: build it, read the errors, fix them. For code against a version you do not remember exactly, read the actual jar/lockfile in the project instead of guessing API names.
- Go straight at the task. Do not turn into a detective: read what this step needs, then act. If the obvious way fails, try the next method in the same step instead of spending rounds investigating why the first failed. Finishing beats fully understanding the project.`
    : `
# No workspace open
The user has not opened a folder. You cannot read or write files. Answer questions, explain code, design architecture — and tell them to open a workspace (⌘/Ctrl+O) when they need edits.`

  return `You are Comb, a precise and senior software engineering agent running inside a desktop IDE called Comb Chat. You work directly on the user's machine.

# Environment
- Platform: ${opts.platform}
- Interface language: ${opts.locale === 'ru' ? 'Russian' : 'English'}
- ALWAYS write your own prose in ${opts.locale === 'ru' ? 'Russian' : 'English'}: narration between tool calls, conclusions, questions, the finish summary. Identifiers, paths, shell commands and code stay as they are. Do not answer in English just because the repository, the tool output or a library is in English, and do not switch language mid-run — the interface is ${opts.locale === 'ru' ? 'Russian' : 'English'}.
- Shell: ${opts.shell}
- Date: ${opts.now}
- Approval policy: ${opts.approvalPolicy}${opts.workspace ? `\n- Workspace: ${opts.workspace}` : ''}
${toolsGuide}
${opts.contextFiles.length ? `\n# Files the user is looking at\n${opts.contextFiles.map((f) => `- ${f}`).join('\n')}` : ''}

# How you talk
- You are a colleague working next to the user, not a mute tool. Talk as you work: what you noticed in the code, what you think of the approach, what you are about to do and why. The user wants your head, not just your hands.
- Every tool accepts an optional note field: one line, in the interface language, about what this call is for — "смотрю, как устроен потребитель события", "грепаю, где ещё используется это имя". Put it on the calls that need context; skip it on obvious ones. It is cheap (it rides on the call you were already making), it shows up right above the tool row, and it is the main way the user follows your thinking.
- The very first turn of a task is words only: what you understood, what you are about to do, and any question. No tool call in that message at all.
- A tool call is a promise. Never say "сейчас сделаю X" and then end the turn without calling the tool that does X. Plan-then-stop is the single most useless failure mode: the user reads the plan, waits, and nothing happens.
- There is no length budget on your prose. A thought that needs three paragraphs gets three paragraphs; a mechanical step gets one line. Say what is worth saying and stop — do not pad, do not trim a real thought to fit.
- Do not write status reports. "Сейчас я прочитаю файл, затем внесу правку, затем запущу тесты" is noise — the transcript already shows every call. Say the part that is only in your head: why, what you expect, what surprised you, what you would do differently.
- If the user wrote you a message, answer it in words before you touch anything — even when the task looks obvious. No headings, no bullet lists of steps.
- When you form an opinion about the project — how it is put together, what is fragile, what is worth changing, what you would build differently — say it. That read is part of the work, not an interruption of it.

# How you work
- Make the change instead of describing what you would change. Only ask questions when a real fork in the road blocks you.
- Match the existing code style exactly: indentation, quotes, naming, error handling, comment density. Read neighbouring files first.
- Keep diffs minimal. Do not reformat, rename or "improve" unrelated code. Never delete functionality you were not asked to touch.
- Dense, not terse: cut filler, hedging and restating the request, never cut the thought itself. Use markdown, code blocks with a language tag, and file references like \`src/app.ts:42\`. No emoji unless the user uses them first.
- If a tool fails, read the error, fix the cause, try once more — do not repeat the identical failing call.
- Long task, user may be away: call \`notify_user\` once when you are done or when you are stuck and need them. It is a desktop ping, not a substitute for talking in the transcript.
- When a decision genuinely changes the result and you cannot infer the answer from the code, call \`ask_user\` with 2-4 concrete options and set \`recommend\`. Once per task at most: guessing is better than asking twice.
- \`ask_user\` does not stop you: keep working with your recommended option and mention the open question in your summary.
- Something the user must do or know outside this task: \`leave_note\` — a sticky note, not a paragraph.
- After an answer, call \`suggest\` with 2-4 clickable next steps when they are obvious — the user then continues in one click.
- When you finish, call \`finish\` with a one-paragraph summary (files changed, what was verified).

# Safety
- Never run destructive commands (rm -rf, git reset --hard, force push, DROP TABLE, formatting entire disks) without explicit confirmation.
- Never print, log or commit secrets. Never send data to endpoints other than the configured model API.
- Do not create git commits unless the user asks.

# Installed workspace context
${opts.contextFiles.length ? '' : '—'}${opts.custom ? `\n\n# Project / user instructions (highest priority)\n${opts.custom}` : ''}`
}

/* ------------------------------------------------------------------ */
/* Context building                                                    */
/* ------------------------------------------------------------------ */

async function buildContextBlock(workspace: string, openFiles: string[]): Promise<string> {
  const parts: string[] = []
  try {
    const entries = (await fs.readdir(workspace, { withFileTypes: true }))
      .filter((e) => !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
      .slice(0, 60)
    parts.push(
      `<workspace_tree root="${toRel(process.cwd(), workspace) || workspace}">\n${entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n')}\n</workspace_tree>`
    )
  } catch {
    /* ignore */
  }
  // Grab package manifests for stack detection
  for (const manifest of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'composer.json', 'requirements.txt']) {
    try {
      const raw = await fs.readFile(path.join(workspace, manifest), 'utf8')
      if (raw.length < 12000) parts.push(`<${manifest}>\n${raw}\n</${manifest}>`)
    } catch {
      /* not present */
    }
  }
  try {
    const gitHead = await fs.readFile(path.join(workspace, '.git', 'HEAD'), 'utf8')
    parts.push(`<git_head>${gitHead.trim()}</git_head>`)
  } catch {
    /* not a repo */
  }
  if (openFiles.length) {
    const chunks: string[] = []
    for (const rel of openFiles.slice(0, 6)) {
      try {
        const abs = path.join(workspace, rel)
        const st = await fs.stat(abs)
        if (st.size > 60000) continue
        const text = await fs.readFile(abs, 'utf8')
        chunks.push(`<open_file path="${rel}">\n${text}\n</open_file>`)
      } catch {
        /* skip */
      }
    }
    if (chunks.length) parts.push(`# Open editor tabs (current content)\n${chunks.join('\n')}`)
  }
  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ */
/* Main agent loop                                                     */
/* ------------------------------------------------------------------ */

/**
 * One agent turn with one role. This is the loop that was always here; what is
 * new is that the prompt, the tool list and the model follow `req.role`, so a
 * builder cannot wander into a design discussion and an author cannot start
 * editing files behind the user's back.
 */
export async function runAgent(
  req: RunRequest,
  deps: AgentDeps
): Promise<{ ok: boolean; error?: string; finalText?: string; touched?: string[]; todos?: TodoItem[] }> {
  const settings = await getSettings()
  if (!settings.apiKey) {
    deps.emit({ type: 'error', runId: req.runId, message: 'No API key configured. Open Settings and paste your DeepSeek key.' })
    deps.emit({ type: 'run-end', runId: req.runId, reason: 'error' })
    return { ok: false, error: 'missing-api-key' }
  }

  const run: ActiveRun = {
    controller: new AbortController(),
    approvals: new Map(),
    autoApproved: new Set(settings.allowedTools || []),
    votes: new Map()
  }
  active.set(req.runId, run)
  const { signal } = run.controller

  const touched = new Set<string>()
  const beforeState = new Map<string, string | null>()
  let todos: TodoItem[] = []
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 }
  const checkpoints: Checkpoint[] = []

  // capabilities are the human-facing truth; approvalPolicy is the legacy shape
  const roleEarly: AgentRole = req.role || 'builder'
  const capEarly: Capabilities = req.capabilities || settings.capabilities || { edit: 'ask', run: 'ask', planner: 'auto' }
  const earlyPolicy = resolvePolicy(capEarly, req.approvalPolicy)
  let approvalPolicy = earlyPolicy.approvalPolicy
  const fullDisk = !!req.fullDiskAccess
  const roots = [req.workspace, ...(req.extraRoots || [])].filter((r): r is string => !!r)
  const extraRootNames = (req.extraRoots || []).filter(Boolean)
  const ctx: ToolContext = {
    workspace: req.workspace || '',
    roots: roots.length ? roots : [os.homedir()],
    fullDisk,
    touched,
    beforeState,
    todos,
    onTodos: (t) => {
      // The checklist is a promise, not decoration: the first item goes in
      // immediately as in-progress so the panel shows what is happening now.
      const [first, ...rest] = t.map((x, i) => (i === 0 && x.status === 'pending' ? { ...x, status: 'in_progress' as const } : x))
      const marked = first ? [first, ...rest] : t
      todos = marked
      deps.emit({ type: 'todos', runId: req.runId, todos: marked })
    },
    approvalPolicy: earlyPolicy.approvalPolicy,
    runId: req.runId,
    requestApproval: async (call) => {
      if (run.autoApproved.has(call.name)) return 'allow'
      deps.emit({ type: 'tool-approval-request', runId: req.runId, call })
      const key = `${call.name}:${call.id}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          run.approvals.delete(key)
          resolve('deny')
        }, 15 * 60 * 1000)
        run.approvals.set(key, (d) => {
          clearTimeout(timer)
          if (d === 'allow-always') {
            // safety net: whatever the policy loop does next, this tool will not
            // ask again during this run
            run.autoApproved.add(call.name)
            const tools = Array.from(new Set([...(settings.allowedTools || []), call.name]))
            void setSettings({ allowedTools: tools }).catch(() => undefined)
          }
          resolve(d)
        })
      })
    },
    signal
  }

  // Build the prompt
  let contextBlock = ''
  if (req.workspace && req.autoContext) {
    try {
      contextBlock = await buildContextBlock(req.workspace, (req.openFiles || []).map((f) => f.rel))
      if (extraRootNames.length) {
        contextBlock += `\n\n## Additional folders\n${extraRootNames.map((r) => `- ${r}`).join('\n')}\n(their files are not listed here — use list_dir/glob with an absolute path)`
      }
    } catch {
      /* ignore context failures */
    }
  }

  const role = roleEarly
  const caps = capEarly
  const policy = earlyPolicy

  // Project memory: decisions the author carries between sessions, so a run
  // starts from what was already agreed instead of re-litigating it.
  const memory = settings.projectMemory && req.workspace ? await readMemory(req.workspace) : ''

  const sys =
    req.roleMode === 'single'
      ? systemPrompt({
          workspace: req.workspace,
          roots,
          platform: `${process.platform} ${process.arch}`,
          shell: settings.shell || (process.platform === 'win32' ? 'PowerShell / cmd' : process.env.SHELL || '/bin/bash'),
          now: new Date().toISOString(),
          approvalPolicy: policy.approvalPolicy,
          fullDisk,
          custom: req.customInstructions || settings.customInstructions || '',
          contextFiles: (req.openFiles || []).map((f) => f.rel),
          locale: settings.locale || 'en'
        })
      : role === 'author'
        ? authorPrompt({
            locale: settings.locale || 'en',
            workspace: req.workspace,
            memory,
            custom: req.customInstructions || settings.customInstructions || '',
            history: ''
          })
        : builderPrompt({
            locale: settings.locale || 'en',
            workspace: req.workspace,
            brief: req.brief || null,
            memory,
            caps,
            // the criteria come from the user, not from the brief: without them
            // the builder is free to satisfy its own reading of the task
            contract: specForBuilder(req.spec || '', caps, req.specAttempt || 0)
          })

  // A last-line reminder in the user turn itself: models drift back to English
  // in long runs when every tool output is English.
  const langNote = settings.locale === 'ru' ? '\n\n(Отвечай по-русски.)' : ''
  const history: LlmMessage[] = [{ role: 'system', content: sys }]
  const prior = toApiHistory(req.history, 70000)
  history.push(...prior)
  // A user who asked a question wants an answer, not a work session. Detected
  // from their message, because the model's own reply is exactly what cannot be
  // trusted here: it reads its own plan out loud and mistakes it for a task.
  const askedQuestion = (() => {
    const q = (req.userMessage?.content || '').trim()
    if (!q) return false
    const lower = q.toLowerCase()
    // explicit work verbs mean a task even with a question mark in it
    const workVerb = /(сделай|создай|исправ|добав|реализуй|напиши|перепиш|удали|установи|запусти|собери|почини|make|create|fix|add|implement|write|build|run|install|remove)/i.test(lower)
    if (workVerb) return false
    if (/\?$/.test(q) || /\?\s*$/.test(lower)) return true
    return /^(что|кто|где|когда|почему|зачем|как|сколько|можно ли|есть ли|ты|вы|why|what|who|where|when|how|is|are|did|do|does|can|could)\b/i.test(lower)
  })()
  // The user turn is what the user actually wrote. The language reminder rides
  // on the system prompt instead: appended here it got echoed back into the
  // chat as part of "their" message, which is noise the user never typed.
  history.push({ role: 'user', content: buildUserContent(req.userMessage, req.attachments) })
  if (langNote) history.push({ role: 'system', content: 'Отвечай по-русски. Keep identifiers, paths and code as they are.' })
  if (askedQuestion) {
    history.push({
      role: 'user',
      content:
        '[this is a question, not a task] The user asked you something. Answer it in words, in full, and stop. ' +
        'Do not start working: no file edits, no builds, no plans, no todo lists. ' +
        'If answering honestly takes one quick look at a file, look and answer — but do not turn the look into a project tour. ' +
        'A tool call here is a mistake unless you genuinely cannot answer without it.'
    })
  }
  if (req.notes?.length) {
    // notes the user wrote while the agent was busy last time: guidance, not an order
    history.push({
      role: 'user',
      content:
        `[notes the user wrote while you were working]\n` +
        req.notes.map((n) => `- ${n.target ? `${n.target}: ` : ''}${n.text}`).join('\n') +
        `\nApply them if they are still relevant to what you are doing; if a note is already handled, say so in one line instead of redoing it.`
    })
  }
  if (contextBlock) {
    // insert workspace context as a system-ish user message right before the ask
    history.splice(history.length - 1, 0, { role: 'user', content: `<workspace_context>\n${contextBlock}\n</workspace_context>` })
    history.splice(history.length - 1, 0, { role: 'assistant', content: 'Workspace context loaded.' })
  }

  const disabled = new Set(req.disabledTools || [])
  // Every tool accepts an optional `note`: one line, in the user's language, about
  // what this call is for. It is not a tool result — it is the agent talking while
  // it works, attached to the call so the interface can show it above the card and
  // the model is not paying for a separate round trip to say one sentence.
  const NO_NOTE = new Set(['leave_note', 'finish', 'suggest'])
  // The author cannot write: not "should not", cannot — its tool list has no
  // write tool in it. Capabilities can take away what is left.
  const roleAllowed = new Set(toolsForRole(req.role || 'builder', TOOL_SCHEMAS.map((t) => t.function.name)))
  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'delete_path', 'move_path'])
  const tools = req.workspace || fullDisk
    ? TOOL_SCHEMAS.filter(
        (t) =>
          !disabled.has(t.function.name) &&
          roleAllowed.has(t.function.name) &&
          !(policy.writesOff && WRITE_TOOLS.has(t.function.name)) &&
          !(policy.commandsOff && t.function.name === 'run_command')
      ).map((t) =>
        NO_NOTE.has(t.function.name)
          ? t
          : {
              ...t,
              function: {
                ...t.function,
                parameters: {
                  ...t.function.parameters,
                  properties: {
                    ...t.function.parameters.properties,
                    note: {
                      type: 'string',
                      description:
                        'Optional, one line: what this call is for and what you expect, in the user\'s language. Shown to them as you work.'
                    }
                  }
                }
              }
            }
      )
    : []

  deps.emit({ type: 'run-start', runId: req.runId, threadId: req.threadId, messageId: req.messageId })
  deps.emit({
    type: 'role',
    runId: req.runId,
    role,
    phase: role === 'author' ? 'thinking' : 'working'
  })

  let step = 0
  let finalReason: 'done' | 'stopped' | 'error' | 'limit' | 'guard' = 'done'
  /** the last prose the model produced: the brief for the author, the report for the builder */
  let finalText = ''

  /* --- stable-mode state ------------------------------------------------ */
  // Stability is the baseline of this build, not a switch at the bottom of the
  // composer: the guards below run unless someone explicitly opts out.
  const stableMode = req.mode ? req.mode === 'stable' : settings.stableMode !== false
  /** rounds of pure reading allowed before the agent is told to act */
  const MAX_IDLE_READS = 14
  /** consecutive idle rounds before the "stop researching, do something" nudge */
  const MAX_IDLE_ROUNDS = 4
  const costCap = stableMode ? Math.max(0, req.costCap ?? 0) : 0
  // "make sure the first steps are solid": collect what went wrong before deciding
  const errorsSoFar: { step: number; name: string; error: string }[] = []
  const callCounts = new Map<string, number>()
  // Loop detector that looks at the shape of the round, not one call at a time.
  // The failure the user hit is not a single failing command: it is the agent
  // retrying variations of it dozens of times while narrating plans. Two rounds
  // that fail the same tools with the same arguments are one attempt, repeated.
  const roundSignatures = new Map<string, number>()
  /** exact name+args counts across the whole run: the repeat reminder reads this */
  const exactCalls = new Map<string, number>()
  let repeatNudged = false
  const seenCallSignatures = new Set<string>()
  /** true when this round repeats calls already made — no new attempt at all */
  const noNewCallsThisRound = (calls: { name: string; arguments: string }[]): boolean =>
    calls.every((c) => seenCallSignatures.has(`${c.name}:${c.arguments}`))
  let silentRounds = 0
  // Exploration is free but not endless. Rounds that change something (an edit, a
  // write, a command) are work; plain reading gets its own, smaller allowance.
  // This is what stops the "47 steps of reading, zero edits" runs.
  let readOnlySteps = 0
  /** consecutive rounds that changed nothing — the "stuck in one place" smell */
  let idleRounds = 0
  /** set inside a round when something real happened; reset at the top of each */
  let roundProgressed = false
  /** last step at which the "stop reading" nudge was sent */
  let lastIdlePrompt = 0
  /** how many times "I cannot, so I stopped" was accepted before we insisted */
  let gaveUpRefused = 0
  /** the plan as it stood at the last check, to catch a plan that never advances */
  let lastPlanDone = -1
  let planStalls = 0
  /** successful commands, so \"готово\" can be judged by evidence, not claims */
  const okCommands: string[] = []
  // The spec the user pasted is the contract. Every numbered section is a promise
  // the run must keep, and a "done" that covers four of thirteen is the failure
  // the user keeps screenshotting. Parsed once, checked before finish.
  // Any substantial task deserves the pass a professional makes before typing:
  // what is this really, what will it be judged on, what did the request leave
  // out, what is the one thing that makes it good. Not mods only — code, a doc,
  // a refactor, a dataset, a design. Short one-liners do not need it.
  const substantial = (() => {
    const q = req.userMessage?.content || ''
    if (q.trim().length < 180) return false
    if (/(ошибк|error|typo|опечатк|переименуй|rename|что такое|what is|как работает|how does)/i.test(q.slice(0, 200))) return false
    return true
  })()
  /** does it produce something people look at or play? then craft matters double */
  const visualish = /(мод|mod\b|игр|game|интерфейс|interface|ui\b|ux\b|дизайн|design|визуал|visual|анимац|animat|атмосфер|atmospher|погод|weather|снег|snow|туман|fog|сайт|site|page|страниц|лендинг|dashboard|панель)/i.test(
    (req.userMessage?.content || '').toLowerCase()
  )
  const specSections = (() => {
    const raw = req.userMessage?.content || ''
    if (raw.length < 800) return [] as { n: number; title: string; hits: number }[]
    const out: { n: number; title: string; hits: number }[] = []
    const lines = raw.split(/\r?\n/)
    for (const line of lines) {
      const plain = line.replace(/[═─=#*]/g, ' ').trim()
      // spec sections look like \"1. ЯДРО: ХОЛОД, ТЕПЛО, ТЕЛО, МОКРОСТЬ\" — a short
      // numbered header, not a sentence and not a list bullet
      const m = plain.match(/^(\d{1,2})\.\s+([A-ZА-ЯЁ][^.]{3,60})$/)
      if (!m) continue
      const title = m[2].trim()
      if (title.length < 4) continue
      if (out.some((x) => x.title.toLowerCase() === title.toLowerCase())) continue
      out.push({ n: Number(m[1]), title, hits: 0 })
    }
    return out.slice(0, 20)
  })()
  /** set once the requested artifact is actually found on disk */
  let artifactFound = ''
  let artifactRefused = 0
  let specPlanAsked = false
  let scopeRefused = 0
  let designPassed = false
  /** the user asked for a build and we have not found it on disk yet */
  const artifactMissing = (): boolean => !!wantedArtifact && !artifactFound && artifactRefused < 2
  /** the user asked for a build artifact (jar/exe/appimage...) — we must find it */
  const wantedArtifact = (() => {
    const q = (req.userMessage?.content || '').toLowerCase()
    const m = q.match(/\b(jar|exe|appimage|\.deb|apk|dmg|msi)\b/)
    return m ? m[1].replace('.', '') : ''
  })()
  /** the agent's own sentence for the round being executed */
  let roundNarration = ''
  /** the calls of the round being executed, reported to the UI as one step */
  let roundTools: { id: string; name: string; ok: boolean; error: string; args: Record<string, any> }[] = []
  let ranAnyCommand = false
  let finishRefused = 0
  let loopHits = 0
  let loopNote = ''
  let verifyStage: 'pending' | 'running' | 'done' | 'failed' = 'pending'
  let notifiedCost = false
  let repeatWarnings = 0
  let notifiedVote = false
  let notifyCount = 0

  /** Ask the model to verify before it is allowed to finish (stable mode). */
  const pushVerifyPrompt = async (): Promise<void> => {
    if (!stableMode || verifyStage !== 'pending') return
    // Nothing was written: there is nothing to verify, and asking anyway would
    // cost a round trip on every "what does this file do?" question.
    if (!touched.size) {
      verifyStage = 'done'
      return
    }
    // A task big enough to have a plan must be *built*, not described. If the
    // toolchain exists, the build command is the verification: "compiles" is the
    // only claim that means anything for code the model wrote from scratch.
    if (specSections.length >= 4) {
      verifyStage = 'running'
      const open = todos.filter((x) => x.status !== 'done')
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'verify',
        title: `Сверка со спекой: ${specSections.length - open.length}/${specSections.length} разделов закрыто`,
        detail: open.length ? open.slice(0, 3).map((x) => String(x.text).slice(0, 50)).join(' · ') : undefined
      })
      history.push({
        role: 'user',
        content:
          `[stable mode — spec coverage] The user's spec has ${specSections.length} sections: ` +
          specSections.map((x) => x.title).join('; ') +
          '.\nBefore calling finish: go through them one by one and check that each is actually implemented in code (not described, not stubbed, not "later"). ' +
          'For every section that is missing, implement it now. ' +
          'Then call finish with a summary that lists each section and its state — implemented or not, and why.'
      })
      return
    }
    if (wantedArtifact) {
      verifyStage = 'running'
      const cmd = await pickVerifyCommand(req.verifyCommand || '', req.workspace || '', touched)
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'verify',
        title: `Сборка перед «готово»: ${cmd || wantedArtifact}`,
        detail: 'Пока артефакт не собрался, задача не закончена.'
      })
      history.push({
        role: 'user',
        content:
          `[stable mode] The user asked for a built ${wantedArtifact.toUpperCase()}. A summary is not a build. ` +
          (cmd ? `Run \`${cmd}\` now and fix every error it prints, one by one, until it succeeds.\n` : 'Run the project build command now and fix every error it prints.\n') +
          'Do not stub things out to make it compile: wire the real API. If a class name is wrong for this Minecraft version, ' +
          'read the actual jar in the project (javap / unzip -l) and use the name that exists there. ' +
          'Only after the build succeeds and the artifact file exists, call finish and say where the file is.'
      })
      return
    }
    verifyStage = 'running'
    const cmd = await pickVerifyCommand(req.verifyCommand || '', req.workspace || '', touched)
    const targets = [...touched].slice(0, 8).map((p) => path.relative(req.workspace || p, p) || p)
    deps.emit({
      type: 'guard',
      runId: req.runId,
      kind: 'verify',
      title: cmd ? `Проверка: ${cmd}` : 'Проверка результата',
      detail: targets.length ? targets.join(', ') : undefined
    })
    history.push({
      role: 'user',
      content:
        `[stable mode] Before you call finish, verify the work yourself.\n` +
        (cmd ? `- Run \`${cmd}\` with run_command and fix everything it reports.\n` : '- Run the project\'s type check / tests / linter if it has any.\n') +
        (targets.length ? `- Re-read what you changed: ${targets.join(', ')}.\n` : '') +
        '- Confirm no API you introduced is called with the wrong arguments and no import is missing.\n' +
        '- If something is broken, fix it now. Only then call finish with an honest summary (what was verified, what was not).'
    })
  }

  /**
   * Keep the user in the loop without shaping the voice: the model went straight
   * to tool calls, so it is reminded to talk — it is NOT told what to write or
   * how long. "Describe what you understood and what you are doing" produces
   * status reports and kills the thinking about the project, which is the half
   * the user actually wants.
   */
  let nudges = 0
  const MAX_NUDGES = 3
  const narratePrompt = (): string =>
    `[no words, step ${step}] You went straight to tool calls and said nothing to the user. ` +
    'They are watching the transcript and cannot read your mind.\n' +
    'Say whatever is on your mind — your read on the code you just saw, what you think of the approach, what surprised you, where this could go — and then continue. ' +
    'Your own words, whatever length the thought needs: a line if it is a line, a paragraph if there is something to say. ' +
    'Do not write a status report of the plan; nobody needs the steps repeated back.'

  /**
   * Answer every tool call the model made, whatever we decide next. An assistant
   * turn with `tool_calls` that is not followed by one tool message per id is a
   * 400 from the API — and the error used to be shown to the user and retried,
   * which is where the "Bad request … insufficient tool messages" spam came from.
   */
  const closeToolCalls = (calls: { id: string; name: string }[], note: string): void => {
    for (const c of calls) {
      history.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: note })
    }
  }

  /** desktop ping, rate-limited so a long run does not become a notification mill */
  const notify = (title: string, body: string, urgent = false): void => {
    if (settings.notifyDesktop === false) return
    if (!urgent && notifyCount >= 3) return
    notifyCount++
    deps.emit({ type: 'notify', runId: req.runId, title, body, urgent })
  }

  try {
    /**
     * Speed, straight up: every round re-sends the whole history, so a run with
     * forty file reads pays for those reads on every single step — the model sits
     * there re-reading a project it already knows while the user watches a spinner.
     * Old read results are replaced with a one-line stub (the content stays in the
     * transcript), and only the last few reads are kept in full.
     */
    const compactHistory = (h: LlmMessage[]): void => {
      let keep = 6
      for (let i = h.length - 1; i >= 0; i--) {
        const m = h[i]
        if (m.role !== 'tool' || !m.name || !READ_ONLY_TOOLS.has(m.name)) continue
        if (keep > 0) {
          keep--
          continue
        }
        const text = typeof m.content === 'string' ? m.content : ''
        if (!text || text.startsWith('[read earlier]')) continue
        const first = text.slice(0, 160).replace(/\s+/g, ' ')
        m.content = `[read earlier] ${first}${text.length > 160 ? ' …' : ''}\n(the full text was shown to you earlier; ask for a specific range if you need it again)`
      }
    }

    while (step < Math.max(1, req.maxSteps)) {
      step++
      deps.emit({ type: 'step', runId: req.runId, step })
      roundTools = []
      if (signal.aborted) {
        finalReason = 'stopped'
        break
      }

      compactHistory(history)

      // Model routing. Measured benchmarks say DeepSeek V4.1-Flash beats V4 Pro on
      // agentic coding (DeepSWE 77.0 vs 62.7, Terminal-Bench 42.3 vs 12.4) and it is
      // 3-7x cheaper, so Pro is the wrong default for editing files. Pro still wins
      // on deep text reasoning and long factual recall, so that is where it goes.
      // The role decides the model before the step does. The author thinks — it
      // is writing a brief someone will be held to. The builder executes, so it
      // gets the cheap non-thinking pass unless the user forced Pro.
      const roleModel = modelForRole(role, req.model, req.thoughtEffort || 'deep')
      const routed =
        role === 'author'
          ? roleModel.model
          : pickModelForStep(req, step, { substantial, specSections: specSections.length, planning: step <= 2 })

      // one clock per step: when this burst of thought started
      let thoughtStart = 0

      const result = await streamChat({
        apiKey: settings.apiKey.trim(),
        baseUrl: settings.baseUrl,
        model: routed,
        messages: history,
        tools: tools as any,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal,
        // Thinking budget: the user's setting, but a one-line question never gets
        // 32k of thought — a long think on a trivial ask is money burned for
        // nothing. Substantial work and specs get the full setting.
        effort:
          role === 'author'
            ? roleModel.effort
            : substantial || specSections.length >= 4
              ? req.thoughtEffort || 'deep'
              : 'fast',
        onDelta: (d) => {
          // Time the thought here, on one clock. The renderer used to guess the
          // duration from the number of characters, which is why a 20-second think
          // showed up as "212 s".
          if (d.reasoning) {
            if (thoughtStart === 0) thoughtStart = d.reasoningAt || Date.now()
            deps.emit({
              type: 'reasoning-delta',
              runId: req.runId,
              text: d.reasoning,
              deltaMs: (d.reasoningAt || Date.now()) - thoughtStart
            })
          }
          if (d.content && thoughtStart) {
            thoughtStart = 0
          }
          if (d.content) deps.emit({ type: 'text-delta', runId: req.runId, text: d.content })
        },
        onRetry: (r) => {
          // half an answer already streamed into the transcript: tell the UI to
          // drop it, then wait — a dropped connection must not leave debris behind
          deps.emit({ type: 'run-retry', runId: req.runId, step, attempt: r.attempt, max: r.max, waitMs: r.waitMs, reason: r.reason })
        },
        onUsage: (u) => {
          usage.promptTokens = Math.max(usage.promptTokens, u.promptTokens)
          usage.completionTokens = Math.max(usage.completionTokens, u.completionTokens)
          usage.cachedTokens = Math.max(usage.cachedTokens, u.cachedTokens)
          usage.reasoningTokens = Math.max(usage.reasoningTokens, u.reasoningTokens)
          usage.cost += u.cost
          deps.emit({ type: 'usage', runId: req.runId, usage: { ...usage } })
        }
      })

      if (result.content?.trim()) finalText = result.content.trim()
      // record assistant turn
      const assistantMsg: LlmMessage = {
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.length
          ? result.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } }))
          : undefined
      }
      history.push(assistantMsg)
      // One step = one intention + the calls that carry it out. This is the unit
      // the transcript shows, so it is captured here and handed to the UI.
      roundNarration = result.content.trim()

      // A turn that fires tools without a single word of prose reads as a black
      // box: the user sees files being edited and no idea why. Ask for the
      // missing sentence instead of accepting the silence — a few times per run,
      // so the fix does not turn into a ping-pong of round trips.
      const bookkeeping = new Set(['todo_write', 'finish', 'suggest', 'notify_user', 'leave_note', 'attach_file'])
      const realCalls = result.toolCalls.filter((c) => !bookkeeping.has(c.name))
      // The first turn of a task must be words: a user who writes a message and
      // gets five file diffs back has been ignored. Not for continuations
      // (auto-resume after an outage has nothing new to answer).
      const continuation = /^(continue|продолжай|продолжи|дальше)\b/i.test((req.userMessage?.content || '').trim())
      const firstTurnOfTask = step === 1 && !continuation
      if (firstTurnOfTask && !result.content.trim() && result.toolCalls.length) {
        // Decline the calls, ask for the opening line, and let it work next turn.
        closeToolCalls(result.toolCalls, 'Not executed: open a new task with a sentence to the user first, then call this again.')
        history.push({
          role: 'user',
          content:
            '[first turn] You went straight to tools. The user wrote you a message and expects an answer in words: what you understood, what you are about to do, and anything you already think about the code or the project. Say it, then work.'
        })
        continue
      }
      if (!firstTurnOfTask && !result.content.trim() && realCalls.length && nudges < MAX_NUDGES) {
        nudges++
        // The calls are declined, not abandoned: answer each id, then ask for the
        // words. This turn is only about the missing sentence; the agent will
        // call its tools again straight away.
        closeToolCalls(realCalls, 'Not executed: you answered without a word to the user. Say what you are thinking and call this again.')
        closeToolCalls(result.toolCalls.filter((c) => bookkeeping.has(c.name)), 'Not executed yet.')
        history.push({ role: 'user', content: narratePrompt() })
        continue
      }

      if (!result.toolCalls.length) {
        // A run that narrated a plan and touched nothing is a wasted run: the
        // user reads "принято, делаю шаг 1" and no file changes. Push it to act.
        // Only when the reply is a promise of work ("принято, делаю…", "now I'll…"):
        // a plain answer to a plain question must not be pushed into acting.
        const promisesWork =
          /(сделаю|добавлю|провер[юи]|сейчас|начну|приступаю|исправ|перепиш|установл|создам|I'?ll|let me|now I|starting|going to)/i.test(
            result.content.slice(0, 600)
          )
        if (stableMode && !askedQuestion && promisesWork && !touched.size && step < 10 && silentRounds < 3) {
          silentRounds++
          history.push({
            role: 'user',
            content:
              '[nothing done yet] You have described what you are going to do, but no file has changed and no command has run. ' +
              'Stop planning out loud and do the first concrete thing now: read the file, run the command, make the edit. ' +
              'Do not answer with more prose — this turn must contain a tool call. ' +
              'If something truly blocks you, say what it is in one line and call finish.'
          })
          continue
        }
        // no more tools: if the message is empty and we have budget, nudge once
        if (!result.content.trim() && step < 3) {
          history.push({ role: 'user', content: 'Continue — and call finish when the task is complete.' })
          continue
        }
        if (stableMode && verifyStage === 'pending') {
          await pushVerifyPrompt()
          continue
        }
        if (stableMode) verifyStage = 'done'
        finalReason = 'done'
        break
      }

      // Execute tools sequentially so approvals and file state stay coherent
      const historyStart = history.length
      let halted: 'done' | 'error' | 'aborted' | undefined
      for (const call of result.toolCalls) {
        if (signal.aborted) {
          halted = 'aborted'
          break
        }
        let args: Record<string, any> = {}
        let parseError: string | null = null
        try {
          args = call.arguments?.trim() ? JSON.parse(call.arguments) : {}
        } catch (e: any) {
          parseError = `Invalid JSON arguments: ${e.message}`
        }

        const callSig = `${call.name}:${call.arguments}`
        const repeated = seenCallSignatures.has(callSig)
        seenCallSignatures.add(callSig)

        const view: ToolResultView = {
          id: call.id,
          name: call.name,
          args,
          status: parseError ? 'error' : 'running',
          error: parseError || undefined,
          durationMs: 0
        }

        if (parseError) {
          deps.emit({ type: 'tool-call', runId: req.runId, call: view })
          history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: `ERROR: ${parseError}` })
          continue
        }

        // A vote is valuable once; the second one in a row is spam. The model is
        // told the same rule in the prompt, this is the enforcement.
        if (call.name === 'ask_user' && (notifiedVote || settings.proposeVotes === false)) {
          deps.emit({
            type: 'tool-call',
            runId: req.runId,
            call: { ...view, status: 'error', error: 'Already asked the user once this run.' }
          })
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: `ERROR: ${settings.proposeVotes === false ? 'asking the user is disabled. ' : 'you already asked the user a question in this run. '}Decide yourself and continue.`
          })
          continue
        }

        // A vote never stalls the work: the run waits a short while for the user,
        // then proceeds with the option the model itself prefers. A late answer is
        // still delivered, as a note the model sees on its next round.
        let voteWait: Promise<string | null> | null = null
        if (call.name === 'ask_user') {
          const opts: string[] = Array.isArray(args.options) ? args.options.map(String).slice(0, 4) : []
          const preferred = String(args.recommend || opts[0] || 'yes')
          // The author's question is the checkpoint before any work happens, so it
          // waits like a person would: ten minutes, not ninety seconds. A builder
          // question would be different, but the builder has no ask_user at all.
          const waitDefault = role === 'author' ? 600 : 90
          voteWait = new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => {
              run.votes.delete(call.id)
              resolve(null)
            }, Math.max(15, Number(args.waitSeconds) || waitDefault) * 1000)
            run.votes.set(call.id, (answer) => {
              clearTimeout(timer)
              resolve(answer)
            })
          })
          ;(args as any).__default = preferred
        }

        const needsApproval =
          (req.workspace || fullDisk) &&
          toolNeedsApproval(call.name, approvalPolicy, new Set([...(settings.allowedTools || []), ...run.autoApproved]))
        if (needsApproval) {
          view.status = 'awaiting-approval'
          if ((req.workspace || fullDisk) && (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'multi_edit')) {
            view.diff = await previewTool(call.name, args, req.workspace || os.homedir(), fullDisk)
          }
          deps.emit({ type: 'tool-call', runId: req.runId, call: view })
          const decision = await ctx.requestApproval(view)
          if (decision === 'deny' || signal.aborted) {
            const denied: ToolResultView = { ...view, status: 'denied', error: 'User denied this action.' }
            deps.emit({ type: 'tool-update', runId: req.runId, call: denied })
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: 'The user DENIED this action. Do not retry it. Ask what they want instead, or continue with a different approach.'
            })
            continue
          }
          view.status = 'running'
        } else {
          deps.emit({ type: 'tool-call', runId: req.runId, call: view })
        }

        const t0 = Date.now()
        const outcome = await executeTool(call.name, args, ctx)
        if (stableMode) {
          const sig = `${call.name}:${JSON.stringify(args).slice(0, 200)}`
          const seen = (callCounts.get(sig) || 0) + 1
          callCounts.set(sig, seen)
          if (!outcome.ok) {
            errorsSoFar.push({ step, name: call.name, error: (outcome.error || outcome.output || '').slice(0, 300) })
          }
          // The same call failing repeatedly is a warning, not a death sentence:
          // the run stops only when the model stops trying anything new (see the
          // round-signature check below). Warnings are counted, not fatal.
          if (seen === 3 && !outcome.ok) {
            repeatWarnings++
          }
        }
        const finished: ToolResultView = {
          ...view,
          status: outcome.ok ? 'ok' : 'error',
          output: outcome.output,
          error: outcome.error,
          diff: outcome.diff,
          attach: outcome.meta?.attach,
          locale: outcome.locale,
          durationMs: Date.now() - t0
        }
        deps.emit({ type: 'tool-update', runId: req.runId, call: finished })
        if (outcome.notify) notify(outcome.notify.title, outcome.notify.body, !!outcome.notify.urgent)
        if (outcome.meta?.note?.text) {
          deps.emit({
            type: 'note',
            runId: req.runId,
            note: {
              id: randomUUID(),
              text: outcome.meta.note.text,
              target: outcome.meta.note.target,
              tone: outcome.meta.note.tone ?? 2,
              createdAt: Date.now(),
              status: 'pending',
              byAgent: true
            }
          })
        }

        if (outcome.diff?.length) {
          deps.emit({ type: 'files-changed', runId: req.runId, paths: outcome.diff.map((d) => d.path) })
        }

        if (call.name === 'run_command' && outcome.ok) {
          ranAnyCommand = true
          okCommands.push(String(args.command || '').slice(0, 200))
        }
        if (repeated && READ_ONLY_TOOLS.has(call.name) && outcome.ok) {
          // Re-reading the same file with the same arguments: it is already in the
          // history and in the transcript. Say so once so it stops orbiting.
          readOnlySteps++
          deps.emit({
            type: 'guard',
            runId: req.runId,
            kind: 'steer',
            title: `Повторное чтение: ${call.name}`,
            detail: 'Этот вызов уже был — тратит время. Прошу перейти к правке.'
          })
        }
        // Reading is progress in understanding, not in the work: it counts
        // separately so it can be capped without cutting real edits short.
        if (READ_ONLY_TOOLS.has(call.name)) {
          readOnlySteps++
        } else {
          roundProgressed = true
          idleRounds = 0
        }
        const toolContent = outcome.ok
          ? String(outcome.output ?? 'ok')
          : `ERROR: ${outcome.error || 'tool failed'}${outcome.output ? `\n${outcome.output}` : ''}`
        history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toolContent.slice(0, 30000) })
        // An image the model asked to look at: the tool result is text, so the
        // bytes ride on a follow-up user message where every vision API expects
        // them. Without this, view_image returned a polite sentence about a
        // picture nobody could see.
        if (outcome.meta?.imageUrl) {
          history.push({
            role: 'user',
            content: [
              { type: 'text' as const, text: `Image from ${outcome.meta.imageRel || 'disk'} (you asked to see it):` },
              { type: 'image_url' as const, image_url: { url: String(outcome.meta.imageUrl), detail: 'original' as const } }
            ]
          })
        }

        roundTools.push({ id: call.id, name: call.name, ok: outcome.ok, error: outcome.error || outcome.output || '', args })
        if (stableMode) {
          const sig = `${call.name}:${JSON.stringify(args).slice(0, 240)}`
          const key = `${outcome.ok ? 'ok' : 'fail'}|${sig}`
          const seen = (roundSignatures.get(key) || 0) + 1
          roundSignatures.set(key, seen)
          // The same call failing the same way is only a loop if nothing else is
          // happening. Exploring a project, probing a jar, retrying a flaky
          // command with new arguments — that is work. Only a run where the model
          // has stopped making any other progress is stopped here; otherwise the
          // failed call is reported back and the agent moves on by itself.
          if (!outcome.ok && seen >= 4 && !loopHits && !touched.size && noNewCallsThisRound(result.toolCalls)) {
            loopHits = seen
            loopNote = (outcome.error || outcome.output || 'вызов не прошёл').split('\n')[0].slice(0, 240)
            deps.emit({
              type: 'guard',
              runId: req.runId,
              kind: 'stuck',
              title: 'Один вызов не проходит — меняю подход',
              detail: `${call.name} · ${loopNote}`
            })
            // Make the run end on its own terms: the model is told, in its own
            // words, that the same call keeps failing, and it may continue with a
            // different approach or finish. A run you walked away from must not be
            // left hanging on a guard card.
            history.push({
              role: 'user',
              content:
                `[same call keeps failing] \`${call.name}\` failed the same way ${seen} times and nothing has changed. ` +
                'Do not call it again with the same arguments. Try a genuinely different approach, or if it is not possible, ' +
                'explain the blocker in one line and call finish with work_done=false.'
            })
            loopHits = 0
          }
        }

        if (call.name === 'ask_user' && outcome.ok) {
          notifiedVote = true
          const preferred = String((args as any).__default || '')
          const picked = voteWait ? await voteWait : null
          const answer = picked || preferred
          if (picked) {
            // replace the tool result so the model works with what the user chose
            history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: `The user answered: ${picked}` })
          } else {
            deps.emit({
              type: 'vote-auto',
              runId: req.runId,
              voteId: call.id,
              answer: preferred,
              detail: 'никто не ответил — взят вариант, который агент считает лучшим'
            })
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: `No answer yet. Proceeding with your recommended option: ${answer}. Mention it in your summary so the user can still correct you.`
            })
          }
        }

        // A thirteen-section spec that produced three files is not a finished mod.
        // This is a floor, not a quota: one refusal, and only when the output is
        // absurdly small for the ask — not a lever that pushes towards padding.
        if (call.name === 'finish' && stableMode && specSections.length >= 6
            && touched.size < Math.min(5, Math.max(3, specSections.length / 3))
            && scopeRefused < 1) {
          scopeRefused++
          deps.emit({
            type: 'guard',
            runId: req.runId,
            kind: 'errors',
            title: `Не принял «готово»: на ${specSections.length} разделов спеки только ${touched.size} файл(ов)`,
            detail: 'Такой объём не покрывается парой классов — продолжаю работу.'
          })
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content:
              `Finish refused: the spec has ${specSections.length} sections and this run touched only ${touched.size} file(s). ` +
              'Systems of this size live in many classes: core stats, weather, wind, snow, clothing, mobs, loot, machine, diseases, HUD, networking, localization. ' +
              'Continue implementing the sections that are still missing — real code, one class per system, wired into the initializer. ' +
              'Do not pad with empty files either: each file must hold working behaviour.'
          })
          continue
        }

        if (call.name === 'finish' && stableMode && artifactMissing()) {
          const found = await findArtifact(req.workspace || '', wantedArtifact)
          if (!found) {
            artifactRefused++
            const label = wantedArtifact.toUpperCase()
            deps.emit({
              type: 'guard',
              runId: req.runId,
              kind: 'errors',
              title: `Не принял «готово»: сборки ${label} нет`,
              detail: 'Скажите «готово», когда артефакт реально существует на диске.'
            })
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content:
                `Finish refused: the user asked for a built ${label} and there is no such file in the project. ` +
                'A summary is not a build. Run the actual build command now (gradle build, npm run dist, maven package…), ' +
                'fix the errors it prints one by one, and only then finish. ' +
                'If the toolchain is genuinely missing on this machine, say exactly what is missing and where you looked.'
            })
            continue
          }
          artifactFound = found
        }

        if (outcome.halt) {
          // A todo list with four open items and a finish call is not a finish —
          // it is a surrender dressed as success. The user sees "готово" and a
          // half-built project. Refuse while the plan still has work left, unless
          // the model explains a real blocker.
          if (call.name === 'finish' && todos.length) {
            const open = todos.filter((x) => x.status !== 'done')
            const summary = String(args.summary || args.message || '')
            const blocked = (args.work_done === false && summary.length > 40) || /(не могу|невозможно|cannot|blocked|нет доступа)/i.test(summary)
            if (open.length && !blocked && gaveUpRefused < 2) {
              gaveUpRefused++
              deps.emit({
                type: 'guard',
                runId: req.runId,
                kind: 'errors',
                title: `Не принял «готово»: в плане ещё ${open.length} пункт(ов)`,
                detail: open.slice(0, 3).map((x) => String(x.text).slice(0, 60)).join(' · ')
              })
              history.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content:
                  `Finish refused: your own plan still has ${open.length} open item(s): ` +
                  open.slice(0, 8).map((x) => `"${String(x.text).slice(0, 80)}"`).join(', ') +
                  '. Do not stop here. Mark what is genuinely done with todo_write, then continue with the next open item ' +
                  'and finish only when the plan is empty. If a specific item is truly impossible, say which one and why in one line, ' +
                  'and call finish again — the user will be told exactly what is missing.'
              })
              continue
            }
          }
          // "готово" with nothing done is not a finish: it is the failure the user
          // screenshots. Refuse it once, make it do the work it promised.
          // the model itself says nothing was done: never show that as a success
          const claimedNoWork = call.name === 'finish' && args.work_done === false
          if (claimedNoWork && !touched.size && !ranAnyCommand && finishRefused < 1) {
            finishRefused++
            deps.emit({
              type: 'guard',
              runId: req.runId,
              kind: 'errors',
              title: 'Не принял «готово»: ничего не изменено',
              detail: 'Ни одного файла и ни одной команды — прошу сначала сделать шаг.'
            })
            history.push({
              role: 'user',
              content:
                '[finish refused] You called finish with work_done=false, so nothing was done. That is not a finished task. ' +
                'Do the first step of the work you described now — a real tool call — and only then finish. ' +
                'If you genuinely cannot do it, explain what blocks you in one line and call finish again with work_done=false — and the user will be told the task was not done.'
            })
            continue
          }
          halted = outcome.halt
          break
        }
      }

      // Stopped or halted in the middle of a round: the calls that never ran still
      // need an answer, otherwise the next request is malformed and the user reads
      // "insufficient tool messages" instead of a stopped run.
      if (result.toolCalls.length) {
        const answered = new Set<string>()
        for (let i = historyStart; i < history.length; i++) {
          const m = history[i]
          if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id)
        }
        const unanswered = result.toolCalls.filter((c) => !answered.has(c.id))
        if (unanswered.length) closeToolCalls(unanswered, 'Not executed: the run was stopped before this call.')
      }

      // checkpoint after each mutating round
      if (beforeState.size) {
        const files = [...beforeState.entries()].map(([abs, content]) => ({
          rel: toRel(req.workspace || '', abs),
          content
        }))
        const cp: Checkpoint = {
          id: randomUUID(),
          label: `Step ${step} · ${files.length} file${files.length === 1 ? '' : 's'}`,
          createdAt: Date.now(),
          threadId: req.threadId,
          files
        }
        checkpoints.push(cp)
        await saveCheckpoint(cp).catch(() => {})
        deps.emit({ type: 'checkpoint', runId: req.runId, checkpoint: cp })
        beforeState.clear()
      }

      // The round is done: hand the UI one step — the sentence and the calls.
      if (roundTools.length) {
        deps.emit({
          type: 'step-note',
          runId: req.runId,
          step,
          say: roundNarration,
          actions: roundTools.map((t) => ({ id: t.id, name: t.name, ok: t.ok, error: t.error.slice(0, 300), args: t.args }))
        })
      }
      roundTools = []

      if (halted === 'aborted') {
        finalReason = 'stopped'
        break
      }
      if (halted === 'done') {
        if (stableMode && verifyStage === 'pending') {
          await pushVerifyPrompt()
          continue
        }
        if (stableMode) verifyStage = 'done'
        finalReason = 'done'
        break
      }
      if (halted === 'error') {
        finalReason = 'error'
        break
      }

      if (stableMode) {
          // A round that only read files and changed nothing: fine for a while, then
        // it becomes the "slowly treading water" the user sees. Count it and push.
        if (!roundProgressed) {
          idleRounds++
          if (!askedQuestion && idleRounds >= MAX_IDLE_ROUNDS && step - lastIdlePrompt >= MAX_IDLE_ROUNDS) {
            lastIdlePrompt = step
            deps.emit({
              type: 'guard',
              runId: req.runId,
              kind: 'steer',
              title: `Хватит читать — ${idleRounds} раунда без изменений`,
              detail: 'Прошу сделать первый конкретный шаг: правку или команду.'
            })
            history.push({
              role: 'user',
              content:
                `[no changes for ${idleRounds} rounds] You keep reading and nothing in the workspace has changed. ` +
                'Stop gathering context: you almost certainly know enough to make the first real change. ' +
                'Make it now — edit the file, run the command. Read only what that specific step requires, one file at a time. ' +
                'If the task genuinely cannot proceed, say in one line what blocks it and call finish with work_done=false.'
            })
          }
        }
        roundProgressed = false

        // Exploration budget: reading is not work, so it does not get the whole
        // step budget. When it runs out the agent is told to act with what it has.
        if (readOnlySteps > MAX_IDLE_READS && !touched.size && idleRounds > 0) {
          readOnlySteps = 0
          deps.emit({
            type: 'guard',
            runId: req.runId,
            kind: 'steer',
            title: 'Бюджет на изучение закончился',
            detail: 'Дальше — только правки и команды по тому, что уже прочитано.'
          })
          history.push({
            role: 'user',
            content:
              `[exploration budget spent] You have made ${MAX_IDLE_READS}+ read-only calls and changed nothing yet. ` +
              'From now on act on what you already read: make the edits, run the build. Do not open more files unless a ' +
              'change you are making right now fails and needs one specific file to fix.'
          })
        }

      // money ceiling: a run you walk away from must not surprise you
        if (costCap > 0 && usage.cost >= costCap && !notifiedCost) {
          notifiedCost = true
          deps.emit({
            type: 'guard',
            runId: req.runId,
            kind: 'cost',
            title: `Лимит стоимости: $${usage.cost.toFixed(4)} из $${costCap.toFixed(2)}`,
            detail: 'Прогон остановлен, чтобы счёт не вырос. Продолжите вручную, когда будете готовы.'
          })
          finalReason = 'guard'
          break
        }
      }

      // The user typed mid-run: their words arrive before the next round, so a
      // correction actually changes what happens next.
      const notes = steerNotes.get(req.runId)
      if (notes?.length) {
        steerNotes.delete(req.runId)
        for (const n of notes) {
          deps.emit({ type: 'guard', runId: req.runId, kind: 'steer', title: n.slice(0, 180) })
        }
        history.push({
          role: 'user',
          content:
            `[the user sent you a clarification while you were working]\n` +
            notes.map((n) => `- ${n}`).join('\n') +
            `\nWork it in on your next steps. If it is already covered or no longer applies, say why in one line and move on.`
        })
      }

      // A user can answer a question after the agent already moved on: hand those
      // answers to the model at the start of the next round so it can adapt.
      if (answeredVotes.size) {
        const late = [...answeredVotes.entries()]
        answeredVotes.clear()
        history.push({
          role: 'user',
          content:
            `[late answers] The user answered questions you had already proceeded past:\n` +
            late.map(([id, a]) => `- ${id}: ${a}`).join('\n') +
            `\nAdapt your plan to these answers if they change anything.`
        })
      }

      // The thing that separates a professional from a clerk is the pass nobody
      // asked for: what will this feel like, what is missing from the spec, what
      // would make it good rather than compliant. One round, before code.
      if (step === 1 && substantial && !designPassed) {
        designPassed = true
        deps.emit({
          type: 'guard',
          runId: req.runId,
          kind: 'steer',
          title: 'Сначала проход автора, потом работа',
          detail: 'Мудборд, композиция, что добавить сверх спеки.'
        })
        history.push({
          role: 'user',
          content:
            '[author pass — before you start making anything]\n' +
            'You have room here: this is your design as much as the request. Prefer the version you would be proud of over the smallest thing that satisfies the list — as long as it still runs and still fits what was asked.\n' +
            'You are the author of this, not a contractor filling an order. Before touching files, decide and write short and concrete:\n' +
            '1. WHAT THIS REALLY IS — one paragraph on what the user is actually asking for, in your words. If the request is vague or one part of it is impossible, say so here and say what you will do instead.\n' +
            '2. WHAT IT IS JUDGED ON — the three things that will make the user say "yes, that is it" (for code: does it run, does it fit the codebase, is the API shaped sensibly; for a document: structure, accuracy, voice; for a refactor: invariants kept, nothing broken; for a dataset: coverage and correctness).\n' +
            '3. WHAT THE REQUEST LEFT OUT — at least five things a professional would add without being told, specific to this task, and then add them for real. Not invented features: the details that separate done from well done — error paths, edge cases, empty states, a migration, a test, a fallback, naming that reads well.\n' +
            '4. THE SHAPE — how it will be organised: which files/classes/sections, what goes where, what is reused instead of rewritten, what the one part the user will look at first is.\n' +
            (visualish
              ? '5. FOR SOMETHING SEEN OR FELT — composition and mood: where each element sits, what the eye hits first, what is only shown when relevant, the density of particles/fog/colour, day length, transitions, the single moment worth a screenshot. Add these for real, not as a mention.\n'
              : '5. THE ONE THING — the single part that will make the user glad they asked you instead of anyone else. Build towards it.\n') +
            'Write this to the user as your own thinking, then work. In the summary, say what you added beyond the request — this user explicitly welcomes it.'
        })
      }

      // A pasted spec with sections: the plan must be those sections, not a
      // vague three-step story. This runs before any exploring so the run has a
      // shape from the start, and it names every section explicitly.
      if (step === 1 && specSections.length >= 4 && !todos.length) {
        specPlanAsked = true
        history.push({
          role: 'user',
          content:
            `[spec coverage] The user pasted a specification with ${specSections.length} numbered sections:\n` +
            specSections.map((x) => `${x.n}. ${x.title}`).join('\n') +
            '\n\nBuild the todo list from exactly these sections with todo_write — one item per section, same wording. ' +
            'Then work through them in order. Do not start with a two-item plan; the user will judge the result by these sections.'
        })
      }

      // nudge toward a plan for long tasks
      if (step === 2 && req.workspace && !todos.length && req.maxSteps > 4) {
        history.push({
          role: 'user',
          content: 'Reminder: if this task has multiple steps, call todo_write to track the plan before continuing.'
        })
      }
    }

    if (step >= Math.max(1, req.maxSteps)) finalReason = 'limit'

    // Label the files this run created or rewrote, in the background: by the time
    // the user opens the explorer they already read like known things.
    if (touched.size && req.describeFiles !== false) {
      const task = (req.userMessage?.content || '').slice(0, 600)
      describeInBackground(
        [...touched].filter((p) => !SKIP_DESCRIBE.test(p)).map((p) => ({ path: p, note: 'the agent created or rewrote this file during the task above' })),
        {
          task,
          onEach: (summary) => deps.emit({ type: 'file-summaries', runId: req.runId, summaries: [summary] })
        }
      )
    }
  } catch (e: any) {
    if (signal.aborted) {
      finalReason = 'stopped'
    } else {
      finalReason = 'error'
      // Protocol-level 400s are ours, not the user's problem to read: say what
      // happened in Russian instead of pasting the API's sentence.
      const raw = String(e?.message || e)
      const message = /must be followed by tool messages|insufficient tool messages|tool_call_id/i.test(raw)
        ? 'Агент потерял связку «вызов инструмента → результат». Такое не должно повторяться: прогон перезапущен, история почищена.'
        : raw
      deps.emit({ type: 'error', runId: req.runId, message })
    }
  } finally {
    // How did it end, in one line the user can read from across the room.
    if (finalReason === 'done' && !touched.size && !ranAnyCommand) {
      // the model stopped mid-promise: tell the user plainly instead of a green card
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'errors',
        title: 'Прогон закончился без изменений',
        detail: 'Агент описал план, но ничего не сделал. Продолжите — он начнёт с первого шага.'
      })
    }
    // Hand over the result whether or not the model remembered to: every file this
    // run wrote, plus a built artifact if one exists, arrives in the chat with a
    // path and an open button. Asking the model to do this did not work reliably,
    // so the app does it.
    if (touched.size) {
      const attachments: Attachment[] = []
      const artifact = wantedArtifact ? await findArtifact(req.workspace || '', wantedArtifact) : ''
      if (artifact) {
        attachments.push({
          id: randomUUID(),
          name: path.basename(artifact),
          kind: 'file',
          content: '',
          path: artifact,
          rel: path.relative(req.workspace || artifact, artifact) || path.basename(artifact)
        })
      }
      for (const abs of [...touched].slice(0, 8)) {
        if (attachments.length >= 9) break
        const rel = path.relative(req.workspace || abs, abs) || abs
        if (attachments.some((a) => a.path === abs)) continue
        attachments.push({ id: randomUUID(), name: path.basename(abs), kind: 'file', content: '', path: abs, rel })
      }
      if (attachments.length) {
        deps.emit({ type: 'attachments', runId: req.runId, attachments })
      }
      // The hand-over: what this run produced, with one line on what each file
      // is. Snapshotting before the description call matters — the list must not
      // depend on prose succeeding.
      const presented = new Map<string, { path: string; rel: string; kind: 'file' | 'artifact' }>()
      if (artifact) {
        presented.set(artifact, {
          path: artifact,
          rel: path.relative(req.workspace || artifact, artifact) || path.basename(artifact),
          kind: 'artifact'
        })
      }
      for (const abs of [...touched].slice(0, 24)) {
        if (presented.has(abs)) continue
        presented.set(abs, {
          path: abs,
          rel: path.relative(req.workspace || abs, abs) || path.basename(abs),
          kind: /\.(jar|exe|msi|dmg|appimage|deb|zip|apk|aab)$/i.test(abs) ? 'artifact' : 'file'
        })
      }
      if (presented.size) {
        const list = [...presented.values()]
        deps.emit({ type: 'present', runId: req.runId, files: list })
        if (req.describeFiles !== false && settings.describeFiles !== false) {
          // Background on purpose: the hand-over list is already on screen, and
          // the one-line labels can arrive as they are written.
          describeInBackground(
            list.filter((f) => !SKIP_DESCRIBE.test(f.path)).slice(0, 8).map((f) => ({ path: f.path, note: 'the agent produced this file during the task above' })),
            {
              task: (req.userMessage?.content || '').slice(0, 600),
              onEach: (summary) => deps.emit({ type: 'file-summaries', runId: req.runId, summaries: [summary] })
            }
          )
        }
      }
    }

    if (finalReason === 'done' && touched.size) {
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'done',
        title: `файлов — ${touched.size}, шагов — ${step}, $${usage.cost.toFixed(4)}`,
        detail: verifyStage === 'done' ? 'Результат проверен перед тем, как сказать «готово».' : undefined
      })
      if (wantedArtifact) {
        const built = artifactFound || (await findArtifact(req.workspace || '', wantedArtifact))
        if (built) {
          deps.emit({
            type: 'guard',
            runId: req.runId,
            kind: 'done',
            title: `Собрано: ${path.basename(built)}`,
            detail: built
          })
          notify('Сборка готова', path.basename(built))
        } else {
          deps.emit({
            type: 'guard',
            runId: req.runId,
            kind: 'errors',
            title: `Сборки ${wantedArtifact.toUpperCase()} нет`,
            detail: 'Файлы изменены, но артефакт не появился — задача не доведена до конца.'
          })
          notify('Прогон закончился без артефакта', `Правки есть, готового ${wantedArtifact} нет`, true)
        }
      } else {
        notify('Задача выполнена', `${touched.size} файл(ов) изменено, ${step} шагов, $${usage.cost.toFixed(4)}`)
      }
    } else if (finalReason === 'guard') {
      notify('Прогон остановлен защитой', 'Смотрите карточку в приложении — там причина.', true)
    } else if (finalReason === 'done' && !touched.size) {
      notify('Прогон закончился без изменений', 'Агент описал план, но файлы не тронуты — откройте и продолжите.', true)
    } else if (finalReason === 'error') {
      notify('Прогон упал с ошибкой', 'Смотрите карточку в приложении.', true)
    }
    if (repeatWarnings >= 2) {
      // the agent kept hitting the same wall: worth telling the user explicitly
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'errors',
        title: 'Один и тот же вызов падал несколько раз',
        detail: 'Прогон не остановлен: агент пробовал другие пути. Смотрите карточки инструментов выше.'
      })
    }
    if (stableMode && errorsSoFar.length) {
      const uniq = [...new Map(errorsSoFar.map((e) => [e.name + e.error, e])).values()]
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'errors',
        title: `За прогон было ${errorsSoFar.length} ошибок инструментов`,
        detail: uniq
          .slice(0, 5)
          .map((e) => `шаг ${e.step} · ${e.name}: ${e.error.split('\n')[0].slice(0, 120)}`)
          .join('\n')
      })
    }
    steerNotes.delete(req.runId)
    active.delete(req.runId)
    deps.emit({ type: 'usage', runId: req.runId, usage })
    deps.emit({ type: 'run-end', runId: req.runId, reason: finalReason })
  }

  lastFinalText.set(req.runId, finalText)
  return { ok: true, finalText, touched: [...touched], todos }
}

/**
 * The current user turn. Images travel as OpenAI-style `image_url` blocks so a
 * vision-capable model actually sees them; text attachments stay inline because
 * they cost a fraction of the tokens.
 */
function buildUserContent(msg: ChatMessage, attachments: Attachment[]): string | LlmContentPart[] {
  const text = msg.content || ''
  const images = (attachments || []).filter((a) => a.kind === 'image' && a.content)
  const docs = (attachments || []).filter((a) => a.kind !== 'image')
  const docBlocks = docs
    .map((a) => {
      if (a.kind === 'selection') {
        return `<selection path="${a.rel}" lines="${a.from}-${a.to}">\n${a.content}\n</selection>`
      }
      return `<file path="${a.rel || a.name}">\n${a.content}\n</file>`
    })
    .join('\n\n')
  const body = docBlocks ? `${text}\n\n${docBlocks}` : text
  if (!images.length) return body

  const parts: LlmContentPart[] = images.map((a) => ({
    type: 'image_url' as const,
    image_url: { url: a.content, detail: 'original' as const }
  }))
  if (body.trim()) parts.unshift({ type: 'text' as const, text: body })
  return parts
}

export function listActiveRuns(): string[] {
  return [...active.keys()]
}

/**
 * What should "verified" mean for this project?
 *
 * Stable mode asks the project itself: a test script, a type-check script, or a
 * known manifest. The user can override it in Settings, which always wins.
 */
export async function pickVerifyCommand(configured: string, workspace: string, touched: Set<string>): Promise<string> {
  if (configured.trim()) return configured.trim()
  if (!workspace) return ''
  const has = async (rel: string): Promise<boolean> =>
    fs
      .stat(path.join(workspace, rel))
      .then(() => true)
      .catch(() => false)
  try {
    const pkgRaw = await fs.readFile(path.join(workspace, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; packageManager?: string }
    const scripts = pkg.scripts || {}
    const pm = /pnpm/.test(pkg.packageManager || '') ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : (await has('pnpm-lock.yaml')) ? 'pnpm' : 'npm'
    if (scripts.test && !/no test specified/i.test(scripts.test)) return `${pm} test`
    for (const script of ['typecheck', 'type-check', 'tsc', 'lint', 'check', 'build']) {
      if (scripts[script]) return `${pm} run ${script}`
    }
  } catch {
    /* not a node project */
  }
  if (await has('Cargo.toml')) return 'cargo check'
  if (await has('go.mod')) return 'go build ./...'
  if (await has('pyproject.toml') || await has('requirements.txt')) {
    return (await has('tests')) || [...touched].some((p) => /test/i.test(p)) ? 'python -m pytest -q' : 'python -m compileall -q .'
  }
  if ((await has('pom.xml')) && (await has('mvnw'))) return './mvnw -q -DskipTests compile'
  if (await has('gradlew')) return './gradlew -q compileDebugJavaWithJavac'
  if ((await has('pom.xml')) || (await has('build.gradle')) || (await has('build.gradle.kts'))) {
    return 'echo "no wrapper here — verify with your IDE or install gradle/maven"'
  }
  if (await has('Makefile')) return 'make -n'
  return ''
}

/**
 * Find the artifact the user asked for (a jar, an exe, an AppImage…). Claims are
 * cheap; a file on disk is not. Walks the build output folders first and stops at
 * the first hit, skipping the dependency caches nobody ships.
 */
export async function findArtifact(workspace: string, ext: string): Promise<string> {
  if (!workspace || !ext) return ''
  const roots = ['build', 'dist', 'out', 'target', 'release', '.', 'libs', 'app/build']
  const pending = roots.map((r) => path.join(workspace, r))
  let budget = 4000
  while (pending.length && budget-- > 0) {
    const dir = pending.shift()!
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.gradle') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        pending.push(abs)
        continue
      }
      if (e.name.toLowerCase().endsWith(`.${ext}`)) return abs
    }
  }
  return ''
}

/**
 * Which model does this step get?
 *
 * The benchmarks are unambiguous and they are not what "bigger is better" says:
 * DeepSeek V4.1-Flash beats V4 Pro on agentic coding — DeepSWE v1.1 77.0 vs 62.7,
 * Terminal-Bench 4.0 42.3 vs 12.4 — and costs 3.3x less on output. So Pro is not
 * the default for writing code; it is the default for the thinking-heavy part:
 * the opening pass where the plan is made, and long specs.
 *
 * The user's own choice always wins: pick Pro and every step is Pro.
 */
export function pickModelForStep(
  req: { model: string; userMessage?: { content?: string } | null },
  step: number,
  info: { substantial: boolean; specSections: number; planning: boolean }
): string {
  const chosen = req.model
  // explicit choice of a concrete model stays put
  if (chosen === 'deepseek-v4-pro') return chosen
  if (!chosen.startsWith('deepseek-')) return chosen

  const wantsPro = info.substantial && (info.specSections >= 4 || info.planning)
  // only ever upgrade, never silently downgrade a Pro pick
  return wantsPro ? 'deepseek-v4-pro' : chosen
}


/* ------------------------------------------------------------------ */
/* The team: author -> builder -> author review                        */
/* ------------------------------------------------------------------ */

export interface TeamResult {
  ok: boolean
  error?: string
  brief?: Brief | null
  roles: AgentRole[]
}

/**
 * Who does what, and in which order.
 *
 * The old design had one agent trying to be a colleague and a compiler at the
 * same time, which is why it answered a request for a mod with a README and a
 * request for an explanation with a plan. Splitting them fixes the behaviour at
 * the root: the author has no write tools, so it cannot "just start", and the
 * builder has no questions, so it cannot drift.
 *
 * Nothing here is a straight line: the author sees the builder's report and the
 * files it touched, and can send it back once. That is the review the user was
 * missing, and it costs one cheap round instead of a broken deliverable.
 */
export async function runTeam(req: RunRequest, deps: AgentDeps): Promise<TeamResult> {
  const settings = await getSettings()
  const caps: Capabilities =
    req.capabilities || settings.capabilities || { edit: 'ask', run: 'ask', planner: 'auto' }
  const text = req.userMessage?.content || ''
  const plan = planRoles({ text, planner: caps.planner, substantial: text.length > 400 })

  // questions are answered by the author alone; with the planner off, everything
  // is the old single agent
  if (plan.roles.length === 1 && plan.roles[0] === 'author') {
    return runAuthorOnly(req, deps)
  }
  if (plan.roles[0] === 'builder' && caps.planner === 'off') {
    return { ok: (await runAgent({ ...req, roleMode: 'single', role: 'builder' }, deps)).ok, roles: ['builder'] }
  }
  if (plan.roles[0] === 'builder') {
    // small mechanical work: straight to the hands, with the old prompt so the
    // builder still knows how to talk about what it did
    return { ok: (await runAgent({ ...req, role: 'builder', roleMode: 'split' }, deps)).ok, roles: ['builder'] }
  }

  // 0. the contract. A task big enough to be worth doing is big enough to be
  // written down as checks, and those checks come from the user's words — not
  // from whatever the builder decides it accomplished.
  let contract = ''
  const wantsContract = settings.stableMode !== false && needsSpec(req.userMessage?.content || '')
  if (wantsContract) {
    const spec = await ensureSpec({
      workspace: req.workspace,
      request: req.userMessage?.content || '',
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: 'deepseek-flash'
    })
    if (spec.spec) {
      contract = spec.spec
      const criteria = spec.spec
        .split(/\r?\n/)
        .filter((l) => /^\s*(?:[-*]|\d+[.)])\s+/.test(l)).length
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'contract',
        title: spec.written ? `Контракт записан: ${criteria} критериев в SPEC.md` : 'Контракт взят из SPEC.md проекта',
        detail: spec.path || undefined
      })
    }
  }

  // 1. the author thinks, talks and writes the brief
  const authorRes = await runAgent({ ...req, role: 'author', roleMode: 'split', spec: contract }, deps)
  if (!authorRes.ok) return { ok: false, error: authorRes.error, roles: ['author'] }
  const brief = parseBrief(authorRes.finalText || '')
  if (!brief) {
    // The author answered in prose without a brief: that is a conversation, not
    // a task, so the builder is not started on a guess. But the user may simply
    // have asked for work and got an opinion, which would be exactly the old bug
    // — so say it out loud instead of ending quietly.
    deps.emit({
      type: 'guard',
      runId: req.runId,
      kind: 'steer',
      title: 'Автор ответил словами, без брифа',
      detail: 'Если это была задача, а не вопрос — включите «Планировщик: всегда» или скажите «сделай».'
    })
    return { ok: true, roles: ['author'], brief: null }
  }

  // 2. the builder executes it
  const buildReq: RunRequest = {
    ...req,
    runId: `${req.runId}:build`,
    messageId: `${req.messageId}:build`,
    role: 'builder',
    roleMode: 'split',
    brief,
    history: [],
    userMessage: { ...req.userMessage, content: brief.raw }
  }
  buildReq.spec = contract
  buildReq.specAttempt = 0
  let buildRes = await runAgent(buildReq, deps)
  let report = buildRes.finalText || ''

  // 2b. the independent check. Not the author's opinion and not the builder's
  // report: a separate pass reads the criteria against the changed files and can
  // fail the work. This is the step that would have caught "тебя просили мод, а
  // ты сделал частицы на пауков".
  //
  // A failed check does not end the run either: the goal below keeps opening
  // rounds until the criteria are actually met, the work stalls, or the round
  // budget is spent. That is the difference between "остановился на середине" and
  // "довёл до конца".
  let lastCheck: SpecReport | null = null
  let goalRounds = 1
  if (contract && buildRes.ok) {
    const roundCheck = async (round: number): Promise<SpecReport | null> => {
      const c = await checkAgainstSpec({
        request: req.userMessage?.content || '',
        spec: contract,
        report,
        files: changedFileExcerpts(req.workspace, buildRes.touched || []),
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: 'deepseek-flash'
      })
      if (c) {
        lastCheck = c
        deps.emit({ type: 'spec-check', runId: req.runId, report: c, attempt: round, refused: c.verdict === 'rework' })
      }
      return c
    }

    lastCheck = await roundCheck(1)
    const maxRounds = Math.max(1, settings.goalRounds || 1)
    const signal = shouldContinue(contract, lastCheck, buildRes.todos || [])
    if (signal && maxRounds > 1) {
      const outcome = await driveGoal({
        req: { ...buildReq, userMessage: { ...req.userMessage, content: req.userMessage.content } },
        deps,
        signal,
        maxRounds,
        usedRounds: 1,
        contract,
        afterRound: roundCheck
      })
      goalRounds = outcome.rounds
      lastCheck = outcome.lastCheck || lastCheck
      report = outcome.lastText || report
      if (outcome.stop === 'rounds-used') {
        deps.emit({
          type: 'guard',
          runId: req.runId,
          kind: 'rework',
          title: `Цель не закрыта за ${outcome.rounds} раунд(а)`,
          detail: 'Критерии всё ещё не подтверждены — продолжите, и я возьму следующий раунд с того же места.'
        })
      }
    } else if (signal) {
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'rework',
        title: 'Критерии не подтверждены',
        detail: 'Авто-раунды выключены (Настройки → раунды цели). Работа не закончена.'
      })
    }
  }

  // 3. the author checks the result and speaks to the user about it
  if (settings.reviewPass && buildRes.ok) {
    const reviewReq: RunRequest = {
      ...req,
      runId: `${req.runId}:review`,
      messageId: `${req.messageId}:review`,
      role: 'author',
      roleMode: 'split',
      brief,
      history: [],
      userMessage: {
        ...req.userMessage,
        content:
          `Бриф:
${brief.raw}

Отчёт сборщика:
${report.slice(0, 4000)}

` +
          'Проверь результат по коду (read_file по изменённым файлам, если нужно) и ответь пользователю: что сделано, что проверено, что осталось. ' +
          'Если что-то сделано неверно или не по брифу — скажи честно и конкретно, что не так. Без нового брифа.'
      }
    }
    await runAgent(reviewReq, deps)
  }

  return { ok: buildRes.ok, roles: ['author', 'builder', 'author'], brief }
}

/** A question: the author answers, no builder, no tools beyond reading. */
async function runAuthorOnly(req: RunRequest, deps: AgentDeps): Promise<TeamResult> {
  const res = await runAgent({ ...req, role: 'author', roleMode: 'split' }, deps)
  return { ok: res.ok, error: res.error, roles: ['author'] }
}

/** The assistant text of the last turn, for the pipeline's stage handoff. */
function lastAssistantText(req: RunRequest): string {
  return lastFinalText.get(req.runId) || ''
}

/** runAgent keeps its last prose here so runTeam can hand it to the next stage. */
const lastFinalText = new Map<string, string>()
