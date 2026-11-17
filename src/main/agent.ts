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
import { TOOL_SCHEMAS, executeTool, toolNeedsApproval, previewTool, type ToolContext } from './tools'
import { describeInBackground } from './describe'

/** never spend a request describing media, bundles or lockfiles */
const SKIP_DESCRIBE = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp3|mp4|zip|tar|gz|7z|dmg|exe|dll|so|dylib|pdf|apk|jar)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i
import { IGNORED_DIRS, toRel } from './fsops'
import { getSettings, saveCheckpoint, setSettings } from './store'

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
- Change code with \`edit_file\` (exact string replacement). Include enough context lines so the match is unique. Use \`write_file\` only for new files or full rewrites.
- Verify your work: run the project's type checker, tests or linter with \`run_command\` when they exist. Read package.json / Makefile / pyproject.toml first to learn the right commands.
- \`run_command\` is non-interactive: no vim, no prompts, no servers that never exit (background them or skip).
- You have network access through \`run_command\`: \`curl\`/\`wget\`/\`git clone\`/package managers all work. When the task needs an asset (an icon, a font, a package, a repo) download it into the project and verify the bytes landed (size, format) instead of asking the user to do it.
- The model accepts images: if the user attached a screenshot, read it and act on what it shows.
- Use \`todo_write\` for anything with more than 2 steps, and keep it current.`
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
- Never go silent in the same turn as a tool call. Silence is the most common complaint about agents: a wall of file diffs and no idea what you were thinking.
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

export async function runAgent(req: RunRequest, deps: AgentDeps): Promise<{ ok: boolean; error?: string }> {
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

  let approvalPolicy = req.approvalPolicy
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
      todos = t
      deps.emit({ type: 'todos', runId: req.runId, todos: t })
    },
    approvalPolicy,
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

  const sys = systemPrompt({
    workspace: req.workspace,
    roots,
    platform: `${process.platform} ${process.arch}`,
    shell: settings.shell || (process.platform === 'win32' ? 'PowerShell / cmd' : process.env.SHELL || '/bin/bash'),
    now: new Date().toISOString(),
    approvalPolicy: req.approvalPolicy,
    fullDisk,
    custom: req.customInstructions || settings.customInstructions || '',
    contextFiles: (req.openFiles || []).map((f) => f.rel),
    locale: settings.locale || 'en'
  })

  // A last-line reminder in the user turn itself: models drift back to English
  // in long runs when every tool output is English.
  const langNote = settings.locale === 'ru' ? '\n\n(Отвечай по-русски.)' : ''
  const history: LlmMessage[] = [{ role: 'system', content: sys }]
  const prior = toApiHistory(req.history, 70000)
  history.push(...prior)
  history.push({ role: 'user', content: buildUserContent(req.userMessage, req.attachments) + langNote })
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
  const tools = req.workspace || fullDisk ? TOOL_SCHEMAS.filter((t) => !disabled.has(t.function.name)) : []

  deps.emit({ type: 'run-start', runId: req.runId, threadId: req.threadId, messageId: req.messageId })

  let step = 0
  let finalReason: 'done' | 'stopped' | 'error' | 'limit' | 'guard' = 'done'

  /* --- stable-mode state ------------------------------------------------ */
  // Stability is the baseline of this build, not a switch at the bottom of the
  // composer: the guards below run unless someone explicitly opts out.
  const stableMode = req.mode ? req.mode === 'stable' : settings.stableMode !== false
  const costCap = stableMode ? Math.max(0, req.costCap ?? 0) : 0
  // "make sure the first steps are solid": collect what went wrong before deciding
  const errorsSoFar: { step: number; name: string; error: string }[] = []
  const callCounts = new Map<string, number>()
  let verifyStage: 'pending' | 'running' | 'done' | 'failed' = 'pending'
  let notifiedCost = false
  let notifiedStuck = false
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
  const narrate = (): void => {
    history.push({
      role: 'user',
      content:
        `[no words, step ${step}] You went straight to tool calls and said nothing to the user. ` +
        'They are watching the transcript and cannot read your mind.\n' +
        'Say whatever is on your mind — your read on the code you just saw, what you think of the approach, what surprised you, where this could go — and then continue. ' +
        'Your own words, whatever length the thought needs: a line if it is a line, a paragraph if there is something to say. ' +
        'Do not write a status report of the plan; nobody needs the steps repeated back.'
    })
  }

  /** desktop ping, rate-limited so a long run does not become a notification mill */
  const notify = (title: string, body: string, urgent = false): void => {
    if (settings.notifyDesktop === false) return
    if (!urgent && notifyCount >= 3) return
    notifyCount++
    deps.emit({ type: 'notify', runId: req.runId, title, body, urgent })
  }

  try {
    while (step < Math.max(1, req.maxSteps)) {
      step++
      deps.emit({ type: 'step', runId: req.runId, step })
      if (signal.aborted) {
        finalReason = 'stopped'
        break
      }

      const result = await streamChat({
        apiKey: settings.apiKey.trim(),
        baseUrl: settings.baseUrl,
        model: req.model,
        messages: history,
        tools: tools as any,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal,
        onDelta: (d) => {
          if (d.reasoning) deps.emit({ type: 'reasoning-delta', runId: req.runId, text: d.reasoning })
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

      // record assistant turn
      const assistantMsg: LlmMessage = {
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.length
          ? result.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } }))
          : undefined
      }
      history.push(assistantMsg)

      // A turn that fires tools without a single word of prose reads as a black
      // box: the user sees files being edited and no idea why. Ask for the
      // missing sentence instead of accepting the silence — a few times per run,
      // so the fix does not turn into a ping-pong of round trips.
      const bookkeeping = new Set(['todo_write', 'finish', 'suggest', 'notify_user', 'leave_note', 'attach_file'])
      const realCalls = result.toolCalls.filter((c) => !bookkeeping.has(c.name)).length > 0
      if (!result.content.trim() && realCalls && nudges < MAX_NUDGES) {
        nudges++
        narrate()
        continue
      }

      if (!result.toolCalls.length) {
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
          voteWait = new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => {
              run.votes.delete(call.id)
              resolve(null)
            }, Math.max(15, Number(args.waitSeconds) || 90) * 1000)
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
          // The same call failing twice means the model is guessing: stop before it
          // burns the whole budget going in circles.
          if (seen >= 3 && !outcome.ok && !notifiedStuck) {
            notifiedStuck = true
            deps.emit({
              type: 'guard',
              runId: req.runId,
              kind: 'stuck',
              title: 'Остановился: один и тот же вызов повторяется',
              detail: `${call.name} · ${outcome.error || 'failed'}`
            })
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

        const toolContent = outcome.ok
          ? String(outcome.output ?? 'ok')
          : `ERROR: ${outcome.error || 'tool failed'}${outcome.output ? `\n${outcome.output}` : ''}`
        history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toolContent.slice(0, 30000) })

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

        if (outcome.halt) {
          halted = outcome.halt
          break
        }
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
        if (stableMode) verifyStage = 'done'
        finalReason = 'done'
        break
      }
      if (halted === 'error') {
        finalReason = 'error'
        break
      }

      if (stableMode) {
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
        if (notifiedStuck) {
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
      deps.emit({ type: 'error', runId: req.runId, message: e?.message || String(e) })
    }
  } finally {
    // How did it end, in one line the user can read from across the room.
    if (finalReason === 'done' && touched.size) {
      deps.emit({
        type: 'guard',
        runId: req.runId,
        kind: 'done',
        title: `файлов — ${touched.size}, шагов — ${step}, $${usage.cost.toFixed(4)}`,
        detail: verifyStage === 'done' ? 'Результат проверен перед тем, как сказать «готово».' : undefined
      })
      notify('Задача выполнена', `${touched.size} файл(ов) изменено, ${step} шагов, $${usage.cost.toFixed(4)}`)
    } else if (finalReason === 'guard') {
      notify('Прогон остановлен защитой', 'Смотрите карточку в приложении — там причина.', true)
    } else if (finalReason === 'error') {
      notify('Прогон упал с ошибкой', 'Смотрите карточку в приложении.', true)
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

  return { ok: true }
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
