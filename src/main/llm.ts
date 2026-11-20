import type { ChatMessage, TokenUsage } from '../shared/types'
import { MODELS, modelOptions, wireModel } from '../shared/types'

export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmDelta {
  content?: string
  reasoning?: string
  /** arrival time of this chunk, stamped where it was parsed — not in the UI */
  reasoningAt?: number
  toolCalls?: { index: number; id?: string; name?: string; argumentsDelta?: string }[]
}

export interface LlmStreamResult {
  content: string
  reasoning: string
  toolCalls: LlmToolCall[]
  usage: TokenUsage
  finishReason: string | null
  /** raw prompt tokens reported by API */
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

/** OpenAI-style content blocks: text and images mixed in one user message. */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' } }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentPart[] | null
  reasoning_content?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

export interface LlmToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

export class LlmError extends Error {
  status?: number
  kind: 'auth' | 'rate' | 'balance' | 'network' | 'server' | 'bad-request' | 'aborted' | 'truncated'
  /** what the server told us to wait, in ms */
  retryAfterMs?: number
  constructor(message: string, kind: LlmError['kind'], status?: number, retryAfterMs?: number) {
    super(message)
    this.kind = kind
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export interface StreamArgs {
  apiKey: string
  baseUrl: string
  model: string
  messages: LlmMessage[]
  tools: LlmToolSchema[]
  temperature: number
  maxTokens: number
  signal: AbortSignal
  onDelta: (d: LlmDelta) => void
  onUsage?: (u: TokenUsage) => void
  /** called before a retry: the UI shows "reconnecting in 4s" instead of a dead run */
  onRetry?: (r: { attempt: number; max: number; waitMs: number; reason: string }) => void
  /** how much room the model gets to think before it answers (thinking models only) */
  effort?: import('../shared/types').ThoughtEffort
}

export function priceFor(model: string): { priceIn: number; priceInCached: number; priceOut: number; contextWindow: number; maxOutput: number } {
  const m = MODELS.find((x) => x.id === model)
  if (m) {
    return { priceIn: m.priceIn, priceInCached: m.priceInCached, priceOut: m.priceOut, contextWindow: m.contextWindow, maxOutput: m.maxOutput }
  }
  return { priceIn: 0.3, priceInCached: 0.006, priceOut: 1.2, contextWindow: 1_000_000, maxOutput: 384_000 }
}

/**
 * Peak or off-peak, from DeepSeek's published table: peak is 01:00-04:00 and
 * 06:00-10:00 UTC, Monday to Friday, excluding Chinese public holidays; every
 * other hour is half price. We do not try to model the holidays — being wrong by
 * 50% on a holiday is better than pretending the discount does not exist, which
 * is what the old flat "peak only" number did.
 */
export function isPeakHour(at: Date = new Date()): boolean {
  const day = at.getUTCDay() // 0 Sun … 6 Sat
  if (day === 0 || day === 6) return false
  const h = at.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

export function computeCost(
  model: string,
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
  at: Date = new Date()
): number {
  const p = priceFor(model)
  const k = isPeakHour(at) ? 1 : 0.5
  const fresh = Math.max(0, promptTokens - cachedTokens)
  return ((fresh / 1e6) * p.priceIn + (cachedTokens / 1e6) * p.priceInCached + (completionTokens / 1e6) * p.priceOut) * k
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 522, 524])

function normalizeBase(baseUrl: string): string {
  let b = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`
  // accept either https://api.deepseek.com or .../v1 or full endpoint
  if (b.endsWith('/chat/completions')) return b
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`
  return `${b}/chat/completions`
}

export async function testApiKey(apiKey: string, baseUrl: string): Promise<{ ok: boolean; message: string; models?: string[] }> {
  if (!apiKey.trim()) return { ok: false, message: 'API key is empty' }
  const endpoint = normalizeBase(baseUrl)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'reply with exactly: ok' }],
        max_tokens: 5,
        stream: false
      }),
      signal: AbortSignal.timeout(30000)
    })
    if (res.ok) {
      const json: any = await res.json().catch(() => null)
      const served = json?.model || 'deepseek-flash'
      return { ok: true, message: `Connected · ${served} · ${json?.usage?.total_tokens ?? '?'} tokens round-trip` }
    }
    const body = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Invalid API key (401). Check the key in Settings.' }
    if (res.status === 402) return { ok: false, message: 'Insufficient balance on the DeepSeek account (402).' }
    if (res.status === 404) return { ok: false, message: `Endpoint not found (404). Try ${baseUrl.replace(/\/$/, '')} or https://api.deepseek.com` }
    return { ok: false, message: `HTTP ${res.status}: ${body.slice(0, 200)}` }
  } catch (e: any) {
    return { ok: false, message: `Network error: ${e?.message || 'unknown'}` }
  }
}

/**
 * Stream a chat completion from an OpenAI-compatible endpoint (DeepSeek).
 * Handles SSE framing, partial JSON lines, reasoning_content and tool-call deltas.
 */
export async function streamChat(args: StreamArgs): Promise<LlmStreamResult> {
  const { apiKey, baseUrl, model, messages, tools, temperature, maxTokens, signal, onDelta, effort } = args
  const endpoint = normalizeBase(baseUrl)

  const body: Record<string, any> = {
    model: wireModel(model),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.max(256, Math.min(maxTokens || 16384, 384_000)),
    temperature,
    ...modelOptions(model, effort)
  }
  if (tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  let attempt = 0
  let lastErr: any = null
  const MAX_ATTEMPTS = 6

  while (attempt < MAX_ATTEMPTS) {
    attempt++
    try {
      return await runOnce({ endpoint, apiKey, body, signal, onDelta, model, onUsage: args.onUsage, attempt })
    } catch (e: any) {
      lastErr = e
      // permanent: retrying cannot help, and a run you walked away from should
      // stop with a clear reason instead of hammering the API
      if (e instanceof LlmError && (e.kind === 'aborted' || e.kind === 'auth' || e.kind === 'balance' || e.kind === 'bad-request')) {
        throw e
      }
      if (signal.aborted) throw new LlmError('Stopped by user', 'aborted')
      if (attempt >= MAX_ATTEMPTS) throw e
      // Anything else (network, 5xx, DNS, reset socket, dropped stream, 429) is
      // worth waiting out: that is the difference between losing a night of work
      // on step two and a run that just carries on.
      if (e instanceof LlmError && e.kind === 'truncated') {
        // no point waiting — same limit, same cut. Retry at once, on a shorter
        // leash, so the agent gets a complete turn to work with.
        body.max_tokens = Math.max(1024, Math.floor((body.max_tokens || 4096) * 0.75))
        args.onRetry?.({ attempt, max: MAX_ATTEMPTS, waitMs: 0, reason: 'ответ обрезался по лимиту токенов — прошу короче' })
        continue
      }
      const wait = retryDelay(e, attempt)
      args.onRetry?.({ attempt, max: MAX_ATTEMPTS, waitMs: wait, reason: describeRetry(e) })
      await sleepAbortable(wait, signal)
      if (signal.aborted) throw new LlmError('Stopped by user', 'aborted')
    }
  }
  throw lastErr
}

/** Backoff that a Stop press interrupts instead of waiting out. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Exponential backoff with jitter, honouring Retry-After when the server sends it. */
function retryDelay(e: any, attempt: number): number {
  const retryAfter = e instanceof LlmError ? e.retryAfterMs : undefined
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter, 60_000)
  const base = e instanceof LlmError && e.kind === 'rate' ? 5_000 : 1_500
  const wait = base * Math.pow(2, attempt - 1)
  return Math.min(60_000, wait) + Math.floor(Math.random() * 750)
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs) && secs > 0) return secs * 1000
  const when = Date.parse(header)
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  return undefined
}

function describeRetry(e: any): string {
  if (!(e instanceof LlmError)) return 'неизвестная ошибка'
  switch (e.kind) {
    case 'rate':
      return 'сервер просит подождать (429)'
    case 'network':
      return 'обрыв связи с API'
    default:
      return e.status ? `ответ сервера ${e.status}` : 'сбой запроса'
  }
}

async function runOnce(opts: {
  endpoint: string
  apiKey: string
  body: Record<string, any>
  signal: AbortSignal
  onDelta: (d: LlmDelta) => void
  onUsage?: (u: TokenUsage) => void
  model: string
  /** which attempt this is, used only to keep the wire fresh */
  attempt?: number
}): Promise<LlmStreamResult> {
  const { endpoint, apiKey, body, signal, onDelta, model } = opts
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (e: any) {
    if (signal.aborted) throw new LlmError('Stopped by user', 'aborted')
    throw new LlmError(`Network error: ${e?.message || e}`, 'network')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = text.slice(0, 600)
    try {
      const j = JSON.parse(text)
      msg = j?.error?.message || j?.message || msg
    } catch {
      /* plain text */
    }
    if (res.status === 401 || res.status === 403) throw new LlmError(`Authentication failed: ${msg}`, 'auth', res.status)
    if (res.status === 402) throw new LlmError(`Insufficient balance: ${msg}`, 'balance', res.status)
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
    if (res.status === 429) throw new LlmError(`Rate limited: ${msg}`, 'rate', res.status, retryAfter)
    if (res.status >= 500) throw new LlmError(`HTTP ${res.status}: ${msg}`, 'server', res.status, retryAfter)
    if (res.status === 400 || res.status === 422) {
      if (/model.*(not exist|not found|does not exist|retired|deprecated|invalid)/i.test(msg)) {
        throw new LlmError(
          `Model "${wireModel(body.model)}" is not available: ${msg}. DeepSeek retired deepseek-chat / deepseek-reasoner on 2026-07-24 — pick deepseek-flash in Settings → Model.`,
          'bad-request',
          res.status
        )
      }
      throw new LlmError(`Bad request: ${msg}`, 'bad-request', res.status)
    }
    throw new LlmError(`HTTP ${res.status}: ${msg}`, 'server', res.status, retryAfter)
  }
  if (!res.body) throw new LlmError('Empty response body', 'server')

  const reader = res.body.getReader()
  // If the server goes quiet for too long mid-stream, treat it as a dropped
  // connection and let the retry loop take over: a stalled socket is exactly the
  // "it died on step two while I was away" failure mode.
  let lastByte = Date.now()
  const stallTimer = setInterval(() => {
    if (Date.now() - lastByte > 150_000) {
      clearInterval(stallTimer)
      void reader.cancel().catch(() => {})
    }
  }, 5_000)
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  const toolAcc = new Map<number, LlmToolCall>()
  let finishReason: string | null = null
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let reasoningTokens = 0

  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.trim()
    if (!line) return true
    if (line.startsWith(':')) return true
    if (!line.startsWith('data:')) return true
    const data = line.slice(5).trim()
    if (data === '[DONE]') return false
    let json: any
    try {
      json = JSON.parse(data)
    } catch {
      return true
    }
    if (json.usage) {
      promptTokens = json.usage.prompt_tokens ?? promptTokens
      completionTokens = json.usage.completion_tokens ?? completionTokens
      cachedTokens = json.usage.prompt_cache_hit_tokens ?? json.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens
      reasoningTokens = json.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens
      if (opts.onUsage) {
        opts.onUsage({
          promptTokens,
          completionTokens,
          cachedTokens,
          reasoningTokens,
          cost: computeCost(model, promptTokens, cachedTokens, completionTokens)
        })
      }
    }
    const choice = json.choices?.[0]
    if (!choice) return true
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta || choice.message || {}
    const d: LlmDelta = {}
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content
      d.reasoning = delta.reasoning_content
      d.reasoningAt = Date.now()
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      d.content = delta.content
    }
    if (Array.isArray(delta.tool_calls)) {
      d.toolCalls = []
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const acc = toolAcc.get(idx) || { id: '', name: '', arguments: '' }
        if (tc.id) acc.id = tc.id
        if (tc.function?.name) acc.name = acc.name ? acc.name + tc.function.name : tc.function.name
        const argDelta = tc.function?.arguments || ''
        if (argDelta) acc.arguments += argDelta
        toolAcc.set(idx, acc)
        d.toolCalls.push({ index: idx, id: tc.id, name: tc.function?.name, argumentsDelta: argDelta })
      }
    }
    onDelta(d)
    return true
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      lastByte = Date.now()
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        handleLine(line)
      }
    }
    if (buffer.trim()) handleLine(buffer)
  } catch (e: any) {
    if (signal.aborted) throw new LlmError('Stopped by user', 'aborted')
    // A stream that died halfway used to be returned as if it were a complete
    // answer — with half a tool call in it, which the agent then executed and
    // broke everything downstream. Retry instead; the loop above will ask again.
    throw new LlmError(`Stream interrupted: ${e?.message || e}`, 'network')
  } finally {
    clearInterval(stallTimer)
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
  }

  // A reply cut off by the token limit is not an answer: half a tool call, or a
  // sentence with no end, which the agent then acts on. Ask again for a compact
  // version instead of pretending the turn was fine.
  if (finishReason === 'length' && (opts.attempt || 1) < 3) {
    throw new LlmError('Ответ оборвался по лимиту токенов', 'truncated')
  }

  const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({
      id: v.id || `call_${Date.now()}_${i}`,
      name: v.name,
      arguments: v.arguments || '{}'
    }))
    .filter((c) => c.name)

  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    cachedTokens,
    reasoningTokens,
    cost: computeCost(model, promptTokens, cachedTokens, completionTokens)
  }

  return { content, reasoning, toolCalls, usage, finishReason, promptTokens, completionTokens, cachedTokens }
}

/**
 * Rough token estimate used for the context meter and compaction decisions.
 * DeepSeek's tokenizer is ~3.6 chars/token for English + code.
 */
export function messageText(content: string | LlmContentPart[] | null | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.6)
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += 6
    if (m.content) total += estimateTokens(messageText(m.content))
    if (m.reasoning_content) total += estimateTokens(m.reasoning_content)
    if (m.tool_calls) total += m.tool_calls.reduce((a, c) => a + estimateTokens(c.function.arguments) + 8, 0)
  }
  return total
}

/** Convert stored chat messages into API messages, compacting old tool noise. */
export function toApiHistory(history: ChatMessage[], budget = 60000): LlmMessage[] {
  const out: LlmMessage[] = []
  for (const msg of history) {
    if (msg.role === 'system') continue
    if (msg.role === 'user') {
      let text = msg.content
      const images = (msg.attachments || []).filter((a) => a.kind === 'image' && a.content)
      const docs = (msg.attachments || []).filter((a) => a.kind !== 'image')
      if (docs.length) {
        const blocks = docs
          .map((a) => {
            const head = a.kind === 'selection' ? `### Selection from ${a.rel} (lines ${a.from}-${a.to})` : `### File: ${a.rel || a.name}`
            return `${head}\n\`\`\`\n${a.content.slice(0, 12000)}\n\`\`\``
          })
          .join('\n\n')
        text = `${text}\n\n${blocks}`
      }
      if (images.length) {
        const parts: LlmContentPart[] = images.map((a) => ({
          type: 'image_url',
          image_url: { url: a.content, detail: 'original' }
        }))
        if (text) parts.unshift({ type: 'text', text })
        out.push({ role: 'user', content: parts })
      } else {
        out.push({ role: 'user', content: text })
      }
    } else if (msg.role === 'assistant') {
      const toolCalls = (msg.tools || [])
        .filter((t) => t.status !== 'denied' && t.status !== 'aborted')
        .map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: JSON.stringify(t.args || {}) }
        }))
      out.push({
        role: 'assistant',
        content: msg.content || (toolCalls.length ? null : ''),
        tool_calls: toolCalls.length ? toolCalls : undefined
      } as LlmMessage)
      // Every id in `tool_calls` must get exactly one tool message, or the API
      // rejects the whole request with "insufficient tool messages following
      // tool_calls". Denied, aborted and still-running calls are answered too —
      // the model needs to hear that they did not happen, not nothing at all.
      for (const t of msg.tools || []) {
        const resultText =
          t.status === 'denied'
            ? 'The user DENIED this action. Do not retry it.'
            : t.status === 'aborted'
              ? 'Not executed: the run was stopped before this call.'
              : t.error && t.status === 'error'
                ? `ERROR: ${t.error}`
                : (t.output || (t.status === 'ok' ? 'ok' : t.status))
        out.push({ role: 'tool', tool_call_id: t.id, name: t.name, content: String(resultText).slice(0, 24000) })
      }
    }
  }
  // Budget the history by dropping the oldest whole turns. Cutting a single
  // message out of the middle can orphan a tool call, which is what the API
  // answered with "insufficient tool messages" — so a turn goes away as a unit,
  // and the trailing turn (context block + the actual ask) is never touched.
  let total = estimateMessagesTokens(out)
  while (out.length > 2 && total > budget) {
    // find the second user message: everything before it is one droppable chunk
    let cut = -1
    for (let i = 1; i < out.length - 1; i++) {
      if (out[i].role === 'user' && !String(messageText(out[i].content)).startsWith('<workspace_context>')) {
        cut = i
        break
      }
    }
    if (cut <= 0) break
    const dropped = out.splice(0, cut)
    total -= dropped.reduce((n, m) => n + estimateTokens(messageText(m.content)) + 8, 0)
  }
  return out
}

/**
 * One-shot, non-streaming completion. Used for side tasks where we want a
 * short answer and no tool loop: file descriptions, commit messages.
 */
export async function completeOnce(opts: {
  apiKey: string
  baseUrl: string
  model: string
  system: string
  user: string
  maxTokens?: number
  signal?: AbortSignal
}): Promise<string> {
  const endpoint = normalizeBase(opts.baseUrl)
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: wireModel(opts.model),
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user }
      ],
      stream: false,
      max_tokens: opts.maxTokens ?? 256,
      temperature: 0.2,
      ...modelOptions(opts.model)
    }),
    signal: opts.signal ?? AbortSignal.timeout(45_000)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json: any = await res.json()
  const content = json?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}
