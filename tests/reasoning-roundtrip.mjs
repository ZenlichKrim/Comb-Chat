/**
 * The thinking-mode contract.
 *
 * DeepSeek rejects a request whose assistant turns have lost their
 * `reasoning_content`:
 *   Bad request: The `reasoning_content` in the thinking mode must be passed
 *   back to the API.
 * That made every chat a dead thread after the first failure, because the app
 * rebuilt history from the transcript without the thoughts. This test keeps the
 * transcript -> API mapping honest: `npm test`.
 */
import assert from 'node:assert/strict'
import { toApiHistory } from '../src/main/llm.ts'

const msg = (over) => ({ id: 'm', role: 'assistant', content: '', createdAt: Date.now(), ...over })

// 1. a finished assistant turn carries its thoughts back
const api = toApiHistory([
  { id: 'u1', role: 'user', content: 'Сделай мод', createdAt: 1 },
  msg({ id: 'a1', content: 'Понял задачу.', reasoning: 'Думаю про погоду и болезни.' }),
  { id: 'u2', role: 'user', content: 'Продолжай', createdAt: 2 }
])
const assistant = api.find((m) => m.role === 'assistant')
assert.equal(
  assistant.reasoning_content,
  'Думаю про погоду и болезни.',
  'assistant turn must replay reasoning_content — without it the API answers "The reasoning_content in the thinking mode must be passed back to the API"'
)

// 2. a turn with no thoughts does not invent an empty field
const bare = toApiHistory([
  { id: 'u1', role: 'user', content: 'Привет', createdAt: 1 },
  msg({ id: 'a2', content: 'Привет.' })
]).find((m) => m.role === 'assistant')
assert.equal('reasoning_content' in bare, false, 'no reasoning means no field, not an empty string')

// 3. tool-call turns keep their thoughts too: that is exactly where the run died
const tc = toApiHistory([
  { id: 'u1', role: 'user', content: 'Сделай мод', createdAt: 1 },
  msg({
    id: 'a3',
    reasoning: 'Сначала прочитаю структуру.',
    tools: [{ id: 'c1', name: 'read_file', status: 'ok', args: { path: 'a.java' }, output: 'class A {}' }]
  })
]).find((m) => m.role === 'assistant')
assert.equal(tc.reasoning_content, 'Сначала прочитаю структуру.')
assert.ok(Array.isArray(tc.tool_calls) && tc.tool_calls.length === 1, 'tool_calls survive')

console.log('reasoning roundtrip: 3 checks passed')
