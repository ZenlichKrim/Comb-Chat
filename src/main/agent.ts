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
import { streamChat, toApiHistory, type LlmMessage } from './llm'
import { TOOL_SCHEMAS, executeTool, toolNeedsApproval, previewTool, type ToolContext } from './tools'
import { IGNORED_DIRS, toRel } from './fsops'
import { getSettings, saveCheckpoint } from './store'

export interface AgentDeps {
  emit: (e: AgentEvent) => void
  requestApproval: (runId: string, call: ToolResultView) => Promise<'allow' | 'allow-always' | 'deny'>
}

interface ActiveRun {
  controller: AbortController
  approvals: Map<string, (d: 'allow' | 'allow-always' | 'deny') => void>
  autoApproved: Set<string>
}

const active = new Map<string, ActiveRun>()

export function stopRun(runId: string): void {
  const run = active.get(runId)
  if (run) {
    for (const [, fn] of run.approvals) fn('deny')
    run.approvals.clear()
    run.controller.abort()
  }
}

export function resolveApproval(runId: string, callId: string, decision: 'allow' | 'allow-always' | 'deny'): void {
  const run = active.get(runId)
  if (!run) return
  if (decision === 'allow-always') run.autoApproved.add(callId.split(':')[0])
  const fn = run.approvals.get(callId)
  if (fn) {
    run.approvals.delete(callId)
    fn(decision)
  }
}

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

function systemPrompt(opts: {
  workspace: string | null
  platform: string
  shell: string
  now: string
  approvalPolicy: string
  custom: string
  contextFiles: string[]
}): string {
  const toolsGuide = opts.workspace
    ? `
# Tools
You have direct read/write access to the user's project at \`${opts.workspace}\`. All paths you pass to tools are relative to that root.
- Explore before you edit: \`list_dir\`, \`glob\`, \`grep\`, \`read_file\`. Never guess file contents.
- Change code with \`edit_file\` (exact string replacement). Include enough context lines so the match is unique. Use \`write_file\` only for new files or full rewrites.
- Verify your work: run the project's type checker, tests or linter with \`run_command\` when they exist. Read package.json / Makefile / pyproject.toml first to learn the right commands.
- \`run_command\` is non-interactive: no vim, no prompts, no servers that never exit (background them or skip).
- Use \`todo_write\` for anything with more than 2 steps, and keep it current.`
    : `
# No workspace open
The user has not opened a folder. You cannot read or write files. Answer questions, explain code, design architecture — and tell them to open a workspace (⌘/Ctrl+O) when they need edits.`

  return `You are Comb, a precise and senior software engineering agent running inside a desktop IDE called Comb Chat. You work directly on the user's machine.

# Environment
- Platform: ${opts.platform}
- Shell: ${opts.shell}
- Date: ${opts.now}
- Approval policy: ${opts.approvalPolicy}${opts.workspace ? `\n- Workspace: ${opts.workspace}` : ''}
${toolsGuide}
${opts.contextFiles.length ? `\n# Files the user is looking at\n${opts.contextFiles.map((f) => `- ${f}`).join('\n')}` : ''}

# How you work
- Act, don't narrate. Make the change instead of describing what you would change. Only ask questions when a real fork in the road blocks you.
- Match the existing code style exactly: indentation, quotes, naming, error handling, comment density. Read neighbouring files first.
- Keep diffs minimal. Do not reformat, rename or "improve" unrelated code. Never delete functionality you were not asked to touch.
- Keep replies short and dense. Use markdown, code blocks with a language tag, and file references like \`src/app.ts:42\`. No emoji unless the user uses them first.
- If a tool fails, read the error, fix the cause, try once more — do not repeat the identical failing call.
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

  const run: ActiveRun = { controller: new AbortController(), approvals: new Map(), autoApproved: new Set() }
  active.set(req.runId, run)
  const { signal } = run.controller

  const touched = new Set<string>()
  const beforeState = new Map<string, string | null>()
  let todos: TodoItem[] = []
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0 }
  const checkpoints: Checkpoint[] = []

  let approvalPolicy = req.approvalPolicy
  const ctx: ToolContext = {
    workspace: req.workspace || '',
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
      const id = `${call.name}:${call.id}`
      if (run.autoApproved.has(call.name)) return 'allow'
      deps.emit({ type: 'tool-approval-request', runId: req.runId, call })
      const prevPolicy = approvalPolicy
      approvalPolicy = prevPolicy
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          run.approvals.delete(call.id)
          resolve('deny')
        }, 15 * 60 * 1000)
        run.approvals.set(call.id, (d) => {
          clearTimeout(timer)
          if (d === 'allow-always') run.autoApproved.add(call.name)
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
    } catch {
      /* ignore context failures */
    }
  }

  const sys = systemPrompt({
    workspace: req.workspace,
    platform: `${process.platform} ${process.arch}`,
    shell: settings.shell || (process.platform === 'win32' ? 'PowerShell / cmd' : process.env.SHELL || '/bin/bash'),
    now: new Date().toISOString(),
    approvalPolicy: req.approvalPolicy,
    custom: req.customInstructions || settings.customInstructions || '',
    contextFiles: (req.openFiles || []).map((f) => f.rel)
  })

  const history: LlmMessage[] = [{ role: 'system', content: sys }]
  const prior = toApiHistory(req.history, 70000)
  history.push(...prior)
  history.push({ role: 'user', content: buildUserContent(req.userMessage, req.attachments) })
  if (contextBlock) {
    // insert workspace context as a system-ish user message right before the ask
    history.splice(history.length - 1, 0, { role: 'user', content: `<workspace_context>\n${contextBlock}\n</workspace_context>` })
    history.splice(history.length - 1, 0, { role: 'assistant', content: 'Workspace context loaded.' })
  }

  const disabled = new Set(req.disabledTools || [])
  const tools = req.workspace ? TOOL_SCHEMAS.filter((t) => !disabled.has(t.function.name)) : []

  deps.emit({ type: 'run-start', runId: req.runId, threadId: req.threadId, messageId: req.messageId })

  let step = 0
  let finalReason: 'done' | 'stopped' | 'error' | 'limit' = 'done'

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

      if (!result.toolCalls.length) {
        // no more tools: if the message is empty and we have budget, nudge once
        if (!result.content.trim() && step < 3) {
          history.push({ role: 'user', content: 'Continue — and call finish when the task is complete.' })
          continue
        }
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

        const needsApproval = req.workspace && toolNeedsApproval(call.name, approvalPolicy)
        if (needsApproval) {
          view.status = 'awaiting-approval'
          if (req.workspace && (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'multi_edit')) {
            view.diff = await previewTool(call.name, args, req.workspace)
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
        const outcome = await executeTool(call.name, args, { ...ctx, workspace: req.workspace || '' })
        const finished: ToolResultView = {
          ...view,
          status: outcome.ok ? 'ok' : 'error',
          output: outcome.output,
          error: outcome.error,
          diff: outcome.diff,
          durationMs: Date.now() - t0
        }
        deps.emit({ type: 'tool-update', runId: req.runId, call: finished })

        if (outcome.diff?.length) {
          deps.emit({ type: 'files-changed', runId: req.runId, paths: outcome.diff.map((d) => d.path) })
        }

        const toolContent = outcome.ok
          ? String(outcome.output ?? 'ok')
          : `ERROR: ${outcome.error || 'tool failed'}${outcome.output ? `\n${outcome.output}` : ''}`
        history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: toolContent.slice(0, 30000) })

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
        finalReason = 'done'
        break
      }
      if (halted === 'error') {
        finalReason = 'error'
        break
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
  } catch (e: any) {
    if (signal.aborted) {
      finalReason = 'stopped'
    } else {
      finalReason = 'error'
      deps.emit({ type: 'error', runId: req.runId, message: e?.message || String(e) })
    }
  } finally {
    active.delete(req.runId)
    deps.emit({ type: 'usage', runId: req.runId, usage })
    deps.emit({ type: 'run-end', runId: req.runId, reason: finalReason })
  }

  return { ok: true }
}

function buildUserContent(msg: ChatMessage, attachments: Attachment[]): string {
  let text = msg.content || ''
  if (!attachments.length) return text
  const blocks = attachments
    .map((a) => {
      if (a.kind === 'selection') {
        return `<selection path="${a.rel}" lines="${a.from}-${a.to}">\n${a.content}\n</selection>`
      }
      if (a.kind === 'image') {
        return `<image name="${a.name}" />`
      }
      return `<file path="${a.rel || a.name}">\n${a.content}\n</file>`
    })
    .join('\n\n')
  return `${text}\n\n${blocks}`
}

export function listActiveRuns(): string[] {
  return [...active.keys()]
}
