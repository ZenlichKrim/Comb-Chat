/**
 * A spent quota is not a busy minute.
 *
 * The screen the user sent back: five "Повторный запрос модели (n/5)" rows in a
 * row and then "Квота запросов исчерпана". DeepSeek answers 429 for both "slow
 * down a second" and "this key has no requests left", and the loop used to retry
 * both six times — spending the last of a dead key's budget to learn nothing.
 *
 * This test drives the real `streamChat` against a local endpoint:
 *  1. a quota 429 is fatal on the first answer, with kind 'quota';
 *  2. a plain 429 is still retried, and the run continues;
 *  3. after the retries the plain 429 does not become a quota error.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { streamChat, LlmError } from '../src/main/llm.ts'

let hits = 0
let answer = () => ({ status: 429, body: '{}' })
const server = http.createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    hits += 1
    const a = answer()
    if (a.status === 200) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'готово' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers || {}) })
    res.end(a.body)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const call = (onRetry) =>
  streamChat({
    apiKey: 'test',
    baseUrl,
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'привет' }],
    tools: [],
    temperature: 0,
    maxTokens: 512,
    signal: new AbortController().signal,
    onDelta: () => {},
    onRetry
  })

// 1. the exact body DeepSeek sends when the key has nothing left
hits = 0
const retries = []
answer = () => ({
  status: 429,
  body: JSON.stringify({ error: { message: 'Insufficient quota: you have exhausted your request quota for this key', type: 'insufficient_quota' } })
})
let failed = null
try {
  await call((r) => retries.push(r))
} catch (e) {
  failed = e
}
assert.ok(failed instanceof LlmError, 'a quota answer throws an LlmError')
assert.equal(failed.kind, 'quota', 'it is reported as a quota problem, not as rate limiting')
assert.equal(hits, 1, `a spent quota is asked once, not six times (asked ${hits})`)
assert.equal(retries.length, 0, 'and the user never sees "Повторный запрос модели" for it')

// 2. a busy server is still retried, and the run finishes
hits = 0
const waited = []
answer = () => (hits < 3 ? { status: 429, body: JSON.stringify({ error: { message: 'Rate limit reached, please slow down' } }) } : { status: 200 })
const result = await call((r) => waited.push(r))
assert.equal(result.content, 'готово', 'a temporary 429 is waited out')
assert.equal(hits, 3, 'and asked again')
assert.ok(waited.length >= 2, 'the UI was told about each wait')

// 3. Retry-After measured in minutes is a quota even without the word in the body
hits = 0
answer = () => ({ status: 429, body: '{}', headers: { 'retry-after': '900' } })
failed = null
try {
  await call()
} catch (e) {
  failed = e
}
assert.equal(failed?.kind, 'quota', 'a 15-minute Retry-After means the key is out, not that the server is busy')
assert.equal(hits, 1, 'and it is not retried')

server.close()
console.log('quota: 3 checks passed')
