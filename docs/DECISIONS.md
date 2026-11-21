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

## Iteration 46 — local models (the honest version of "no money")

The user asked for DeepSeek Flash downloaded to the computer. It cannot be done:
DeepSeek's models are not released as weights, so there is nothing to download.
What the app *can* do — and now does — is run a model that IS published, on this
machine, behind an OpenAI-compatible server.

- `Settings.provider: 'deepseek' | 'local'`, plus `customModels[]` the user names
  by hand. `modelsFor()` / `findModel()` merge them with DeepSeek's three, so the
  picker, the title bar, the status bar and the context meter all work unchanged.
- A local request sends **no** key, **no** `thinking` object, **no**
  reasoning-replay requirement — Ollama answers 400 to every one of those. Cost is
  reported as exactly $0, because a price on a model that runs on your own CPU is
  the one number a user would call a lie.
- Model routing is off for local runs: a run must never quietly reach for a cloud
  model the user did not choose (that is a bill they never agreed to).
- `agent:listModels` reads `/v1/models` so the app shows what is actually pulled
  instead of asking the user to type a name from memory. A 404 from a localhost
  server means "not pulled yet", not "wrong address" — the message says so.
- Settings → Model opens with a "Local models" screen: Ollama / LM Studio /
  llama.cpp presets, a check button, the pulled models as clickable rows, and one
  honest line about the trade (free, slower, ~9 GB for a 14B model).
- `tests/local-models.mjs` (14 checks) runs a fake Ollama: listing, the exact
  request shape, a whole agent run with an empty API key, and $0 usage.
