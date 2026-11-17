import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Settings, type Thread, type Checkpoint } from '../shared/types'

const DEFAULTS = DEFAULT_SETTINGS

function dataDir(): string {
  return app.getPath('userData')
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return { ...fallback, ...(JSON.parse(raw) as object) } as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

let settingsCache: Settings | null = null
const listeners = new Set<(s: Settings) => void>()

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache
  const file = path.join(dataDir(), 'settings.json')
  const existed = await fs
    .access(file)
    .then(() => true)
    .catch(() => false)
  const stored = await readJson<Settings>(file, DEFAULTS)
  // merge defaults for keys added in later versions
  settingsCache = { ...DEFAULTS, ...stored }
  // arrays must not be frozen references to DEFAULTS: patching one grant would
  // otherwise mutate the defaults for the whole process
  settingsCache.allowedTools = [...(stored.allowedTools || DEFAULTS.allowedTools)]
  settingsCache.extraRoots = [...(stored.extraRoots || DEFAULTS.extraRoots)]
  settingsCache.recentWorkspaces = [...(stored.recentWorkspaces || [])]
  // deepseek-chat / deepseek-reasoner were retired by the API on 2026-07-24
  const legacy: Record<string, string> = {
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-flash-thinking',
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash'
  }
  if (legacy[settingsCache.model]) settingsCache = { ...settingsCache, model: legacy[settingsCache.model] }
  // First run: follow the OS language so a Russian system opens in Russian.
  if (!existed) {
    const lang = (app.getLocale?.() || process.env.LANG || 'en').toLowerCase()
    if (lang.startsWith('ru')) settingsCache = { ...settingsCache, locale: 'ru' }
  }
  return settingsCache
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const next = { ...current, ...patch }
  // keep recents tidy
  if (patch.lastWorkspace) {
    const recents = [patch.lastWorkspace, ...(next.recentWorkspaces || []).filter((p) => p !== patch.lastWorkspace)].slice(0, 8)
    next.recentWorkspaces = recents
  }
  settingsCache = next
  await writeJson(path.join(dataDir(), 'settings.json'), next)
  for (const fn of listeners) fn(next)
  return next
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/* ------------------------------------------------------------------ */
/* Threads                                                             */
/* ------------------------------------------------------------------ */

function threadsFile(): string {
  return path.join(dataDir(), 'threads.json')
}

let threadsCache: Thread[] | null = null

export async function listThreads(): Promise<Thread[]> {
  if (threadsCache) return threadsCache
  try {
    const raw = await fs.readFile(threadsFile(), 'utf8')
    threadsCache = JSON.parse(raw) as Thread[]
  } catch {
    threadsCache = []
  }
  return threadsCache
}

export async function saveThread(thread: Thread): Promise<void> {
  const all = await listThreads()
  const idx = all.findIndex((t) => t.id === thread.id)
  if (idx >= 0) all[idx] = thread
  else all.unshift(thread)
  // cap history to keep the file fast
  const trimmed = all
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 300)
    .map((t) => ({ ...t, messages: t.messages.slice(-120) }))
  threadsCache = trimmed
  await writeJson(threadsFile(), trimmed)
}

export async function deleteThread(id: string): Promise<void> {
  const all = await listThreads()
  threadsCache = all.filter((t) => t.id !== id)
  await writeJson(threadsFile(), threadsCache)
}

export async function clearThreads(): Promise<void> {
  threadsCache = []
  await writeJson(threadsFile(), [])
}

/* ------------------------------------------------------------------ */
/* Checkpoints                                                         */
/* ------------------------------------------------------------------ */

function checkpointsDir(): string {
  return path.join(dataDir(), 'checkpoints')
}

export async function listCheckpoints(threadId: string): Promise<Checkpoint[]> {
  const dir = checkpointsDir()
  await ensureDir(dir)
  const out: Checkpoint[] = []
  const files = await fs.readdir(dir).catch(() => [] as string[])
  for (const f of files) {
    if (!f.startsWith(`${threadId}__`)) continue
    try {
      const cp = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Checkpoint
      out.push(cp)
    } catch {
      /* ignore corrupt */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  const dir = checkpointsDir()
  await ensureDir(dir)
  await writeJson(path.join(dir, `${cp.threadId}__${cp.id}.json`), cp)
}

export async function getCheckpoint(id: string): Promise<Checkpoint | null> {
  const dir = checkpointsDir()
  const files = await fs.readdir(dir).catch(() => [] as string[])
  for (const f of files) {
    if (!f.endsWith(`${id}.json`)) continue
    try {
      return JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Checkpoint
    } catch {
      return null
    }
  }
  return null
}

export { dataDir }
