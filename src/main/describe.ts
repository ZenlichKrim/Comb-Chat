import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { readFileSafe } from './fsops'
import { completeOnce } from './llm'
import { getSettings } from './store'
import type { FileSummary } from '../shared/types'

/**
 * Per-file descriptions written by the model, cached on disk.
 *
 * The cache is keyed by absolute path and invalidated by mtime+size, so a file
 * that changed gets described again while untouched files cost nothing. Nothing
 * here is sent anywhere except the configured model endpoint.
 */

const MAX_FILES = 400

interface CacheEntry extends FileSummary {
  /** empty string = the model judged the file not worth a line (kept to avoid paying twice) */
  path: string
  mtime: number
  size: number
}

let cache: Record<string, CacheEntry> | null = null
let inflight: Promise<void> | null = null

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'file-summaries.json')
}

async function load(): Promise<Record<string, CacheEntry>> {
  if (cache) return cache
  if (!inflight) {
    inflight = (async () => {
      try {
        cache = JSON.parse(await fs.readFile(cacheFile(), 'utf8')) as Record<string, CacheEntry>
      } catch {
        cache = {}
      }
    })()
  }
  await inflight
  return cache || {}
}

async function save(): Promise<void> {
  if (!cache) return
  const file = cacheFile()
  const tmp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)
  await fs.writeFile(tmp, JSON.stringify(cache), 'utf8').catch(() => undefined)
  await fs.rename(tmp, file).catch(() => undefined)
}

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp3|mp4|zip|tar|gz|7z|dmg|exe|dll|so|dylib|pdf|apk|jar|class|dex)$/i

export async function getSummaries(paths: string[]): Promise<FileSummary[]> {
  const db = await load()
  const out: FileSummary[] = []
  for (const p of paths) {
    const hit = db[p]
    if (!hit || !hit.description) continue
    out.push({
      path: p,
      description: hit.description,
      purpose: hit.purpose,
      mtime: hit.mtime,
      size: hit.size,
      generatedAt: hit.generatedAt
    })
  }
  return out
}

export interface DescribeContext {
  /** the user's request, so the model can explain why this file exists */
  task?: string
  /** short note about how the file came to be */
  hint?: string
}

/** Describe one file. Returns null when the file is binary, not worth a line, or the model failed. */
export async function describeFile(abs: string, ctx: DescribeContext | string = {}): Promise<FileSummary | null> {
  const context: DescribeContext = typeof ctx === 'string' ? { hint: ctx } : ctx
  const db = await load()
  let st: Awaited<ReturnType<typeof fs.stat>>
  try {
    st = await fs.stat(abs)
  } catch {
    return null
  }
  const existing = db[abs]
  const upToDate = existing && existing.mtime === st.mtimeMs && existing.size === st.size
  // a content-only description is a downgrade once we know why the file was written
  if (upToDate && !(context.task && !existing.purpose)) {
    return existing.description ? existing : null
  }
  if (SKIP_EXT.test(abs) || st.size > 400_000) return null

  const settings = await getSettings()
  if (!settings.apiKey && settings.provider !== 'local') throw new Error('No API key configured')

  const fc = await readFileSafe(abs)
  if (!fc.content || fc.content.length < 4) return null

  const rel = path.basename(abs)
  const body = fc.content.slice(0, 6000)
  const lang = settings.locale === 'ru' ? 'ru' : 'en'
  const text = await completeOnce({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    local: settings.provider === 'local',
    system:
      'You label files in a coding agent\'s explorer so the user instantly understands what a file is THERE FOR. ' +
      'Reply with JSON only: {"purpose": string, "description": string|null}.\n' +
      '- "description": what the file is FOR, in one plain sentence, at most 90 characters. Why it exists, what job it does ' +
      'for the project — never a line-by-line narration of what is inside, never the file name, no markdown.\n' +
      '- If a task is given below, the file was created or rewritten WHILE doing that task: "description" must say what ' +
      'purpose this file serves in that work (e.g. "the limiter that POST /auth/login now goes through"), and "purpose" ' +
      'must answer in one short sentence WHY the agent created it and what would break without it.\n' +
      '- If the file is not worth a line (lockfile, generated bundle, empty stub, barrel of re-exports, config that says ' +
      'nothing beyond its name), reply {"purpose": null, "description": null} instead of inventing filler.\n' +
      `- Write in this language: ${lang}.`,
    user:
      `interface language: ${lang}\nfile: ${rel}` +
      (context.task ? `\ntask the agent was doing: ${context.task.slice(0, 600)}` : '') +
      (context.hint ? `\nnote: ${context.hint}` : '') +
      `\n\n${body}`,
    maxTokens: 220
  })
  const m = /\{[\s\S]*\}/.exec(text)
  let description = ''
  let purpose = ''
  let skip = false
  try {
    const parsed = JSON.parse(m ? m[0] : text)
    if (parsed?.description === null && !parsed?.purpose) skip = true
    description = String(parsed?.description || '')
    purpose = String(parsed?.purpose || '')
  } catch {
    description = text.split('\n')[0].slice(0, 120)
  }

  const entry: CacheEntry = {
    path: abs,
    description: skip ? '' : description.trim(),
    purpose: skip ? '' : purpose.trim(),
    mtime: st.mtimeMs,
    size: st.size,
    generatedAt: Date.now()
  }
  db[abs] = entry
  // keep the cache bounded: drop the oldest descriptions
  const keys = Object.keys(db)
  if (keys.length > MAX_FILES) {
    keys
      .sort((a, b) => (db[a].generatedAt || 0) - (db[b].generatedAt || 0))
      .slice(0, keys.length - MAX_FILES)
      .forEach((k) => delete db[k])
  }
  await save()
  return entry.description || entry.purpose ? entry : null
}

/* ------------------------------------------------------------------ */
/* Auto-labelling                                                      */
/* ------------------------------------------------------------------ */

/**
 * Describe files the agent just wrote, quietly and in the background.
 *
 * The point is that the user should never have to ask "what is this file the
 * agent just created". We hand the model the name plus a short prompt note so it
 * can judge whether the file is worth a line at all; uninteresting ones are
 * cached as "not worth it" and never asked about again. Errors are swallowed —
 * labelling must never break a run.
 */
export function describeInBackground(
  files: { path: string; note?: string }[],
  opts: { concurrency?: number; task?: string; onEach?: (s: FileSummary) => void } = {}
): void {
  const concurrency = opts.concurrency ?? 2
  const queue = [...new Set(files.map((f) => f.path))].slice(0, 12)
  if (!queue.length) return
  let active = 0
  const pump = (): void => {
    while (active < concurrency && queue.length) {
      const file = queue.shift() as string
      active += 1
      void describeFile(file, { task: opts.task, hint: files.find((f) => f.path === file)?.note })
        .then((s) => {
          if (s) opts.onEach?.(s)
        })
        .catch(() => undefined)
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }
  pump()
}
