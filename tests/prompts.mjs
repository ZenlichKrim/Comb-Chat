/**
 * The prompts must not carry one domain's vocabulary.
 *
 * A run once behaved like everything was a Minecraft mod, and the cause was in
 * the prompt: `мод` was the first word of the "visual" pattern and the example of
 * how to narrate a step was "размечаю реестр предметов". The model read its own
 * instructions as a hint about what it was being asked for. This test keeps any
 * one domain from creeping back in.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const files = ['src/main/roles.ts', 'src/main/agent.ts', 'src/main/spec.ts', 'src/main/tools.ts']

const BANNED = [
  { re: /реестр предметов/i, why: 'the old builder narration example' },
  { re: /собираю jar через gradle/i, why: 'the old builder narration example' },
  { re: /полноценный мод/i, why: 'the old spec-review example' },
  { re: /\bмод(а|у|ом|е|ы|ов)?\b/i, why: 'one domain named in a general prompt' },
  { re: /minecraft/i, why: 'the app is not a Minecraft tool' }
]

let pass = 0
let fail = 0
console.log('prompts:')
for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  for (const { re, why } of BANNED) {
    // comments are allowed to explain the history, code is not
    const offending = text
      .split('\n')
      .map((line, i) => ({ line, i: i + 1 }))
      .filter(({ line }) => re.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
    const ok = offending.length === 0
    if (ok) pass++
    else fail++
    if (!ok) console.log(`  FAIL ${rel}: ${why} — line ${offending[0].i}: ${offending[0].line.trim().slice(0, 90)}`)
  }
}
if (!fail) console.log(`  ok   no domain vocabulary in ${files.length} prompt files (${pass} checks)`)

// and the prompt itself has to say the quiet part: any stack is the job
const agent = fs.readFileSync(path.join(root, 'src/main/agent.ts'), 'utf8')
const generic = /software engineering agent/i.test(agent)
if (generic) pass++
else fail++
console.log(generic ? '  ok   the system prompt describes a general coding agent' : '  FAIL the system prompt lost its general framing')

console.log(`\nprompts: ${pass + fail} checks, ${pass} passed${fail ? `, ${fail} FAILED` : ''}`)
process.exit(fail ? 1 : 0)
