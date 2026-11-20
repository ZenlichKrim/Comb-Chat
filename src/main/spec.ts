import fs from 'node:fs'
import path from 'node:path'
import type { Capabilities, SpecCheck, SpecReport } from '../shared/types'
import { completeOnce } from './llm'

/**
 * The contract.
 *
 * Everything that went wrong with "поставь задачу — получи частицы на пауков"
 * has the same root: nobody ever wrote down what the user asked for in terms
 * that can be checked, and the agent graded its own homework. A prompt that
 * says "делай хорошо" cannot fix that, because "хорошо" is decided by the same
 * model that decided it was done.
 *
 * So the contract is a file with numbered criteria, written from the user's own
 * words before any code exists, and a separate pass — which never saw the
 * builder's reasoning — that reads the criteria against the actual files and
 * says which ones it cannot find. That pass is allowed to fail the work.
 */

const SPEC_FILE = 'SPEC.md'

/** Words that promise a whole system rather than a tweak. */
const BIG = /(мод|mod|игру|game|приложени|app|сайт|site|систем|system|движок|engine|плагин|plugin|аген|agent|редактор|editor|дашборд|dashboard)/i

export function specPath(workspace: string | null): string | null {
  if (!workspace) return null
  return path.join(workspace, SPEC_FILE)
}

export function readSpec(workspace: string | null): string {
  const p = specPath(workspace)
  if (!p) return ''
  try {
    return fs.readFileSync(p, 'utf8').slice(0, 12000)
  } catch {
    return ''
  }
}

/**
 * Does this request deserve a contract?
 *
 * A typo fix does not: writing a spec for it is the kind of ceremony that makes
 * agents feel slow. A asks for a system, or is plainly a paragraph of
 * requirements — that one does.
 */
export function needsSpec(text: string): boolean {
  const t = (text || '').trim()
  if (t.length < 60) return false
  if (BIG.test(t)) return true
  // a long, structured ask ("1. … 2. …" or many lines) is a spec by itself
  return t.length > 700 || /\n\s*(\d+[.)]|[-*])\s+/g.test(t)
}

/** Pull criteria out of a spec the model wrote, so the checker can be told them. */
export function specCriteria(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\*\*)?(.{6,240})$/)
    if (!m) continue
    out.push(m[1].replace(/\*\*/g, '').trim())
    if (out.length >= 40) break
  }
  return out
}

export function writeSpec(workspace: string | null, body: string): string | null {
  const p = specPath(workspace)
  if (!p) return null
  try {
    fs.writeFileSync(p, body.trim() + '\n', 'utf8')
    return p
  } catch {
    return null
  }
}

const SPEC_SYSTEM = `You are the contract writer on a software team. You turn a user's request into a short SPEC.md that a builder will be held to and a reviewer will judge.

Rules:
- Write in the same language the user wrote in (Russian if the request is Russian).
- The spec states the DELIVERABLE and numbered acceptance criteria that can be verified by looking at files or running a command. No moods, no "good quality".
- Every criterion must be about observable behaviour: a class exists, a registry is populated, a command builds, a file lands on disk, an item appears in game.
- Include a section «Границы»: what is explicitly NOT being done in this round, so the builder cannot pad instead of delivering.
- Include a section «Доказательства»: one line per criterion saying how it will be proven (file path, command, screenshot).
- If the user asked for a system, the spec must name the parts of that system. A "mod" is not "particles": say weather, items, blocks, mobs, effects — whatever the request implies — and mark which parts are this round.
- Never invent requirements the user did not imply. Ambiguity goes into «Открытые вопросы» as a decision you made with one line of reasoning.
- Output ONLY the markdown spec. No preamble, no code fences around the whole thing.`

/**
 * Write SPEC.md for this request, unless the project already has one that is
 * still relevant. Returns the spec text ('' when there is none to write).
 */
export async function ensureSpec(opts: {
  workspace: string | null
  request: string
  apiKey: string
  baseUrl: string
  model: string
  signal?: AbortSignal
}): Promise<{ spec: string; path: string | null; written: boolean }> {
  const existing = readSpec(opts.workspace)
  const criteria = specCriteria(existing)
  // A spec with real criteria is the project's memory: do not overwrite it with
  // a fresh reading of one sentence, or the next round forgets what was decided.
  if (existing && criteria.length >= 3) {
    return { spec: existing, path: specPath(opts.workspace), written: false }
  }
  if (!opts.apiKey) return { spec: '', path: null, written: false }
  let body = ''
  try {
    body = await completeOnce({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      system: SPEC_SYSTEM,
      user: `Запрос пользователя:\n\n${opts.request.slice(0, 6000)}\n\nНапиши SPEC.md.`,
      maxTokens: 2000,
      signal: opts.signal
    })
  } catch {
    return { spec: '', path: null, written: false }
  }
  if (!body.trim()) return { spec: '', path: null, written: false }
  const p = writeSpec(opts.workspace, body)
  return { spec: body, path: p, written: !!p }
}

/** The per-file excerpt the reviewer is allowed to see. */
const MAX_FILE_CHARS = 3500
const MAX_FILES = 14

export function changedFileExcerpts(workspace: string | null, files: string[]): { path: string; body: string }[] {
  const ws = workspace || ''
  const out: { path: string; body: string }[] = []
  for (const rel of files.slice(0, MAX_FILES)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ws, rel)
    try {
      const stat = fs.statSync(abs)
      if (!stat.isFile() || stat.size > 400_000) continue
      const body = fs.readFileSync(abs, 'utf8').slice(0, MAX_FILE_CHARS)
      out.push({ path: path.relative(ws, abs) || rel, body })
    } catch {
      continue
    }
  }
  return out
}

const CHECK_SYSTEM = `You are the reviewer on a software team. You did not write this code and you do not trust the builder's report. Your only job is to say, criterion by criterion, whether the deliverable actually satisfies the user's request.

You get: the user's original request, the spec's acceptance criteria, the builder's report, and the text of the files it changed.

Rules:
- Judge what is in the files, not what the report claims. A report that says "полноценный мод" over four particle files is a FAIL.
- A criterion is "done" only if you can point at the code that satisfies it. Otherwise "fail" with a one-line reason and, when useful, a concrete instruction.
- Judge scope too: if the user asked for a system and the code covers a corner of it, that is a fail even when every written file is fine. Say which parts are missing.
- Be specific and short. No praise. No restating the spec.
- Answer ONLY with JSON:
{"checks":[{"claim":"<criterion, short>","status":"done|fail","evidence":"<file: what in it proves it>","fix":"<what to do, only when fail>"}],"verdict":"done|rework","summary":"<one sentence for the user>"}`

/**
 * The independent review: criteria vs. what is actually on disk.
 *
 * Cheap on purpose — one non-streaming call, no thinking budget, files lopped
 * at a few KB. It runs before the user is told "готово", and its verdict can
 * send the work back exactly once.
 */
export async function checkAgainstSpec(opts: {
  request: string
  spec: string
  report: string
  files: { path: string; body: string }[]
  apiKey: string
  baseUrl: string
  model: string
  signal?: AbortSignal
}): Promise<SpecReport | null> {
  const criteria = specCriteria(opts.spec)
  if (!opts.apiKey || (!criteria.length && !opts.spec.trim())) return null
  const filesText = opts.files.length
    ? opts.files.map((f) => `### ${f.path}\n\`\`\`\n${f.body}\n\`\`\``).join('\n\n')
    : '(the run changed no files)'
  const user =
    `ЗАПРОС ПОЛЬЗОВАТЕЛЯ:\n${opts.request.slice(0, 3000)}\n\n` +
    `КРИТЕРИИ ПРИЁМКИ:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
    `ОТЧЁТ СБОРЩИКА:\n${(opts.report || '(нет)').slice(0, 2500)}\n\n` +
    `ИЗМЕНЁННЫЕ ФАЙЛЫ:\n${filesText}`
  let raw = ''
  try {
    raw = await completeOnce({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      system: CHECK_SYSTEM,
      user,
      maxTokens: 1200,
      signal: opts.signal
    })
  } catch {
    return null
  }
  const json = raw.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null
  let parsed: any
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const checks: SpecCheck[] = Array.isArray(parsed?.checks)
    ? parsed.checks
        .filter((c: any) => c && typeof c.claim === 'string')
        .slice(0, 40)
        .map((c: any) => ({
          claim: String(c.claim).slice(0, 200),
          status: c.status === 'done' ? 'done' : 'fail',
          evidence: c.evidence ? String(c.evidence).slice(0, 300) : undefined,
          fix: c.fix ? String(c.fix).slice(0, 300) : undefined
        }))
    : []
  if (!checks.length) return null
  const failed = checks.filter((c) => c.status === 'fail')
  const verdict: 'done' | 'rework' = parsed?.verdict === 'rework' || failed.length ? 'rework' : 'done'
  return {
    verdict,
    checks,
    summary: String(parsed?.summary || (verdict === 'done' ? 'Все критерии подтверждены в коде.' : 'Часть критериев не подтверждена.'))
      .slice(0, 400),
    at: Date.now()
  }
}

/** A short block the builder actually receives, so it chases criteria, not vibes. */
export function specForBuilder(spec: string, caps: Capabilities | undefined, attempt: number): string {
  const criteria = specCriteria(spec)
  if (!criteria.length) return ''
  const head =
    attempt > 0
      ? `# КОНТРАКТ (попытка ${attempt + 1}). Прошлая попытка не прошла проверку — читай, что именно не подтвердилось.`
      : '# КОНТРАКТ — критерии приёмки от пользователя'
  return (
    `${head}\n` +
    criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') +
    '\n\nЭто не пожелания, а условие сдачи: приёмку проводит отдельный проверяющий, который смотрит файлы, а не твой отчёт. ' +
    'Невыполненный пункт нельзя заменить заглушкой или соседним пунктом.' +
    (caps && caps.edit === 'off' ? '\n(Правки файлов в этом прогоне запрещены — контракт всё равно остаётся.)' : '')
  )
}

/** The block the reviewer hands back to the builder when it fails the work. */
export function reworkBrief(report: SpecReport): string {
  const failed = report.checks.filter((c) => c.status === 'fail')
  return (
    'Проверка НЕ приняла работу.\n\n' +
    failed.map((c, i) => `${i + 1}. НЕ ВЫПОЛНЕНО: ${c.claim}${c.fix ? `\n   Что делать: ${c.fix}` : ''}`).join('\n') +
    '\n\nДоработай именно эти пункты реальным кодом. Не переписывай то, что уже подтверждено, и не добавляй новое от себя.\n' +
    'Когда закончишь — finish с отчётом, в котором по каждому пункту выше сказано, чем он подтверждён.'
  )
}
