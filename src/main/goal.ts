import path from 'node:path'
import type { AgentEvent, RunRequest, SpecReport } from '../shared/types'
import { runAgent, type AgentDeps } from './agent'
import { readSpec, specCriteria } from './spec'

/**
 * The goal.
 *
 * The contract (SPEC.md) says what "done" means. A goal says: keep going until
 * it is actually done. Without one, a long task ends when the step budget or the
 * model's patience runs out — which is exactly the "он начал и бросил на
 * середине" the user keeps seeing.
 *
 * So a run that ends with an unmet contract, or with its own plan unfinished,
 * does not end. It becomes round N+1 of the same goal, with a fresh context that
 * carries only: the criteria, what is already confirmed, and what is next. That
 * last part matters — re-feeding the whole history is how an agent loses the
 * thread; re-feeding the contract is how it keeps it.
 */

export type GoalStop = 'contract-met' | 'rounds-used' | 'no-progress' | 'failed' | 'off'

/**
 * The ledger every round inherits.
 *
 * A fresh context per round keeps the model sharp, but a fresh context with no
 * memory of what was already settled makes it redo the same four edits and
 * re-litigate the same three files. So each round writes down what it
 * established, and the next round opens with that list instead of the whole
 * transcript. Evidence, not narration: a fact earns its line by being something
 * a later round would otherwise have to rediscover.
 */
export interface RoundLedger {
  /** one line per settled fact: a file that exists, a command that passes */
  done: string[]
  /** things proven impossible on this machine, so no round repeats them */
  ruledOut: string[]
}

export interface GoalOutcome {
  rounds: number
  stop: GoalStop
  /** the builder's report from the last round */
  lastText?: string
  /** the last contract verdict, for the chat card */
  lastCheck?: SpecReport | null
}

/** A run whose contract is still unmet, or whose plan still has open items. */
export interface ContinueSignal {
  /** criteria that came back unconfirmed (authoritative when present) */
  unmet: string[]
  /** open todo texts, when the model kept a plan */
  openTodos: string[]
}

export function shouldContinue(contract: string, report: SpecReport | null, todos: { text: string; status: string }[]): ContinueSignal | null {
  const openTodos = todos.filter((t) => t.status !== 'done').map((t) => t.text)
  if (report) {
    const unmet = report.checks.filter((c) => c.status === 'fail').map((c) => c.claim)
    if (unmet.length) return { unmet, openTodos }
    // the checker is the authority: a clean verdict ends the goal even if the
    // model left its own checklist unticked (that is bookkeeping, not work)
    return null
  }
  if (specCriteria(contract).length && openTodos.length) return { unmet: [], openTodos }
  return null
}

/**
 * Fold one finished round into the ledger.
 *
 * Only claims that a later round would otherwise have to re-derive are kept:
 * files this round actually wrote, and blockers the round stated in its own
 * words. Everything is de-duplicated and the list stays short — a ledger that
 * grows without bound is just the transcript again.
 */
export function mergeLedger(
  ledger: RoundLedger,
  round: { touched?: string[]; report?: string; workspace?: string | null; verdict?: string | null }
): RoundLedger {
  const cap = 14
  const done = [...ledger.done]
  for (const abs of round.touched || []) {
    const rel = round.workspace ? path.relative(round.workspace, abs) || path.basename(abs) : abs
    const line = `${rel} — записан этим прогоном`
    if (!done.includes(line)) done.push(line)
  }
  const ruledOut = [...ledger.ruledOut]
  const blocker = (round.report || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /(невозможно|не могу|cannot|blocked|нет доступа|not available)/i.test(l))
  if (blocker) {
    const line = blocker.slice(0, 200)
    if (!ruledOut.some((r) => r === line)) ruledOut.push(line)
  }
  return { done: done.slice(-cap), ruledOut: ruledOut.slice(-6) }
}

/** The prompt that opens round N: a handoff, not a history dump. */
export function roundPrompt(opts: {
  objective: string
  round: number
  maxRounds: number
  signal: ContinueSignal
  criteria: string[]
  attemptsSoFar: number
  ledger?: RoundLedger
  /** the previous round's own prose, trimmed: what it claims it did */
  previousReport?: string
}): string {
  const items = [
    opts.signal.unmet.length
      ? `# Проверка не подтвердила эти критерии\n${opts.signal.unmet.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '',
    opts.signal.openTodos.length
      ? `# В плане остались открытые пункты\n${opts.signal.openTodos.map((c) => `- ${c}`).join('\n')}`
      : '',
    opts.criteria.length
      ? `# Критерии приёмки целиком (${opts.criteria.length})\n${opts.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '',
    opts.ledger?.done.length
      ? `# Уже сделано и проверено в прошлых раундах\n${opts.ledger.done.map((c) => `- ${c}`).join('\n')}`
      : '',
    opts.ledger?.ruledOut.length
      ? `# Уже выяснено, что не работает — не повторяй\n${opts.ledger.ruledOut.map((c) => `- ${c}`).join('\n')}`
      : '',
    opts.previousReport
      ? `# Отчёт прошлого раунда (его слова, не проверка)\n${opts.previousReport.slice(0, 1200)}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  return (
    `Раунд ${opts.round} из ${opts.maxRounds} по цели:\n"""${opts.objective.slice(0, 1200)}"""\n\n` +
    `${items}\n\n` +
    `Продолжай работу в этом же проекте: состояние на диске — источник правды, читай файлы, а не память о них. ` +
    `Сделай следующий настоящий шаг: реальный код в реальных файлах, подключённый туда, где он должен работать. ` +
    `Не переписывай то, что уже подтверждено, и не описывай план вместо работы. ` +
    `В конце раунда — одной строкой каждое: что теперь реально существует (путь, команда, сборка) и что проверил. ` +
    `Это ${opts.attemptsSoFar === 0 ? 'первая' : 'не первая'} попытка довести цель до конца — если что-то объективно невозможно на этой машине, ` +
    `скажи одной строкой, что именно, и доведи остальное.`
  )
}

/**
 * Keep the goal moving. Each round is a real run of the builder with the
 * contract attached; the loop stops the moment the checker confirms the
 * criteria, when progress stalls, or when the round budget is spent — and it
 * says which of those happened instead of ending silently.
 */
export async function driveGoal(opts: {
  req: RunRequest
  deps: AgentDeps
  signal: ContinueSignal
  maxRounds: number
  /** how many runs this goal already used (the first builder run counts as one) */
  usedRounds: number
  contract: string
  /** called after each round so the caller can re-check and re-render */
  afterRound: (round: number) => Promise<SpecReport | null>
}): Promise<GoalOutcome> {
  const criteria = specCriteria(opts.contract)
  let rounds = opts.usedRounds
  let lastCheck: SpecReport | null = null
  let lastText = ''
  let signal = opts.signal
  let ledger: RoundLedger = { done: [], ruledOut: [] }
  let previousReport = ''
  let stalled = 0
  const maxRounds = Math.max(opts.usedRounds, opts.maxRounds)

  while (rounds < maxRounds) {
    const round = rounds + 1
    opts.deps.emit({
      type: 'goal-round',
      runId: opts.req.runId,
      round,
      maxRounds,
      reason: signal.unmet.length ? 'criteria' : 'plan',
      detail: (signal.unmet[0] || signal.openTodos[0] || '').slice(0, 160)
    })
    opts.deps.emit({ type: 'role', runId: opts.req.runId, role: 'builder', phase: 'working' })

    const res = await runAgent(
      {
        ...opts.req,
        runId: `${opts.req.runId}:goal${round}`,
        messageId: `${opts.req.messageId}:goal${round}`,
        role: 'builder',
        roleMode: 'split',
        spec: opts.contract,
        specAttempt: rounds,
        history: [],
        userMessage: {
          ...opts.req.userMessage,
          content: roundPrompt({ objective: opts.req.userMessage.content, round, maxRounds, signal, criteria, attemptsSoFar: rounds, ledger, previousReport })
        }
      },
      opts.deps
    )
    rounds = round
    lastText = res.finalText || lastText
    previousReport = (res.finalText || '').trim()
    ledger = mergeLedger(ledger, { touched: res.touched, report: previousReport, workspace: opts.req.workspace })
    if (!res.ok) return { rounds, stop: 'failed', lastCheck, lastText }

    const check = await opts.afterRound(round)
    if (check) {
      lastCheck = check
      if (check.verdict === 'done') {
        opts.deps.emit({ type: 'goal-end', runId: opts.req.runId, rounds, stop: 'contract-met' })
        return { rounds, stop: 'contract-met', lastCheck, lastText }
      }
      const unmet = check.checks.filter((c) => c.status === 'fail').map((c) => c.claim)
      // no change in what fails means the loop is spinning, not progressing
      const same = signal.unmet.length === unmet.length && unmet.every((u) => signal.unmet.includes(u))
      stalled = same ? stalled + 1 : 0
      signal = { unmet, openTodos: [] }
    } else {
      // no checker available: fall back to the model's own plan
      const open = (res.finalText || '').trim() ? signal.openTodos : []
      stalled = open.length === signal.openTodos.length ? stalled + 1 : 0
      signal = { unmet: [], openTodos: open }
      if (!open.length) {
        opts.deps.emit({ type: 'goal-end', runId: opts.req.runId, rounds, stop: 'no-progress' })
        return { rounds, stop: 'no-progress', lastCheck, lastText }
      }
    }
    if (stalled >= 2) {
      opts.deps.emit({ type: 'goal-end', runId: opts.req.runId, rounds, stop: 'no-progress' })
      return { rounds, stop: 'no-progress', lastCheck, lastText }
    }
  }
  opts.deps.emit({ type: 'goal-end', runId: opts.req.runId, rounds, stop: 'rounds-used' })
  return { rounds, stop: 'rounds-used', lastCheck, lastText }
}

/** read the contract once so the caller does not pass it around by hand */
export function contractFor(workspace: string | null): string {
  return readSpec(workspace)
}

export type { AgentEvent }
