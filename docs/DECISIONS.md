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

## Iteration 45b — rebuilt against the reference, not just trimmed

The first pass removed things but kept the old dark, dense frame. The user's
reference is a different *shape*: white page, one column of text, sessions in the
sidebar, one rounded field at the bottom. That is what this pass does.

- **Light by default.** New theme `light`: white page, one hairline between
  columns, ink text, a single near-black accent for the action you are about to
  take. `paper` stays as the warm light option; the dark themes are still there
  in Settings. Existing installs keep whatever they chose; `nativeTheme` and the
  window background follow the light theme too.
- **Sidebar is the session list.** New session is a row; sessions are one line of
  text and their age (the reference's `15мин`); files, search and source control
  are quieter rows below a divider that open their panel *under* the list instead
  of replacing it. Settings lives at the bottom, alone.
- **Composer.** One rounded field, the permission mode said in one word
  («Полный доступ» / «Спрашивать») instead of two cryptic dots, a round send
  button. No shadow ring on focus.
- **Empty session has no header** — the greeting is the page.
- **Settings** is a smaller sheet (880×640): section list on the left, sparse
  rows on the right, no brand badge, the chosen row in grey rather than accent.
- **Shadows** are soft everywhere; the dark-only `rgba(0,0,0,.7)` drops read as
  soot on a white page.
- `tests/preview.mjs` renders TitleBar + Sidebar + ChatPane + StatusBar through the
  real store and the real stylesheet into `docs/preview.html`, so the window can
  be looked at without a browser. `tests/ui.mjs` now also pins the light default,
  the session list in the sidebar, and the one-word permission mode.
