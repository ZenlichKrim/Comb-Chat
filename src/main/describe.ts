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
    if (!hit) continue
    out.push({ path: p, description: hit.description, mtime: hit.mtime, size: hit.size, generatedAt: hit.generatedAt })
  }
  return out
}

/** Describe one file. Returns null when the file is binary or the model failed. */
export async function describeFile(abs: string): Promise<FileSummary | null> {
  const db = await load()
  let st: Awaited<ReturnType<typeof fs.stat>>
  try {
    st = await fs.stat(abs)
  } catch {
    return null
  }
  const existing = db[abs]
  if (existing && existing.mtime === st.mtimeMs && existing.size === st.size) {
    return existing
  }
  if (SKIP_EXT.test(abs) || st.size > 400_000) return null

  const settings = await getSettings()
  if (!settings.apiKey) throw new Error('No API key configured')

  const fc = await readFileSafe(abs)
  if (!fc.content || fc.content.length < 4) return null

  const rel = path.basename(abs)
  const body = fc.content.slice(0, 6000)
  const text = await completeOnce({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    system:
      'You write one-line file descriptions for a code explorer. Reply with JSON only: {"description": string}. ' +
      'The description must be one sentence, at most 90 characters, in the same language as the user interface language given below. ' +
      'Say what the file is for, not what it contains line by line. No markdown, no file name.',
    user: `interface language: ${settings.locale === 'ru' ? 'ru' : 'en'}\nfile: ${rel}\n\n${body}`,
    maxTokens: 160
  })
  const m = /\{[\s\S]*\}/.exec(text)
  let description = ''
  try {
    description = JSON.parse(m ? m[0] : text)?.description || ''
  } catch {
    description = text.split('\n')[0].slice(0, 120)
  }
  if (!description) return null

  const entry: CacheEntry = {
    path: abs,
    description: description.trim(),
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
  return entry
}
