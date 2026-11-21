# Decisions

## Iteration 45 — a calmer window, and a quota that is not retried

The user sent two screenshots of another harness and said the interface was
"too loaded". Looking at ours next to theirs, the load was not decoration: it was
**duplicate navigation and duplicate bars**.

### What was removed
- The icon **rail** (`sb-tabs`) and the section headers behind it. Two navigation
  systems for one list. The sidebar is now a column of names — Сессии,
  Проводник, Поиск, Контроль версий, Настройки — and clicking a name swaps the
  body under it.
- The right-hand **plan/context/history panel** and its store slice
  (`rightPanel`, `setRightPanel`), the `Ctrl+J` shortcut and three palette
  commands. The plan already lives in the transcript as `todo_write` steps.
- The per-message **gutter**: avatar plus a vertical spine next to every
  assistant turn. The transcript is one column with a readable max-width.
- The floating `sb-collapse` chevron — the open/close button sits in the sidebar
  header now, where the eye looks for it.
- Three settings tabs (Editor, Terminal) folded into Appearance; settings are
  five tabs instead of seven.
- Filled title bar and status bar. Both are the page colour with one hairline;
  the window no longer has a strip at the top and another at the bottom.

### What was added
- `tests/ui.mjs` renders the real `Sidebar` against the real store and checks
  the words a person reads, that a row switches the body, and that the removed
  pieces stay removed.
- `tests/quota.mjs` drives the real `streamChat` against a local endpoint.

### The quota bug
DeepSeek answers **429** both for "slow down a second" and for "this key has
spent its request budget". `RETRYABLE` treated both as transient, so a dead key
was asked six times per agent step — the "Повторный запрос модели (n/5)" rows in
the user's screenshot — and the run died anyway.

`llm.ts` now separates them: a 429 whose body says quota / exhausted / daily
limit / plan limit, or whose `Retry-After` is longer than 90 seconds, is a new
permanent `quota` kind. It is thrown on the first answer, the run ends with a
sentence that names the way out (top up on platform.deepseek.com), and
`runAgent` reports `ok: false` for it instead of pretending the turn succeeded.
