/**
 * Local models: the "no key, no quota, no bill" path.
 *
 * The user asked whether the app could download DeepSeek Flash and stop paying.
 * The weights are not public — but a model on the user's own disk behind an
 * OpenAI-compatible server is exactly what they want, and it must actually work:
 *
 *  1. the app can list what a local server has pulled (`/v1/models`, no key);
 *  2. a run against that server sends no key, no `thinking` field and no
 *     DeepSeek-only request shape — Ollama answers 400 to all of that;
 *  3. a streamed answer arrives, tools included, and costs $0 — not "DeepSeek
 *     price" mislabelled as free;
 *  4. the agent loop really completes a task against a local model (no cloud).
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* a server that behaves like Ollama: /v1/models, /v1/chat/completions, no key */
const bodies = []
const headers = []
let script = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url?.endsWith('/v1/models') || req.url?.endsWith('/models')) {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5-coder:14b' }, { id: 'qwen3:8b' }] }))
        return
      }
    }
    bodies.push(JSON.parse(body || '{}'))
    headers.push(req.headers)
    scriptPush(req, res)
  })
})

function scriptPush(req, res) {
  const next = script.shift() || { text: 'готово' }
  if (next.status && next.status !== 200) {
    res.writeHead(next.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(next.body || {}))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
  const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'qwen2.5-coder:14b' }
  send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
  if (next.text) send({ ...base, choices: [{ index: 0, delta: { content: next.text } }] })
  if (next.tool) {
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }
            ]
          }
        }
      ]
    })
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: next.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })
  res.write('data: [DONE]\n\n')
  res.end()
}

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

const { streamChat, listModels } = await import('../src/main/llm.ts')

console.log('local models:')

/* 1. what the server has ------------------------------------------- */
const models = await listModels('', baseUrl)
check('a local server lists its models without a key', models.includes('qwen2.5-coder:14b') && models.includes('qwen3:8b'), JSON.stringify(models))

/* 2. a stream, and what we actually send --------------------------- */
bodies.length = 0
headers.length = 0
const res = await streamChat({
  apiKey: '',
  baseUrl,
  model: 'qwen2.5-coder:14b',
  messages: [{ role: 'user', content: 'привет' }],
  tools: [],
  temperature: 0.2,
  maxTokens: 512,
  signal: new AbortController().signal,
  onDelta: () => {},
  local: true
})
check('a local model answers', res.content === 'готово', JSON.stringify(res.content))
check('no key is sent to a local server', !headers[0]?.authorization, String(headers[0]?.authorization))
check('no DeepSeek "thinking" field is sent', !('thinking' in bodies[0]), JSON.stringify(Object.keys(bodies[0] || {})))
check('the model name goes over the wire unchanged', bodies[0]?.model === 'qwen2.5-coder:14b', bodies[0]?.model)
check('streaming is still asked for', bodies[0]?.stream === true)
check('a local run costs nothing', res.usage.cost === 0, JSON.stringify(res.usage))

/* 3. the cloud path is unchanged: it still sends the thinking budget - */
bodies.length = 0
script = [{ text: 'ok' }]
await streamChat({
  apiKey: 'sk-test',
  baseUrl,
  model: 'deepseek-flash-thinking',
  messages: [{ role: 'user', content: 'привет' }],
  tools: [],
  temperature: 0.2,
  maxTokens: 512,
  signal: new AbortController().signal,
  onDelta: () => {}
})
check('the cloud path keeps its thinking budget', !!bodies[0]?.thinking, JSON.stringify(bodies[0]?.thinking))

/* 4. a whole agent run against the local server --------------------- */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-local-'))
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'first line\n')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-local-data-'))
process.env.COMB_TEST_DIR = dataDir
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify({
    apiKey: '',
    provider: 'local',
    baseUrl,
    model: 'qwen2.5-coder:14b',
    customModels: [{ id: 'qwen2.5-coder:14b', label: 'qwen2.5-coder:14b', contextWindow: 32768, reasoning: false }],
    locale: 'ru',
    capabilities: { edit: 'auto', run: 'auto' },
    maxAgentSteps: 6
  })
)
const { runTeam } = await import('../src/main/agent.ts')
const events = []
const requestStarts = bodies.length
script = [
  { text: 'Читаю файл.', tool: { name: 'read_file', args: { path: 'hello.txt' } } },
  { text: 'Файл прочитан: одна строка first line.' }
]
const out = await runTeam(
  {
    runId: 'run-local',
    threadId: 'thread-local',
    messageId: 'm1',
    workspace,
    model: 'qwen2.5-coder:14b',
    temperature: 0.2,
    maxTokens: 4096,
    approvalPolicy: 'auto',
    capabilities: { edit: 'auto', run: 'auto' },
    maxSteps: 6,
    autoContext: true,
    customInstructions: '',
    history: [],
    userMessage: { id: 'u1', role: 'user', content: 'Прочитай hello.txt и скажи, что там.', createdAt: Date.now() },
    attachments: []
  },
  { emit: (e) => events.push(e) }
)
const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('')
check('a run with no API key starts and finishes on a local model', out.ok === true, JSON.stringify(out))
check('the tool actually ran', events.some((e) => e.type === 'tool-update' && /first line/.test(JSON.stringify(e))))
check('the answer reached the transcript', text.includes('first line'), text.slice(0, 120))
check('no cloud model was routed in behind the user\'s back', bodies.slice(requestStarts).every((b) => b.model === 'qwen2.5-coder:14b'), JSON.stringify(bodies.slice(requestStarts).map((b) => b.model)))
check('every request in the run carried no key', headers.slice(-2).every((h) => !h.authorization))
check('the run reported zero cost', events.filter((e) => e.type === 'usage').every((e) => e.usage.cost === 0))

server.close()
console.log(`\nlocal models: ${pass + fail} checks, ${pass} passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)
