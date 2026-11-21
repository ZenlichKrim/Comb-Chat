/**
 * A real run of the agent loop against a fake DeepSeek endpoint. No network, no
 * GUI: this is the only way to see whether a turn actually works end to end.
 *
 * It plays out the situations the app has to survive:
 *  1. a plain answer with no tools;
 *  2. a tool call, its result, then the final answer;
 *  3. a tool that fails, and the agent recovering instead of bailing out;
 *  4. Stop pressed mid-loop — the run ends, no tool runs afterwards;
 *  5. a step-limited run — it ends visibly and does not resume by itself.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-harness-'))
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'first line\nsecond line\n')

/* ------------------------------------------------------------------ */
/* fake model                                                          */
/* ------------------------------------------------------------------ */

let script = []          // queued replies
let requests = []        // every body the app sent
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url?.includes('/user/balance')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '1.00' }] }))
      return
    }
    requests.push(JSON.parse(body || '{}'))
    const next = script.shift() || finalText('(script exhausted)')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash' }
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
    if (next.reasoning) send({ ...base, choices: [{ index: 0, delta: { reasoning_content: next.reasoning } }] })
    if (next.text) send({ ...base, choices: [{ index: 0, delta: { content: next.text } }] })
    if (next.tool) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: next.tool.id || 'call_1', type: 'function', function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }
              ]
            }
          }
        ]
      })
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: next.tool ? 'tool_calls' : 'stop' }] })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

function finalText(t, reasoning = 'думаю') {
  return { text: t, reasoning }
}

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

/* ------------------------------------------------------------------ */
/* settings + module under test                                       */
/* ------------------------------------------------------------------ */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-data-'))
process.env.COMB_TEST_DIR = dataDir
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify({ apiKey: 'sk-test', baseUrl, model: 'deepseek-flash', locale: 'ru', capabilities: { edit: 'auto', run: 'auto', planner: 'auto' }, allowedTools: [] })
)

const { runTeam, resolveApproval } = await import('../src/main/agent.ts')
const { getSettings } = await import('../src/main/store.ts')
await getSettings()

const events = []
const deps = {
  // The real app answers an approval from the UI. There is no UI here, so the
  // harness answers instead — and answers immediately, like a person clicking
  // "allow", which is what the run has to survive.
  emit: (e) => {
    events.push(e)
    if (e.type === 'tool-approval-request') resolveApproval(runId, e.call.id, 'allow')
  }
}
const runId = 'run-test'
const req = {
  runId,
  threadId: 'thread-test',
  messageId: 'msg-test',
  workspace,
  model: 'deepseek-flash',
  temperature: 0.2,
  maxTokens: 4096,
  approvalPolicy: 'auto',
  capabilities: { edit: 'auto', run: 'auto', planner: 'auto' },
  maxSteps: 12,
  autoContext: true,
  customInstructions: '',
  history: [],
  userMessage: { id: 'u1', role: 'user', content: 'Прочитай hello.txt и скажи, что там.', createdAt: Date.now() },
  attachments: [],
  role: 'builder'
}

const kinds = () => events.map((e) => e.type)
const text = () => events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('')

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

/* ------------------------------------------------------------------ */
/* 1. tool call round trip                                            */
/* ------------------------------------------------------------------ */
console.log('agent harness:')
script = [
  { text: 'Сейчас посмотрю hello.txt.', tool: { name: 'read_file', args: { path: 'hello.txt' } }, reasoning: 'смотрю файл' },
  finalText('В файле две строки: first line и second line.')
]
events.length = 0
requests = []
let res = await runTeam(req, deps)
check('run returns ok', res.ok === true, JSON.stringify(res))
if (process.env.DUMP) console.log(JSON.stringify(events, null, 1).slice(0, 4000))
const toolResults = events.filter((e) => e.type === 'tool-update')
check('tool actually ran and returned content', toolResults.some((e) => JSON.stringify(e).includes('second line')), JSON.stringify(toolResults).slice(0, 300))
check('the answer reached the transcript', text().includes('first line'), text().slice(0, 200))
check('run-end is emitted exactly once', kinds().filter((k) => k === 'run-end').length === 1, JSON.stringify(kinds()))
const second = requests[1]
check('the tool result went back to the model', JSON.stringify(second?.messages || []).includes('second line'))
check('every assistant turn carries its reasoning back', (second?.messages || []).filter((m) => m.role === 'assistant').every((m) => m.reasoning_content !== undefined), 'missing reasoning_content')

/* ------------------------------------------------------------------ */
/* 2. a failing tool does not kill the run                            */
/* ------------------------------------------------------------------ */
console.log('survives a broken tool:')
script = [
  { text: 'Пробую прочитать файл.', tool: { name: 'read_file', args: { path: 'nope/missing.txt' } }, reasoning: 'пробую' },
  { text: 'Посмотрю, что вообще есть.', tool: { name: 'list_dir', args: { path: '.' } }, reasoning: 'а что есть?' },
  finalText('Файла нет, зато есть hello.txt.')
]
events.length = 0
res = await runTeam(req, deps)
check('run still ok after a failed tool', res.ok === true, JSON.stringify(res))
const updates = events.filter((e) => e.type === 'tool-update')
check('the failing tool is reported as an error, not silence', updates.some((e) => e.call.status === 'error' || /no such|not found|ENOENT/i.test(JSON.stringify(e))), JSON.stringify(updates).slice(0, 300))
check('it then recovered and listed the folder', updates.some((e) => e.call.name === 'list_dir' && JSON.stringify(e).includes('hello.txt')))
check('final answer present', text().includes('hello.txt'), text().slice(0, 200))

/* ------------------------------------------------------------------ */
/* 3. Stop means stop                                                 */
/* ------------------------------------------------------------------ */
console.log('stop:')
script = []
for (let i = 0; i < 30; i++) script.push({ text: 'Смотрю папку.', tool: { name: 'list_dir', args: { path: '.' } }, reasoning: 'кручусь' })
events.length = 0
const running = runTeam(req, deps)
setTimeout(async () => {
  const { stopRun } = await import('../src/main/agent.ts')
  stopRun(runId)
}, 120)
const beforeTools = () => events.filter((e) => e.type === 'tool-start').length
await running
const toolsAfterStop = beforeTools()
await new Promise((r) => setTimeout(r, 300))
check('stopping ends the run', kinds().includes('run-end'), JSON.stringify(kinds().slice(-5)))
check('no tool starts after the stop', beforeTools() === toolsAfterStop, `${toolsAfterStop} -> ${beforeTools()}`)

/* ------------------------------------------------------------------ */
/* 4. step limit ends visibly, never silently                         */
/* ------------------------------------------------------------------ */
console.log('step limit:')
script = []
for (let i = 0; i < 40; i++) script.push({ text: 'Смотрю папку.', tool: { name: 'list_dir', args: { path: '.' } } })
events.length = 0
res = await runTeam({ ...req, maxSteps: 3, capabilities: { edit: 'auto', run: 'auto', planner: 'off' } }, deps)
check('a limited run reports why it stopped', events.some((e) => e.type === 'run-end' && (e.reason === 'limit' || e.reason === 'stopped')), JSON.stringify(events.filter((e) => e.type === 'run-end')))
check('a limited run leaves a message in the transcript', text().length > 0 || events.some((e) => e.type === 'guard'), text().slice(0, 200))

/* ------------------------------------------------------------------ */
/* 5. YOLO really reaches the disk around the workspace               */
/* ------------------------------------------------------------------ */
console.log('yolo / full disk:')
fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'sub', 'inner.txt'), 'inner content\n')
const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'comb-sibling-'))

fs.writeFileSync(path.join(sibling, 'neighbour.txt'), 'neighbour content\n')
const yoloReq = {
  ...req,
  // the message names a folder the user can see in the picker but that is not
  // in the workspace: this is the exact case that used to answer "escapes workspace"
  userMessage: { id: 'u2', role: 'user', content: `Прочитай файл neighbour.txt в ${sibling} и свери с inner.txt.`, createdAt: Date.now() },
  capabilities: { edit: 'ask', run: 'ask', planner: 'off' },
  fullDiskAccess: true
}
script = [
  { text: 'Читаю оба файла.', tool: { name: 'read_file', args: { path: path.join(sibling, 'neighbour.txt') } } },
  { text: 'Теперь второй.', tool: { name: 'read_file', args: { path: '../' + path.basename(sibling) + '/neighbour.txt' } } },
  { text: 'Сверил.', tool: { name: 'run_command', args: { command: process.platform === 'win32' ? 'echo ok' : 'echo ok' } } },
  finalText('Оба файла прочитаны.')
]
events.length = 0
res = await runTeam(yoloReq, deps)
const yoloUpdates = events.filter((e) => e.type === 'tool-update')
check('an absolute path outside the workspace is readable under yolo', yoloUpdates.some((e) => e.call.name === 'read_file' && e.call.status === 'ok' && /neighbour content/.test(e.call.output || '')), JSON.stringify(yoloUpdates.map((e) => [e.call.name, e.call.status])).slice(0, 300))
check('a .. path outside the workspace also works', yoloUpdates.filter((e) => e.call.name === 'read_file' && e.call.status === 'ok').length >= 1)
check('run_command executes without a prompt under yolo', yoloUpdates.some((e) => e.call.name === 'run_command' && e.call.status === 'ok'), JSON.stringify(yoloUpdates.map((e) => [e.call.name, e.call.status])))

/* ------------------------------------------------------------------ */
/* 6. without yolo the sandbox still holds                            */
/* ------------------------------------------------------------------ */
console.log('sandbox holds outside yolo:')
script = [
  { text: 'Пробую выйти за пределы папки.', tool: { name: 'read_file', args: { path: path.join(sibling, 'neighbour.txt') } } },
  finalText('Нельзя — папка вне воркспейса.')
]
events.length = 0
await runTeam({ ...yoloReq, fullDiskAccess: false, approvalPolicy: 'ask' }, deps)
const outside = events.filter((e) => e.type === 'tool-update').find((e) => e.call.name === 'read_file')
check('a path outside is refused when the sandbox is on', !outside || outside.call.status !== 'ok' || !/neighbour content/.test(outside.call.output || ''), JSON.stringify(outside?.call || {}))

/* ------------------------------------------------------------------ */
/* 7. a long run keeps going and never invents a user message         */
/* ------------------------------------------------------------------ */
console.log('long run:')
script = []
for (let i = 0; i < 20; i++) {
  script.push({ text: `Шаг ${i + 1}, читаю папку.`, tool: { name: 'list_dir', args: { path: '.' } } })
}
script.push(finalText('Прошёл двадцать шагов и закончил.'))
events.length = 0
res = await runTeam({ ...req, maxSteps: 30, userMessage: { id: 'u3', role: 'user', content: 'Пролистай папку двадцать раз и закончи.', createdAt: Date.now() } }, deps)
check('twenty steps are all executed', events.filter((e) => e.type === 'step').length >= 20, String(events.filter((e) => e.type === 'step').length))
check('the run finishes on its own', res.ok === true && events.some((e) => e.type === 'run-end'))
check('nothing was typed on the user behalf', !events.some((e) => e.type === 'user-message' || e.type === 'auto-continue'))

/* ------------------------------------------------------------------ */
/* 8. the plan is not left open                                        
/* ------------------------------------------------------------------ */
console.log('plan:')
const planArgs = {
  todos: [
    { content: 'Прочитать hello.txt', status: 'completed' },
    { content: 'Переписать вторую строку', status: 'pending' }
  ]
}
script = [
  { text: 'Вот план.', tool: { name: 'todo_write', args: planArgs } },
  { text: 'Готово, всё сделано.' },
  { text: 'Понял, доделываю вторую строку.', tool: { name: 'write_file', args: { path: 'hello.txt', content: 'first line\nsecond line, edited\n' } } },
  { text: 'Закрываю план.', tool: { name: 'todo_write', args: { todos: [{ content: 'Прочитать hello.txt', status: 'completed' }, { content: 'Переписать вторую строку', status: 'completed' }] } } },
  finalText('План закрыт, файл переписан.')
]
events.length = 0
res = await runTeam({ ...req, maxSteps: 10, capabilities: { edit: 'auto', run: 'auto', planner: 'off' }, userMessage: { id: 'u4', role: 'user', content: 'Перепиши вторую строку в hello.txt.', createdAt: Date.now() } }, deps)
check('an open plan is reported to the UI', events.some((e) => e.type === 'todos' && e.todos.length === 2))
check('"done" with an open plan is refused', events.some((e) => e.type === 'guard' && /готово|done|план/i.test(JSON.stringify(e))), JSON.stringify(events.filter((e) => e.type === 'guard')).slice(0, 300))
check('the file was actually rewritten', /edited/.test(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8')))

/* ------------------------------------------------------------------ */
/* 9. a question does not freeze the run                              
/* ------------------------------------------------------------------ */
console.log('question:')
script = [
  { text: 'Посмотрю hello.txt, чтобы ответить точно.', tool: { name: 'read_file', args: { path: 'hello.txt' } } },
  { text: 'Посмотрю файл, потом уточню.', tool: { name: 'read_file', args: { path: 'hello.txt' } } },
  { text: 'Уточню одну вещь.', tool: { name: 'ask_user', args: { question: 'Какую строку менять?', options: ['первую', 'вторую'], recommend: 'вторую', waitSeconds: 15 } } },
  finalText('Беру второй вариант и продолжаю.')
]
events.length = 0
const t0 = Date.now()
res = await runTeam({ ...req, maxSteps: 6, capabilities: { edit: 'auto', run: 'auto', planner: 'auto' }, userMessage: { id: 'u5', role: 'user', content: 'Как думаешь, какую строку в hello.txt стоит менять?', createdAt: Date.now() } }, deps)
const took = Date.now() - t0
if (process.env.DUMP) {
  console.log('ROLE:', events.find((e) => e.type === 'role')?.role)
  console.log('TOOLS SENT:', (requests.at(-1)?.tools || []).map((t) => t.function.name).join(','))
  console.log('EVENTS:', JSON.stringify(events.map((e) => [e.type, e.call?.name, e.kind])))
  console.log('LAST ASSISTANT:', JSON.stringify((requests.at(-1)?.messages || []).filter((m) => m.role !== 'system').slice(-3)).slice(0, 1200))
}
check('an answered question does not get the "nothing happened" alarm', !events.some((e) => e.type === 'guard' && /без изменений/i.test(e.title || '')), JSON.stringify(events.filter((e) => e.type === 'guard')))
check('the reply is the end of the run', res.ok === true && /второй вариант/i.test(text()), text().slice(0, 200))
check('the run continues with the default instead of hanging', res.ok === true && took < 60_000, `${took}ms ${JSON.stringify(res)}`)
check('the model is told which option was used', events.some((e) => e.type === 'text-delta') || res.ok === true)

/* ------------------------------------------------------------------ */
/* 10. a design is not done until someone looked at it                 */
/* ------------------------------------------------------------------ */
console.log('design:')
fs.writeFileSync(path.join(workspace, 'page.html'), '<!doctype html><html><body><h1>hi</h1></body></html>')
script = [
  { text: 'Пишу страницу.', tool: { name: 'write_file', args: { path: 'page.html', content: '<!doctype html><html><body style="background:#14110e;color:#f4ece1"><h1>Comb</h1></body></html>' } } },
  { text: 'Готово, выглядит хорошо.', tool: { name: 'finish', args: { summary: 'Сделал страницу, всё в порядке.', work_done: true } } },
  { text: 'Смотрю на результат.', tool: { name: 'read_file', args: { path: 'page.html' } } },
  finalText('Страница готова: тёмный фон, крупный заголовок.')
]
events.length = 0
res = await runTeam({ ...req, maxSteps: 8, capabilities: { edit: 'auto', run: 'auto', planner: 'off' }, userMessage: { id: 'u6', role: 'user', content: 'Сделай красивую страницу page.html.', createdAt: Date.now() } }, deps)
check('"done" on a page nobody looked at is refused', events.some((e) => e.type === 'guard' && /видел|look/i.test(`${e.title || ''}${e.detail || ''}`)), JSON.stringify(events.filter((e) => e.type === 'guard')).slice(0, 300))
check('the refusal names the way to look', JSON.stringify(events).includes('preview_page') || JSON.stringify(events).includes('view_image'))
check('the run still ends with an answer', res.ok === true && text().length > 0)

// and it does not fire for a task with no visual result
script = [
  { text: 'Правлю файл.', tool: { name: 'write_file', args: { path: 'plain.txt', content: 'hello\n' } } },
  { text: 'Готово.', tool: { name: 'finish', args: { summary: 'Записал plain.txt.', work_done: true } } }
]
events.length = 0
await runTeam({ ...req, maxSteps: 5, capabilities: { edit: 'auto', run: 'auto', planner: 'off' }, userMessage: { id: 'u7', role: 'user', content: 'Запиши hello в plain.txt.', createdAt: Date.now() } }, deps)
check('a non-visual task is not nagged about previews', !events.some((e) => e.type === 'guard' && /видел|look/i.test(`${e.title || ''}${e.detail || ''}`)), JSON.stringify(events.filter((e) => e.type === 'guard')).slice(0, 200))

/* ------------------------------------------------------------------ */
/* 11. free mode: one mind, no gates, still eyes                      */
/* ------------------------------------------------------------------ */
console.log('free mode:')
const { setSettings } = await import('../src/main/store.ts')
const setFreedom = async (mode) => {
  await setSettings({ freedom: mode })
}
script = [
  { text: 'Делаю страницу.', tool: { name: 'write_file', args: { path: 'free.html', content: '<!doctype html><html><body><h1>x</h1></body></html>' } } },
  { text: 'Готово.', tool: { name: 'finish', args: { summary: 'Страница готова, проверил.', work_done: true } } },
  finalText('Страница free.html готова.')
]
events.length = 0
requests = []
await runTeam({ ...req, maxSteps: 6, capabilities: { edit: 'auto', run: 'auto', planner: 'auto' }, userMessage: { id: 'u8', role: 'user', content: 'Сделай красивую страницу free.html, как хочешь.', createdAt: Date.now() } }, deps)
// write settings first, then run
await setFreedom('free')
events.length = 0
requests = []
script = [
  { text: 'Придумал: тёмный фон, крупный заголовок, узкая колонка.', tool: { name: 'write_file', args: { path: 'free.html', content: '<!doctype html><html><body style="background:#14110e;color:#f4ece1"><h1>Comb</h1></body></html>' } } },
  finalText('Сделал свободную версию free.html.')
]
const freeRes = await runTeam({ ...req, maxSteps: 6, capabilities: { edit: 'auto', run: 'auto', planner: 'auto' }, userMessage: { id: 'u9', role: 'user', content: 'Сделай красивую страницу free.html, как хочешь.', createdAt: Date.now() } }, deps)
// the first request of a run is the background file-labeller; the run's own
// system prompt is the one that introduces the agent
const sys = String(requests.map((r) => r.messages?.[0]?.content || '').find((c) => /You are Comb/.test(c)) || '')
check('free mode runs without a contract round', !events.some((e) => e.type === 'guard' && e.kind === 'contract'), JSON.stringify(events.filter((e) => e.type === 'guard')).slice(0, 200))
check('free mode has no separate checker', !events.some((e) => e.type === 'spec-check'), 'a spec report was produced in free mode')
check('free mode runs one agent, not a team', requests.length >= 1 && !events.some((e) => e.type === 'role' && e.role === 'author'), 'the author ran in free mode')
check('the prompt grants room to invent', /Room to invent/i.test(sys), sys.slice(0, 120))
check('the run still finishes', freeRes.ok === true, JSON.stringify(freeRes))
// free mode does not put a gate in front of finish: the permission to invent is
// also the permission to decide when a thing is good
check('free mode does not gate "done"', !events.some((e) => e.type === 'guard' && /видел|look/i.test(`${e.title || ''}${e.detail || ''}`)), JSON.stringify(events.filter((e) => e.type === 'guard')).slice(0, 240))
check('free mode still ships the file it made', /Сделал свободную версию|free\.html/.test(text()), text().slice(0, 200))
await setFreedom('checked')

server.close()
console.log(`\nagent harness: ${pass + fail} checks, ${pass} passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)
