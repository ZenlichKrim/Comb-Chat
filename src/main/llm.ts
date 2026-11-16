import type { ChatMessage, TokenUsage } from '../shared/types'
import { MODELS } from '../shared/types'

export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmDelta {
  content?: string
  reasoning?: string
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

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
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
  kind: 'auth' | 'rate' | 'balance' | 'network' | 'server' | 'bad-request' | 'aborted'
  constructor(message: string, kind: LlmError['kind'], status?: number) {
    super(message)
    this.kind = kind
    this.status = status
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
}

export function priceFor(model: string): { priceIn: number; priceInCached: number; priceOut: number; contextWindow: number; maxOutput: number } {
  const m = MODELS.find((x) => x.id === model)
  if (m) {
    return { priceIn: m.priceIn, priceInCached: m.priceInCached, priceOut: m.priceOut, contextWindow: m.contextWindow, maxOutput: m.maxOutput }
  }
  return { priceIn: 0.28, priceInCached: 0.028, priceOut: 0.42, contextWindow: 131072, maxOutput: 8192 }
}

export function computeCost(model: string, promptTokens: number, cachedTokens: number, completionTokens: number): number {
  const p = priceFor(model)
  const fresh = Math.max(0, promptTokens - cachedTokens)
  return (fresh / 1e6) * p.priceIn + (cachedTokens / 1e6) * p.priceInCached + (completionTokens / 1e6) * p.priceOut
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
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'reply with exactly: ok' }],
        max_tokens: 5,
        stream: false
      }),
      signal: AbortSignal.timeout(30000)
    })
    if (res.ok) {
      const json: any = await res.json().catch(() => null)
      const served = json?.model || 'deepseek-chat'
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
  const { apiKey, baseUrl, model, messages, tools, temperature, maxTokens, signal, onDelta } = args
  const endpoint = normalizeBase(baseUrl)

  const body: Record<string, any> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.max(256, Math.min(maxTokens || 8192, 65536)),
    temperature
  }
  if (tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  let attempt = 0
  let lastErr: any = null

  while (attempt < 3) {
    attempt++
    try {
      return await runOnce({ endpoint, apiKey, body, signal, onDelta, model, onUsage: args.onUsage })
    } catch (e: any) {
      lastErr = e
      if (e instanceof LlmError && (e.kind === 'aborted' || e.kind === 'auth' || e.kind === 'balance' || e.kind === 'bad-request')) throw e
      if (e instanceof LlmError && e.status && !RETRYABLE.has(e.status)) throw e
      if (signal.aborted) throw new LlmError('Stopped by user', 'aborted')
      if (attempt >= 3) throw e
      await new Promise((r) => setTimeout(r, 700 * attempt * attempt))
    }
  }
  throw lastErr
}

async function runOnce(opts: {
  endpoint: string
  apiKey: string
  body: Record<string, any>
  signal: AbortSignal
  onDelta: (d: LlmDelta) => void
  onUsage?: (u: TokenUsage) => void
  model: string
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
    if (res.status === 429) throw new LlmError(`Rate limited: ${msg}`, 'rate', res.status)
    if (res.status === 400 || res.status === 422) throw new LlmError(`Bad request: ${msg}`, 'bad-request', res.status)
    throw new LlmError(`HTTP ${res.status}: ${msg}`, 'server', res.status)
  }
  if (!res.body) throw new LlmError('Empty response body', 'server')

  const reader = res.body.getReader()
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
    if (content || reasoning) {
      /* partial stream: return what we have */
    } else {
      throw new LlmError(`Stream interrupted: ${e?.message || e}`, 'network')
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
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
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.6)
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += 6
    if (m.content) total += estimateTokens(m.content)
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
      if (msg.attachments?.length) {
        const blocks = msg.attachments
          .map((a) => {
            const head = a.kind === 'selection' ? `### Selection from ${a.rel} (lines ${a.from}-${a.to})` : `### File: ${a.rel || a.name}`
            return `${head}\n\`\`\`\n${a.content.slice(0, 12000)}\n\`\`\``
          })
          .join('\n\n')
        text = `${text}\n\n${blocks}`
      }
      out.push({ role: 'user', content: text })
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
      for (const t of msg.tools || []) {
        if (t.status === 'denied' || t.status === 'aborted') continue
        const resultText =
          t.error && t.status === 'error'
            ? `ERROR: ${t.error}`
            : (t.output || (t.status === 'ok' ? 'ok' : t.status))
        out.push({ role: 'tool', tool_call_id: t.id, name: t.name, content: String(resultText).slice(0, 24000) })
      }
    }
  }
  // Budget the history by dropping oldest entries (but never the last user turn)
  let total = estimateMessagesTokens(out)
  if (total > budget) {
    // drop from the front, keeping pairs, until we fit
    while (out.length > 2 && total > budget) {
      const removed = out.shift()
      total -= estimateTokens(removed?.content || '') + 8
    }
  }
  return out
}
