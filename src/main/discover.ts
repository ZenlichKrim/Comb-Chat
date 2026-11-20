/**
 * Looking for things the user did not tell you where to find.
 *
 * Three of the jobs this agent is asked to do start with the same missing fact:
 *   "there is a peak game folder on one of my disks" — where?
 *   "find the studio and start in it"                — is it installed, and where?
 *   "there is a jar for it"                          — which one?
 *
 * The workspace tools answer this only for the open folder and the one folder
 * next to it. That is not where a user keeps Steam, Roblox Studio or a mod build.
 * This module is the systematic answer: a bounded, honest search of the places
 * these things actually live, plus the app registry on Windows so "installed"
 * means installed rather than "maybe under Program Files".
 *
 * Everything here is read-only and bounded by an explicit budget, so a search
 * never becomes the run: it either finds the thing or says where it looked.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec } from 'node:child_process'

export interface FoundEntry {
  path: string
  /** file or dir */
  kind: 'file' | 'dir'
  /** what made it a match: a file name, a folder name, the app registry */
  why: string
  size?: number
}

export interface SearchResult {
  entries: FoundEntry[]
  /** folders actually visited, so the model knows the answer's reach */
  roots: string[]
  /** true when the budget ran out before the search was done */
  truncated: boolean
}

/** Folders that are never a project: skipping them is the difference between 40s and 10 minutes. */
const NEVER = new Set([
  'node_modules',
  '.git',
  '$recycle.bin',
  'system volume information',
  'windows',
  'winsxs',
  'driverstore',
  'appdata/local/temp',
  'proc',
  'sys',
  'dev',
  'snap',
  'var'
])

const pl = process.platform

/** The drives that exist on this machine, without asking the user. */
export async function listDrives(): Promise<string[]> {
  if (pl === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const found: string[] = []
    for (const l of letters) {
      const root = `${l}:\\`
      try {
        await fs.access(root)
        found.push(root)
      } catch {
        /* not mounted */
      }
    }
    return found
  }
  const found: string[] = []
  for (const base of ['/Volumes', '/media', '/mnt', '/run/media']) {
    try {
      const entries = await fs.readdir(base, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory() || e.isSymbolicLink()) found.push(path.join(base, e.name))
      }
    } catch {
      /* not there */
    }
  }
  return ['/', ...found]
}

/** The usual homes for user data on this platform. */
export function homeDirs(): string[] {
  const home = os.homedir()
  const out = [home]
  if (pl === 'win32') {
    for (const rel of ['Desktop', 'Documents', 'Downloads', 'AppData\\Roaming', 'AppData\\Local', 'AppData\\LocalLow', 'Saved Games']) {
      out.push(path.join(home, rel))
    }
    for (const drive of ['D:\\', 'E:\\', 'F:\\']) out.push(drive)
  } else if (pl === 'darwin') {
    for (const rel of ['Desktop', 'Documents', 'Downloads', 'Library/Application Support']) out.push(path.join(home, rel))
  } else {
    for (const rel of ['Desktop', 'Documents', 'Downloads', '.local/share', '.steam/steam/steamapps/common']) out.push(path.join(home, rel))
  }
  return out
}

interface WalkOpts {
  /** stop after roughly this many entries */
  maxEntries?: number
  /** stop after this many milliseconds */
  maxMs?: number
  /** how deep below each start folder */
  depth?: number
  /** only report entries whose name matches */
  nameRe?: RegExp
  /** report files only / dirs only */
  want?: 'file' | 'dir' | 'any'
  /** names to skip besides the built-in list */
  skip?: Set<string>
  /** called for every match; return false to stop the walk */
  onHit?: (entry: FoundEntry) => boolean
}

/**
 * One bounded walk over several start folders.
 *
 * Breadth-first so the shallow, likely answer (a game next to the drive root)
 * is found before the deep unlikely one (a texture cache six levels down).
 */
export async function searchDirs(starts: string[], opts: WalkOpts = {}): Promise<SearchResult & { visited: string[] }> {
  const maxEntries = opts.maxEntries ?? 60000
  const maxMs = opts.maxMs ?? 20000
  const depth = opts.depth ?? 4
  const want = opts.want ?? 'any'
  const skip = opts.skip || new Set<string>()
  const entries: FoundEntry[] = []
  const roots: string[] = []
  const visited: string[] = []
  const started = Date.now()
  let seen = 0
  let truncated = false

  const queue: { dir: string; depth: number }[] = []
  for (const s of starts) {
    const abs = path.resolve(s)
    try {
      const st = await fs.stat(abs)
      if (st.isDirectory()) queue.push({ dir: abs, depth: 0 })
    } catch {
      /* start does not exist */
    }
  }

  while (queue.length) {
    if (seen >= maxEntries || Date.now() - started > maxMs) {
      truncated = true
      break
    }
    const { dir, depth: d } = queue.shift()!
    if (visited.length < 200) visited.push(dir)
    let list
    try {
      list = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    seen += list.length
    for (const e of list) {
      const abs = path.join(dir, e.name)
      const lower = e.name.toLowerCase()
      if (lower.startsWith('.git') || NEVER.has(lower) || skip.has(lower)) continue
      const isDir = e.isDirectory()
      if (isDir && d + 1 > depth) continue
      if (opts.nameRe && opts.nameRe.test(e.name) && (want === 'any' || (want === 'dir') === isDir)) {
        let size: number | undefined
        if (!isDir) size = await fs.stat(abs).then((s) => s.size).catch(() => undefined)
        const hit: FoundEntry = { path: abs, kind: isDir ? 'dir' : 'file', why: e.name, size }
        entries.push(hit)
        if (entries.length > 400) {
          truncated = true
          return { entries, roots, visited, truncated }
        }
        if (opts.onHit && opts.onHit(hit) === false) return { entries, roots, visited, truncated }
      }
      if (isDir) queue.push({ dir: abs, depth: d + 1 })
    }
  }
  return { entries, roots, visited, truncated }
}

/** The matches, grouped so a long answer reads as folders rather than a wall of paths. */
export function renderFound(entries: FoundEntry[], limit = 40): string {
  if (!entries.length) return ''
  const shown = entries.slice(0, limit)
  return shown
    .map((e) => `${e.kind === 'dir' ? 'DIR ' : 'FILE'} ${e.path}${e.size ? ` (${Math.round(e.size / 1024)} KB)` : ''}${e.why && e.why !== path.basename(e.path) ? ` — ${e.why}` : ''}`)
    .join('\n')
}

/**
 * Installed applications, as the system reports them.
 *
 * On Windows this reads the uninstall registry keys — every real install writes
 * there, and the InstallLocation is the folder, which is what a "find the studio
 * and work in it" request needs. Elsewhere it looks for the app bundles and
 * desktop entries that a launched app leaves behind.
 */
export async function installedApps(): Promise<{ name: string; path: string; why: string }[]> {
  const out: { name: string; path: string; why: string }[] = []
  if (pl === 'win32') {
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ]
    for (const key of keys) {
      const raw = await new Promise<string>((resolve) => {
        exec(`reg query "${key}" /s /v InstallLocation`, { maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
          resolve(err ? '' : String(stdout || ''))
        })
      })
      const lines = raw.split(/\r?\n/)
      let currentKey = ''
      let currentName = ''
      for (const line of lines) {
        const keyMatch = /^(HKEY_[^\s].*)$/.exec(line.trim())
        if (keyMatch) {
          currentKey = keyMatch[1]
          const nameMatch = /\\Uninstall\\([^\\]+)$/.exec(currentKey)
          currentName = nameMatch ? nameMatch[1] : ''
          continue
        }
        const locMatch = /InstallLocation\s+REG_\w+\s+(.+)$/i.exec(line.trim())
        if (locMatch?.[1]?.trim()) {
          const loc = locMatch[1].trim().replace(/^"|"$/g, '')
          if (loc) out.push({ name: currentName || path.basename(loc), path: loc, why: 'installed app (registry)' })
        }
      }
    }
  } else if (pl === 'darwin') {
    const res = await searchDirs(['/Applications', path.join(os.homedir(), 'Applications')], {
      want: 'dir',
      depth: 1,
      nameRe: /\.app$/,
      maxEntries: 4000,
      maxMs: 4000
    })
    for (const e of res.entries) out.push({ name: path.basename(e.path, '.app'), path: e.path, why: 'application bundle' })
  } else {
    const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')]
    for (const dir of dirs) {
      const list = await fs.readdir(dir).catch(() => [] as string[])
      for (const f of list) {
        if (!f.endsWith('.desktop')) continue
        const text = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')
        const name = /^Name=(.+)$/m.exec(text)?.[1]?.trim()
        const exe = /^Exec=(.+)$/m.exec(text)?.[1]?.trim()?.split(/\s+/)[0]
        if (name) out.push({ name, path: exe || path.join(dir, f), why: 'desktop entry' })
      }
    }
  }
  return out
}

/** Score how well an app matches what the user called it, so "roblox studio" beats "Roblox Player". */
export function scoreAppMatch(appName: string, query: string): number {
  const a = appName.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const tokens = q.split(/[^a-zа-я0-9]+/i).filter((t) => t.length > 1)
  if (!tokens.length) return 0
  let score = 0
  for (const t of tokens) {
    if (a === t) score += 8
    else if (a.startsWith(t)) score += 5
    else if (a.includes(t)) score += 3
    else if (t.length > 3 && t.slice(0, 4) && a.includes(t.slice(0, 4))) score += 1
  }
  // a full-name hit outranks the sum of the parts
  if (a.includes(q)) score += 4
  return score
}
