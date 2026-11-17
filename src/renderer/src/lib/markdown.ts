import { highlightLine, lines } from './highlight'

export interface MdToken {
  type: 'block'
  html: string
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(text: string): string {
  let s = text
  // protect code spans
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = esc(s)
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="#" data-href="${url}">${label}</a>`
  })
  // bare urls
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (_m, pre, url) => `${pre}<a href="#" data-href="${url}">${url}</a>`)
  // bold / italic / strike
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // inline code restore — code spans that look like a file reference become
  // clickable links into the workspace (`src/app.ts:42`, `lib/x.ts`)
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const raw = codes[Number(i)] || ''
    const ref = parseFileRef(raw)
    if (!ref) return `<code>${esc(raw)}</code>`
    return `<a href="#" class="code-ref" data-file="${esc(ref.file)}" data-line="${ref.line || ''}" title="${esc(raw)}"><code>${esc(raw)}</code></a>`
  })
  return s
}

/**
 * `src/api/auth.ts:42`, `src/api/auth.ts:12-30`, `./lib/x.ts` → file + line.
 * Deliberately strict: needs a slash or a known source extension, so ordinary
 * inline code like `Map` or `pnpm test` stays plain.
 */
export function parseFileRef(raw: string): { file: string; line?: number } | null {
  const m = /^([\w./@-]+?\.[a-z0-9]{1,6})(?::(\d+)(?:-(\d+))?)?$/i.exec(raw.trim())
  if (!m) return null
  const file = m[1]
  if (/^https?:/i.test(file)) return null
  const hasSlash = file.includes('/')
  const knownExt = /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|cs|cpp|cc|c|h|hpp|json|ya?ml|toml|css|scss|html|md|sh|sql|php|lua|dart|vue|svelte)$/i.test(file)
  if (!hasSlash && !knownExt) return null
  // avoid matching things like "e.g.ts" or version strings
  if (/^\d+\.\d+/.test(file)) return null
  return { file: file.replace(/^\.\//, ''), line: m[2] ? Number(m[2]) : undefined }
}

export interface Segment {
  kind: 'html' | 'code'
  html?: string
  code?: string
  lang?: string
  file?: string
}

/**
 * Minimal streaming-safe markdown renderer: returns segments so the React
 * layer can mount real code-block components (with copy buttons) for fences.
 */
export function renderMarkdown(text: string): Segment[] {
  const out: Segment[] = []
  const src = text.replace(/\r\n/g, '\n')
  const fenceRe = /(^|\n)([ \t]*)(```+|~~~+)([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\3[ \t]*(?=\n|$)|\n?$)/g
  let last = 0
  let m: RegExpExecArray | null
  const pushHtml = (chunk: string): void => {
    if (!chunk.trim()) return
    out.push({ kind: 'html', html: blockHtml(chunk) })
  }
  while ((m = fenceRe.exec(src))) {
    const before = src.slice(last, m.index + (m[1] ? m[1].length : 0))
    pushHtml(before)
    const info = (m[4] || '').trim()
    const [langRaw, ...rest] = info.split(/\s+/)
    const fileMatch = info.match(/(?:title|file|path)="?([^"\s]+)"?/)
    out.push({
      kind: 'code',
      code: m[5].replace(/\n$/, ''),
      lang: (langRaw || 'text').toLowerCase(),
      file: fileMatch?.[1] || rest.find((r) => /[./]/.test(r))
    })
    last = m.index + m[0].length
  }
  pushHtml(src.slice(last))
  return out
}

function blockHtml(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  const blocks = text.split(/\n{2,}/)
  return blocks
    .map((block) => {
      const b = block.trim()
      if (!b) return ''
      // headings
      const h = b.match(/^(#{1,6})\s+(.*)$/)
      if (h) {
        const level = Math.min(h[1].length, 4)
        return `<h${level}>${inline(h[2])}</h${level}>`
      }
      // hr
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(b)) return '<hr/>'
      // blockquote
      if (/^>\s?/.test(b)) {
        const inner = b
          .split('\n')
          .map((l) => l.replace(/^>\s?/, ''))
          .join('\n')
        return `<blockquote>${inline(inner).replace(/\n/g, '<br/>')}</blockquote>`
      }
      // table
      if (/^\|.*\|/.test(b) && b.includes('\n')) {
        const rows = b.split('\n').filter((l) => l.trim().startsWith('|'))
        if (rows.length >= 2 && /^\|?[\s:-]+\|/.test(rows[1])) {
          const cells = (r: string): string[] =>
            r
              .trim()
              .replace(/^\|/, '')
              .replace(/\|$/, '')
              .split('|')
              .map((c) => c.trim())
          const head = cells(rows[0])
          const body = rows.slice(2).map(cells)
          return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`
        }
      }
      // ordered list
      if (/^\d+[.)]\s/.test(b)) {
        const items = b.split(/\n(?=\d+[.)]\s)/).map((l) => l.replace(/^\d+[.)]\s/, ''))
        return `<ol>${items.map((i) => `<li>${inline(i).replace(/\n/g, ' ')}</li>`).join('')}</ol>`
      }
      // unordered list
      if (/^[-*+]\s/.test(b)) {
        const items = b.split(/\n(?=[-*+]\s)/).map((l) => l.replace(/^[-*+]\s/, ''))
        return `<ul>${items
          .map((i) => `<li>${inline(i.replace(/\n\s{2,}/g, '<br/>')).replace(/\n/g, ' ')}</li>`)
          .join('')}</ul>`
      }
      // paragraph
      return `<p>${inline(b).replace(/\n/g, '<br/>')}</p>`
    })
    .join('')
}

export function codeToHtml(code: string, lang: string): string {
  return lines(code).map((l) => highlightLine(l, lang)).join('\n')
}
