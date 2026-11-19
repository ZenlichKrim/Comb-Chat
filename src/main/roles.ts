import type { AgentRole, Brief, Capabilities, PlannerMode, ThoughtEffort } from '../shared/types'

/* ------------------------------------------------------------------ */
/* Capabilities -> concrete rules                                      */
/* ------------------------------------------------------------------ */

/**
 * The three switches the user actually understands, translated into the two
 * things the tool layer needs: whether a write needs an approval, and whether a
 * command may run at all. `off` is not a policy — it removes the capability, and
 * the tools refuse instead of asking.
 */
export function resolvePolicy(
  caps: Capabilities | undefined,
  fallback: 'ask' | 'auto-edit' | 'yolo'
): { approvalPolicy: 'ask' | 'auto-edit' | 'yolo'; writesOff: boolean; commandsOff: boolean } {
  if (!caps) {
    return {
      approvalPolicy: fallback,
      writesOff: false,
      commandsOff: false
    }
  }
  const approvalPolicy: 'ask' | 'auto-edit' | 'yolo' =
    caps.run === 'off' && caps.edit === 'auto'
      ? 'auto-edit'
      : caps.edit === 'auto' && caps.run === 'auto'
        ? 'yolo'
        : caps.edit === 'ask' || caps.run === 'ask'
          ? 'ask'
          : 'ask'
  return { approvalPolicy, writesOff: caps.edit === 'off', commandsOff: caps.run === 'off' }
}

/** Tools the author owns. Reading only — it can look, it cannot touch. */
export const AUTHOR_TOOLS = [
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'view_image',
  'ask_user',
  'leave_note',
  'suggest',
  'notify_user',
  'todo_write',
  'finish'
]

/** Tools the builder owns: the hands. No questions, no notes to the user. */
const BUILDER_DENY = new Set(['ask_user', 'leave_note', 'suggest', 'notify_user'])

export function toolsForRole(role: AgentRole, all: string[]): string[] {
  if (role === 'author') return all.filter((t) => AUTHOR_TOOLS.includes(t))
  return all.filter((t) => !BUILDER_DENY.has(t))
}

/* ------------------------------------------------------------------ */
/* Does this task need an author at all?                               */
/* ------------------------------------------------------------------ */

const QUESTION = /^\s*(что|кто|где|когда|почему|зачем|как|сколько|можно ли|есть ли|why|what|who|where|when|how|is|are|did|do|does|can|could)\b/i
const WORK = /(сделай|создай|исправ|добав|реализуй|напиши|перепиш|удали|установи|запусти|собери|почини|переделай|улучш|make|create|fix|add|implement|write|build|run|install|remove|refactor|improve)/i
const SMALL = /(опечатк|typo|переименуй|rename|одну строку|one line|быстро поправь|quick fix)/i

/**
 * Who runs this turn?
 *
 * - a pure question -> author only. The user wants words, and the builder has
 *   nothing to add: this was already half-broken because one agent could not
 *   decide whether it was being asked or told.
 * - a small mechanical fix -> builder only. A typo does not need a brief.
 * - everything else -> author first (when the planner switch allows it).
 */
export function planRoles(opts: {
  text: string
  planner: PlannerMode
  substantial?: boolean
}): { roles: AgentRole[]; reason: 'question' | 'small' | 'planned' | 'direct' } {
  const text = (opts.text || '').trim()
  const isQuestion = !WORK.test(text) && (/\?\s*$/.test(text) || QUESTION.test(text))
  if (isQuestion) return { roles: ['author'], reason: 'question' }
  if (opts.planner === 'off') return { roles: ['builder'], reason: 'direct' }
  if (SMALL.test(text) && text.length < 160) return { roles: ['builder'], reason: 'small' }
  if (opts.planner === 'always') return { roles: ['author', 'builder'], reason: 'planned' }
  // auto: a real task gets a brief, a one-liner just gets done
  if (text.length < 80 && !/\n.*\n/.test(text)) return { roles: ['builder'], reason: 'small' }
  return { roles: ['author', 'builder'], reason: 'planned' }
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

/**
 * The author. Its whole job is to be the person on the other side of the table:
 * hear what was asked, say what it thinks, invent the missing half, and turn all
 * of it into instructions precise enough that a builder cannot get them wrong.
 *
 * It has no write tools, so every sentence here is honest: it cannot quietly
 * start coding instead of talking.
 */
export function authorPrompt(opts: {
  locale: string
  workspace: string | null
  memory: string
  custom: string
  history: string
}): string {
  const ru = opts.locale === 'ru'
  return `Ты — Автор в Comb Chat: та половина команды, которая разговаривает с пользователем.
${ru ? 'Пиши по-русски.' : 'Write in English.'}

# Кто ты
Ты не исполнитель. Ты тот, кто понимает задачу, спорит, придумывает и решает.
Тебе нельзя писать файлы — не потому что запрещено, а потому что руки в этой
команде другие. Твои инструменты: читать, искать, смотреть картинки, задавать
вопросы, писать план.

# Что от тебя ждут
1. **Услышать.** Повтори своими словами, что просят — коротко, чтобы человек
   увидел, что его поняли. Если в просьбе есть противоречие или дыра, скажи об
   этом прямо и предложи, как её закрыть.
2. **Подумать как автор.** Что здесь будет оцениваться? Что человек забыл
   сказать, но явно ожидает? Что сделает результат приятным, а не «прошло по
   списку»? Придумай сверх просьбы — но только то, что действительно улучшает,
   а не то, что добавляет объём.
3. **Проверить реальность.** Если сомневаешься в факте о коде (какая версия,
   какие имена, какие классы уже есть) — прочитай файл. Один-два точных чтения
   лучше десяти догадок. Не устраивай экскурсию по проекту.
4. **Выдать бриф.** Это финал твоей работы — точные указания сборщику.

# Формат брифа (единственный выход)
Последним сообщением, после обычного разговора с человеком, напиши блок:

\`\`\`brief
ЦЕЛЬ: одно предложение — что должно получиться и зачем.
СДЕЛАТЬ:
- конкретное действие: какой файл, что в нём, как называется
- …
ПРОВЕРИТЬ:
- чем доказать, что работает (команда сборки, тест, что открыть глазами)
ДОБАВИТЬ:
- что ты придумал сверх просьбы и почему это стоит сделать
\`\`\`

Требования к брифу:
- Каждый пункт — действие, а не тема. «Создать WeatherFront.sample с полосой
  давления, затухающей по BFS на 0.62 за блок» — да. «Сделать погоду» — нет.
- Указывай имена файлов и классов. Сборщик не должен ничего додумывать.
- Не больше 12 пунктов. Если задача огромная — разбей на этапы и скажи, что
  делаем сейчас первый.
- В ПРОВЕРИТЬ пиши только то, что реально можно выполнить на этой машине.

# Как разговаривать
- Живой человек, не служба поддержки. Без «Конечно! Я с радостью помогу».
- Если пользователь неправ — скажи это, с обоснованием, и предложи лучше.
- Если задача бессмысленна или вредна — скажи, а не делай.
- Не пересказывай бриф словами: бриф говорит сам за себя.
- Вопрос задавай только когда ответ реально меняет работу: 2-4 варианта через
  ask_user, с рекомендацией. Один вопрос за разговор, не допрос.
- Вопрос не останавливает тебя: продолжай с рекомендованным вариантом и напиши
  бриф. Человек сможет поправить после.

# Контекст проекта
${opts.workspace ? `Рабочая папка: \`${opts.workspace}\`` : 'Папка не открыта — работать с файлами нельзя, только разговор.'}${
    opts.memory ? `\n\n# Память проекта (решения прошлых сессий)\n${opts.memory}` : ''
  }${opts.custom ? `\n\n# Инструкции пользователя (высший приоритет)\n${opts.custom}` : ''}${
    opts.history ? `\n\n# Что было раньше в этом разговоре\n${opts.history}` : ''
  }`
}

/**
 * The builder. It receives a brief and executes it — no architecture, no
 * philosophy, no questions to the user (it cannot ask: ask_user is not in its
 * tool list). Its prose is for the report, not for the transcript, which keeps
 * the screen quiet and the work fast.
 */
export function builderPrompt(opts: {
  locale: string
  workspace: string | null
  brief: Brief | null
  memory: string
  caps: Capabilities
}): string {
  const ru = opts.locale === 'ru'
  const briefText = opts.brief
    ? [
        `ЦЕЛЬ: ${opts.brief.goal}`,
        opts.brief.points.length ? `СДЕЛАТЬ:\n${opts.brief.points.map((p) => `- ${p}`).join('\n')}` : '',
        opts.brief.check.length ? `ПРОВЕРИТЬ:\n${opts.brief.check.map((p) => `- ${p}`).join('\n')}` : '',
        opts.brief.extra.length ? `ДОБАВИТЬ:\n${opts.brief.extra.map((p) => `- ${p}`).join('\n')}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  return `Ты — Сборщик в Comb Chat. Руки команды.
${ru ? 'Пиши по-русски.' : 'Write in English.'}

# Правила
- У тебя есть бриф. Это твоя задача целиком. Не переписывай её, не расширяй,
  не добавляй архитектуру от себя — этим занимался Автор, и он её проверит.
- Работай быстро: читай ровно то, что нужно для следующего действия, не изучай
  проект ради интереса.
- Один шаг — одно видимое действие. Не расписывай планы в тексте: план уже есть.
- Твой текст видят как строку «что делаю сейчас». Пиши коротко и по-человечески:
  «размечаю реестр предметов», «собираю jar через gradle». Не отчёт, не эссе.
- Проверяй результат, а не намерение: собери, запусти, прочти вывод. «Должно
  работать» — не результат, зелёная сборка — результат.
- Если пункт брифа невозможно выполнить — сделай остальные и напиши в отчёте,
  какой именно и почему. Не подменяй его заглушкой.
- Ты не разговариваешь с пользователем: тебе нельзя задавать вопросы. Решай сам
  в рамках брифа.
- В конце — finish с отчётом: что сделано по пунктам, что проверено и чем,
  что осталось.

# Права на этот прогон
- Правки файлов: ${opts.caps.edit === 'off' ? 'ЗАПРЕЩЕНЫ' : opts.caps.edit === 'auto' ? 'без подтверждений' : 'с подтверждением'}
- Команды: ${opts.caps.run === 'off' ? 'ЗАПРЕЩЕНЫ' : opts.caps.run === 'auto' ? 'без подтверждений' : 'с подтверждением'}

# Окружение
${opts.workspace ? `Рабочая папка: \`${opts.workspace}\`. Относительные пути — от неё.` : 'Папка не открыта.'}${
    opts.memory ? `\n\n# Память проекта\n${opts.memory}` : ''
  }${briefText ? `\n\n# БРИФ ОТ АВТОРА\n${briefText}` : '\n\nБриф не передан: работай по прямому указанию пользователя.'}`
}

/** Parse the author's ```brief block into something the builder can be held to. */
export function parseBrief(text: string): Brief | null {
  const block = text.match(/```brief\s*([\s\S]*?)```/i)?.[1]
  const body = block || ''
  if (!body.trim()) return null
  const lines = body.split(/\r?\n/)
  const goal: string[] = []
  const points: string[] = []
  const check: string[] = []
  const extra: string[] = []
  let bucket: string[] = goal
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const head = line.replace(/[:：]\s*$/, '').toUpperCase()
    if (/^ЦЕЛЬ|^GOAL/.test(head)) {
      bucket = goal
      const rest = line.replace(/^[^:：]*[:：]\s*/, '')
      if (rest && !/^ЦЕЛЬ|^GOAL/i.test(line.replace(/[:：].*$/, ''))) bucket.push(rest)
      continue
    }
    if (/^СДЕЛАТЬ|^DO\b|^TODO/.test(head)) {
      bucket = points
      continue
    }
    if (/^ПРОВЕРИТЬ|^CHECK|^VERIFY/.test(head)) {
      bucket = check
      continue
    }
    if (/^ДОБАВИТЬ|^ADD\b|^EXTRA/.test(head)) {
      bucket = extra
      continue
    }
    bucket.push(line.replace(/^[-*•]\s*/, ''))
  }
  const goalText = goal.join(' ').trim()
  if (!goalText && !points.length) return null
  return {
    goal: goalText || points[0] || '',
    points: points.slice(0, 24),
    check: check.slice(0, 12),
    extra: extra.slice(0, 12),
    raw: body.trim()
  }
}

/** Model for each role: the author thinks, the builder executes. */
export function modelForRole(
  role: AgentRole,
  chosen: string,
  effort: ThoughtEffort
): { model: string; effort: ThoughtEffort } {
  if (role === 'author') {
    // Pro wins on text reasoning, which is exactly what a brief is. Keep the
    // user's model if they picked Pro explicitly; otherwise Flash + thinking.
    return { model: chosen === 'deepseek-v4-pro' ? chosen : 'deepseek-flash-thinking', effort: effort === 'fast' ? 'balanced' : effort }
  }
  // The builder has instructions and no need to re-derive them: thinking costs
  // money and time here and changes little. Big briefs still get a little room.
  return { model: chosen.replace(/-thinking$/, ''), effort: 'fast' }
}
