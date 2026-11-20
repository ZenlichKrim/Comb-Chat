import { promises as fs, createReadStream, type FSWatcher, watch } from 'node:fs'
import path from 'node:path'
import type { DirEntry, FileContent, SearchHit, FileSearchResult } from '../shared/types'

export const MAX_READ_BYTES = 2 * 1024 * 1024

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'coverage',
  '.idea',
  '.turbo',
  '.parcel-cache',
  '.pytest_cache',
  'vendor',
  '.gradle',
  'bin',
  'obj'
])

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'ini',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'docker',
  makefile: 'makefile',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  txt: 'text',
  lock: 'text',
  gitignore: 'text'
}

export function languageFor(file: string): string {
  const base = path.basename(file).toLowerCase()
  if (base === 'dockerfile') return 'docker'
  if (base === 'makefile') return 'makefile'
  const ext = path.extname(base).replace('.', '')
  return EXT_LANG[ext] || 'text'
}

const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','webp','ico','bmp','pdf','zip','gz','tar','7z','rar','exe','dll','so','dylib','node','woff','woff2','ttf','otf','mp3','mp4','wav','ogg','webm','mov','class','jar','pyc','wasm','bin','db','sqlite',
  // game and editor assets: a texture, a model, a level. Reading them as text
  // produced a page of replacement characters and the agent "analysed" noise.
  'dds','tga','ktx','ktx2','hdr','exr','fbx','glb','gltf','obj','mtl','blend','unity3d','uasset','umap','pak','vpk','bsp','wad','pk3','pk4','rbxm','rbxl','rbxlx','mesh','anim','phys','ttf','otf','skp','stl','dae','psd','aseprite','ase','clip','xcf'
])

export function isProbablyBinary(file: string, head?: Buffer): boolean {
  const ext = path.extname(file).replace('.', '').toLowerCase()
  if (BINARY_EXT.has(ext)) return true
  if (!head) return false
  const sample = head.subarray(0, Math.min(head.length, 4096))
  for (const b of sample) if (b === 0) return true
  return false
}

/** Which kind of picture a file is, for a vision call. Empty when it is not one. */
export function imageMime(file: string): string {
  const ext = path.extname(file).replace('.', '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  return ''
}

/** Join one root, refusing anything that walks out of it. */
function joinInside(root: string, rel: string): string {
  const resolved = path.resolve(root, rel)
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`)
  }
  return resolved
}

/**
 * Resolve a relative path against every attached root.
 *
 * With a single root this is the old sandbox: anything with `..` is refused.
 * With several roots, a path is tried against each one in order, so an agent
 * that needs two checkouts side by side can still be kept inside both.
 * An absolute path is accepted only when it already sits inside a root.
 */
export function safeJoin(root: string | string[], rel: string, allowOutside = false): string {
  const roots = Array.isArray(root) ? root : [root]

  if (path.isAbsolute(rel)) {
    const resolved = path.resolve(rel)
    if (allowOutside) return resolved
    for (const r of roots) {
      const rr = path.resolve(r)
      if (resolved === rr || resolved.startsWith(rr + path.sep)) return resolved
    }
    throw new Error(`Path is outside every open folder: ${rel}`)
  }

  if (!roots.length) {
    if (allowOutside) return path.resolve(rel)
    throw new Error('No workspace is open')
  }
  if (!rel || rel === '.') return path.resolve(roots[0])

  for (const r of roots) {
    const resolved = path.resolve(r, rel)
    const rr = path.resolve(r)
    if (resolved === rr || resolved.startsWith(rr + path.sep)) return resolved
  }
  // Full access: a relative path that climbs out of every root is still a path
  // the user allowed. It resolves against the first root, exactly as a shell
  // would do — otherwise `../project` is refused while `/abs/project` is fine,
  // which is the inconsistency people hit when looking for a folder next door.
  if (allowOutside) return path.resolve(roots[0], rel)
  throw new Error(`Path escapes workspace: ${rel}`)
}

/** Which root a path belongs to, longest match first (nested folders). */
export function rootOf(roots: string | string[], p: string): string {
  const list = (Array.isArray(roots) ? roots : [roots]).map((r) => path.resolve(r))
  const abs = path.resolve(p)
  let best = ''
  for (const r of list) {
    if ((abs === r || abs.startsWith(r + path.sep)) && r.length > best.length) best = r
  }
  return best || path.resolve(list[0] || '')
}

/** Path relative to the nearest root it belongs to. */
export function toRel(root: string | string[], p: string): string {
  const base = Array.isArray(root) ? rootOf(root, p) : root
  const rel = path.relative(path.resolve(base), path.resolve(p))
  return rel.split(path.sep).join('/')
}

export async function listDir(dir: string, root?: string | string[]): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const base: string | string[] = root || dir
  const out: DirEntry[] = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name)
      let size = 0
      let mtime = 0
      try {
        const st = await fs.stat(full)
        size = st.size
        mtime = st.mtimeMs
      } catch {
        /* broken symlinks */
      }
      return {
        name: e.name,
        path: full,
        rel: toRel(base, full),
        isDir: e.isDirectory(),
        size,
        mtime,
        ignored: e.isDirectory() ? IGNORED_DIRS.has(e.name) : false
      }
    })
  )
  return out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
}

/** Read an image (or any small binary) as a data: URL the API can consume. */
export async function readImageDataUrl(file: string, maxBytes = 20 * 1024 * 1024): Promise<string | null> {
  const st = await fs.stat(file)
  if (st.isDirectory()) throw new Error('Path is a directory')
  if (st.size > maxBytes) throw new Error(`Image is too large (${Math.round(st.size / 1024 / 1024)} MB, limit ${maxBytes / 1024 / 1024} MB)`)
  const ext = path.extname(file).toLowerCase()
  const mime =
    ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : null
  if (!mime) return null
  const buf = await fs.readFile(file)
  return `data:${mime};base64,${buf.toString('base64')}`
}

export async function readFileSafe(file: string, root?: string | string[]): Promise<FileContent> {
  const st = await fs.stat(file)
  if (st.isDirectory()) throw new Error('Path is a directory')
  const handle = await fs.open(file, 'r')
  try {
    const len = Math.min(st.size, MAX_READ_BYTES)
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, 0)
    if (isProbablyBinary(file, buf)) {
      return {
        path: file,
        rel: root ? toRel(root, file) : path.basename(file),
        content: '',
        language: 'binary',
        size: st.size,
        mtime: st.mtimeMs
      }
    }
    return {
      path: file,
      rel: root ? toRel(root, file) : path.basename(file),
      content: buf.toString('utf8'),
      language: languageFor(file),
      size: st.size,
      mtime: st.mtimeMs,
      truncated: st.size > MAX_READ_BYTES
    }
  } finally {
    await handle.close()
  }
}

export async function writeFileSafe(file: string, content: string): Promise<{ size: number; mtime: number }> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
  const st = await fs.stat(file)
  return { size: st.size, mtime: st.mtimeMs }
}

export async function walk(
  root: string,
  opts: { maxFiles?: number; depth?: number; includeIgnored?: boolean } = {}
): Promise<string[]> {
  const maxFiles = opts.maxFiles ?? 20000
  const maxDepth = opts.depth ?? 14
  const out: string[] = []
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.git') || e.name === '.DS_Store') continue
      if (e.isDirectory()) {
        if (!opts.includeIgnored && IGNORED_DIRS.has(e.name)) continue
        if (depth + 1 > maxDepth) continue
        stack.push({ dir: path.join(dir, e.name), depth: depth + 1 })
      } else if (e.isFile()) {
        out.push(path.join(dir, e.name))
        if (out.length >= maxFiles) break
      }
    }
  }
  return out
}

export async function searchText(
  root: string,
  query: string,
  opts: { regex?: boolean; caseSensitive?: boolean; max?: number; glob?: string } = {}
): Promise<SearchHit[]> {
  const max = opts.max ?? 200
  const hits: SearchHit[] = []
  let re: RegExp
  try {
    const flags = opts.caseSensitive ? 'g' : 'gi'
    re = opts.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  } catch {
    return []
  }
  const files = await walk(root, { maxFiles: 8000 })
  for (const f of files) {
    if (hits.length >= max) break
    if (opts.glob && !f.toLowerCase().includes(opts.glob.toLowerCase())) continue
    if (isProbablyBinary(f)) continue
    let st
    try {
      st = await fs.stat(f)
    } catch {
      continue
    }
    if (st.size > 1024 * 1024) continue
    let text: string
    try {
      text = await fs.readFile(f, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      const m = re.exec(lines[i])
      if (m) {
        hits.push({
          path: f,
          rel: toRel(root, f),
          line: i + 1,
          column: m.index + 1,
          text: lines[i].slice(0, 400)
        })
        if (hits.length >= max) break
      }
    }
  }
  return hits
}

export async function findFiles(root: string, query: string, opts: { max?: number } = {}): Promise<FileSearchResult[]> {
  const max = opts.max ?? 200
  const q = query.toLowerCase()
  const files = await walk(root, { maxFiles: 15000 })
  const scored: { rel: string; score: number; path: string }[] = []
  for (const f of files) {
    const rel = toRel(root, f)
    const lower = rel.toLowerCase()
    const name = path.basename(lower)
    let score = -1
    if (!q) score = 0
    else if (name === q) score = 1000
    else if (name.startsWith(q)) score = 800 - name.length
    else if (name.includes(q)) score = 600 - name.length
    else if (lower.includes(q)) score = 300 - rel.length
    if (score >= 0) scored.push({ rel, score, path: f })
  }
  scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
  return scored.slice(0, max).map((s) => ({ path: s.path, rel: s.rel }))
}

/* ------------------------------------------------------------------ */
/* Watching                                                            */
/* ------------------------------------------------------------------ */

const watchers = new Map<string, FSWatcher>()
const watchRoots = new Map<string, { root: string; onChange: (root: string, paths: string[]) => void }>()

export function watchRoot(root: string, id: string, onChange: (root: string, paths: string[]) => void): void {
  unwatchRoot(id)
  watchRoots.set(id, { root, onChange })
  try {
    const w = watch(root, { recursive: true, persistent: false }, (_evt, file) => {
      if (!file) return
      const parts = String(file).split(path.sep)
      if (parts.some((p) => IGNORED_DIRS.has(p))) return
      onChange(root, [String(file)])
    })
    w.on('error', () => {})
    watchers.set(id, w)
  } catch {
    /* recursive watch unsupported on some platforms for large trees */
  }
}

export function unwatchRoot(id: string): void {
  const w = watchers.get(id)
  if (w) {
    try {
      w.close()
    } catch {
      /* noop */
    }
    watchers.delete(id)
  }
  watchRoots.delete(id)
}
