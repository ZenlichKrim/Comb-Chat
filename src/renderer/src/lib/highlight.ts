/**
 * Tiny, fast, dependency-free syntax highlighter.
 * Produces HTML with <span class="tok-*"> tokens. Tuned for code review density,
 * not for perfect grammar coverage — every language falls back to a generic
 * C-like tokenizer which handles most code well.
 */

export type Lang = string

const KEYWORDS: Record<string, string[]> = {
  js: ['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','class','extends','super','this','typeof','instanceof','in','of','delete','void','yield','await','async','import','export','default','from','as','try','catch','finally','throw','null','undefined','true','false','static','get','set','enum'],
  ts: ['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','class','extends','implements','interface','type','enum','namespace','declare','abstract','public','private','protected','readonly','this','typeof','keyof','as','in','of','delete','void','yield','await','async','import','export','default','from','try','catch','finally','throw','null','undefined','true','false','static','get','set','satisfies','infer','never','unknown','any'],
  python: ['def','class','return','if','elif','else','for','while','break','continue','import','from','as','try','except','finally','raise','with','lambda','yield','async','await','pass','global','nonlocal','assert','del','in','is','not','and','or','None','True','False','self','print'],
  rust: ['fn','let','mut','const','struct','enum','impl','trait','for','while','loop','if','else','match','return','use','mod','pub','crate','as','where','async','await','move','ref','dyn','unsafe','type','in','Self','self','true','false','break','continue','extern'],
  go: ['func','package','import','var','const','type','struct','interface','map','chan','go','defer','select','case','default','switch','for','range','if','else','return','break','continue','nil','true','false','string','int','int64','float64','bool','byte','rune','error'],
  java: ['public','private','protected','class','interface','enum','extends','implements','static','final','abstract','void','new','return','if','else','for','while','do','switch','case','break','continue','try','catch','finally','throw','throws','import','package','this','super','null','true','false','int','long','double','float','boolean','char','String','var','record','synchronized'],
  c: ['int','char','float','double','void','long','short','unsigned','signed','struct','enum','union','typedef','const','static','extern','if','else','for','while','do','switch','case','break','continue','return','sizeof','goto','NULL'],
  cpp: ['int','char','float','double','void','long','short','unsigned','signed','struct','class','enum','union','typedef','const','constexpr','static','extern','namespace','using','template','typename','public','private','protected','virtual','override','new','delete','this','nullptr','auto','if','else','for','while','do','switch','case','break','continue','return','sizeof','true','false','inline'],
  cs: ['public','private','protected','internal','class','interface','struct','enum','namespace','using','static','readonly','const','void','var','new','return','if','else','for','foreach','while','switch','case','break','continue','try','catch','finally','throw','async','await','this','base','null','true','false','string','int','bool','double','decimal','record'],
  php: ['function','class','public','private','protected','static','return','if','else','elseif','foreach','for','while','switch','case','break','continue','new','echo','print','use','namespace','try','catch','finally','throw','null','true','false','array','$this','extends','implements','interface','abstract','const','as','fn','match'],
  ruby: ['def','class','module','end','if','elsif','else','unless','while','until','for','do','return','yield','begin','rescue','ensure','raise','require','attr_accessor','nil','true','false','self','and','or','not','then','puts'],
  swift: ['func','class','struct','enum','protocol','extension','var','let','if','else','guard','for','while','repeat','switch','case','break','continue','return','import','init','self','super','nil','true','false','async','await','throws','try','public','private','static'],
  kotlin: ['fun','val','var','class','object','interface','enum','if','else','when','for','while','do','return','break','continue','import','package','is','in','as','null','true','false','data','sealed','override','open','private','public','suspend'],
  sql: ['SELECT','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','OUTER','ON','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','ALTER','DROP','INDEX','VIEW','PRIMARY','KEY','FOREIGN','REFERENCES','NOT','NULL','DEFAULT','AND','OR','IN','AS','DISTINCT','UNION','ALL','CASE','WHEN','THEN','ELSE','END','COUNT','SUM','AVG','MIN','MAX','WITH','RETURNING','ASC','DESC','EXISTS','BETWEEN','LIKE'],
  sh: ['if','then','else','elif','fi','for','in','do','done','while','until','case','esac','function','return','exit','local','export','source','echo','cd','set','unset','test','read'],
  css: ['color','background','background-color','margin','padding','display','flex','grid','position','border','font','font-size','width','height','top','left','right','bottom','transform','transition','animation','opacity','z-index','overflow','content','gap','align-items','justify-content','box-shadow','border-radius','cursor','pointer-events','user-select','font-family','font-weight','line-height','text-align','color'],
  yaml: ['true','false','null','yes','no'],
  json: ['true','false','null'],
  toml: ['true','false'],
  go2: []
}

const KW_ALIASES: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  typescript: 'ts',
  tsx: 'ts',
  mjs: 'js',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  csharp: 'c',
  'c#': 'c',
  shell: 'sh',
  bash: 'sh',
  zsh: 'sh',
  powershell: 'sh',
  ps1: 'sh',
  scss: 'css',
  less: 'css',
  markdown: 'md',
  md: 'md',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  svelte: 'html',
  yml: 'yaml',
  docker: 'sh',
  dockerfile: 'sh',
  makefile: 'sh',
  ini: 'toml',
  text: 'text',
  plain: 'text',
  binary: 'text'
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function wrap(kind: string, text: string): string {
  return `<span class="tok-${kind}">${esc(text)}</span>`
}

const IDENT_START = /[A-Za-z_$@\u0400-\u04FF]/
const IDENT = /[A-Za-z0-9_$@\u0400-\u04FF]/

/** Highlight a single line (no multi-line state; string state is handled per line conservatively). */
export function highlightLine(line: string, langIn: string): string {
  const lang = KW_ALIASES[langIn] || langIn || 'text'
  if (lang === 'text' || !line) return esc(line)

  if (lang === 'md') return highlightMarkdown(line)
  if (lang === 'html') return highlightMarkup(line)
  if (lang === 'yaml' || lang === 'toml') return highlightConfig(line, lang)
  if (lang === 'json') return highlightJson(line)
  if (lang === 'css') return highlightCss(line)

  const kws = new Set(KEYWORDS[lang] || KEYWORDS.js)
  const ciKeywords = lang === 'sql'
  let out = ''
  let i = 0
  const n = line.length

  while (i < n) {
    const ch = line[i]

    // comments: //, --, #
    if ((ch === '/' && line[i + 1] === '/') || (ch === '#' && lang !== 'css') || (ch === '-' && line[i + 1] === '-' && lang === 'sql')) {
      out += wrap('com', line.slice(i))
      break
    }
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += wrap('com', line.slice(i, stop))
      i = stop
      continue
    }
    // strings
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n) {
        if (line[j] === '\\') {
          j += 2
          continue
        }
        if (line[j] === ch) {
          j++
          break
        }
        j++
      }
      out += wrap('str', line.slice(i, j))
      i = j
      continue
    }
    // numbers
    if (/[0-9]/.test(ch) && !IDENT.test(line[i - 1] || '')) {
      let j = i
      while (j < n && /[0-9a-fA-FxXoObB_.]/.test(line[j])) j++
      out += wrap('num', line.slice(i, j))
      i = j
      continue
    }
    // identifiers / keywords
    if (IDENT_START.test(ch)) {
      let j = i
      while (j < n && IDENT.test(line[j])) j++
      const word = line.slice(i, j)
      const probe = ciKeywords ? word.toUpperCase() : word
      const isType = /^[A-Z][a-zA-Z0-9_]*$/.test(word) && word.length > 1
      const next = line.slice(j).match(/^\s*\(/)
      if (kws.has(probe) || kws.has(word)) out += wrap('kw', word)
      else if (next) out += wrap('fn', word)
      else if (isType) out += wrap('type', word)
      else if (/^(true|false|null|None|True|False|nil|undefined)$/.test(word)) out += wrap('num', word)
      else out += esc(word)
      i = j
      continue
    }
    if (/[=+\-*/%<>!&|^~?:]/.test(ch)) {
      let j = i
      while (j < n && /[=+\-*/%<>!&|^~?:]/.test(line[j])) j++
      out += wrap('op', line.slice(i, j))
      i = j
      continue
    }
    if (/[{}()[\];,.]/.test(ch)) {
      out += wrap('punc', ch)
      i++
      continue
    }
    out += esc(ch)
    i++
  }
  return out
}

function highlightJson(line: string): string {
  return line.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\/\/.*)$/g,
    (m, str, colon, lit, num, com) => {
      if (com) return wrap('com', com)
      if (str) return wrap(colon ? 'attr' : 'str', str) + (colon ? wrap('punc', colon) : '')
      if (lit) return wrap('kw', lit)
      if (num) return wrap('num', num)
      return esc(m)
    }
  )
}

function highlightConfig(line: string, lang: string): string {
  const m = line.match(/^(\s*)([\w.-]+)(\s*[:=])(.*)$/)
  if (m) {
    const [, ws, key, eq, rest] = m
    const value = rest.trim()
    const isComment = value.startsWith('#')
    return (
      esc(ws) +
      wrap('attr', key) +
      wrap('op', eq) +
      (isComment ? wrap('com', rest) : rest ? wrap(value === 'true' || value === 'false' || value === 'null' ? 'kw' : 'str', rest) : '')
    )
  }
  if (line.trim().startsWith('#')) return wrap('com', line)
  if (/^\s*-\s/.test(line)) return line.replace(/^(\s*-\s)(.*)$/, (_m, d, rest) => wrap('op', d) + esc(rest))
  return esc(line)
}

function highlightMarkdown(line: string): string {
  if (/^\s*#{1,6}\s/.test(line)) return wrap('kw', line)
  if (/^\s*```/.test(line)) return wrap('punc', line)
  if (/^\s*[-*+]\s/.test(line)) return line.replace(/^(\s*)([-*+]\s)/, (_m, a, b) => a + wrap('op', b))
  if (/^\s*>/.test(line)) return wrap('com', line)
  return line
    .replace(/(`[^`]+`)/g, (m) => wrap('str', m))
    .replace(/(\*\*[^*]+\*\*)/g, (m) => wrap('type', m))
    .replace(/(\[[^\]]+\]\([^)]+\))/g, (m) => wrap('fn', m))
}

function highlightCss(line: string): string {
  if (/^\s*\/\*/.test(line)) return wrap('com', line)
  const m = line.match(/^(\s*)([-a-zA-Z]+)(\s*:\s*)(.*?)(;?)$/)
  if (m) return esc(m[1]) + wrap('attr', m[2]) + wrap('punc', m[3]) + highlightGenericValue(m[4]) + wrap('punc', m[5])
  if (/[{}]/.test(line)) return line.replace(/([^{}]+)([{}])/g, (_m, sel, br) => wrap('tag', sel) + wrap('punc', br))
  return esc(line)
}

function highlightGenericValue(v: string): string {
  return v
    .split(/("[^"]*"|'[^']*'|#[0-9a-fA-F]{3,8}|\b\d+(?:\.\d+)?[a-z%]*\b)/g)
    .map((part) =>
      !part ? '' : /^["']/.test(part) ? wrap('str', part) : /^#/.test(part) ? wrap('num', part) : /^\d/.test(part) ? wrap('num', part) : esc(part)
    )
    .join('')
}

function highlightMarkup(line: string): string {
  return line
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, (m) => wrap('com', m))
    .replace(/(<!--[\s\S]*?-->)/g, (m) => wrap('com', m))
    .split(/(<[^>]*>)/g)
    .map((chunk) => {
      if (!chunk.startsWith('<')) return esc(chunk)
      return chunk
        .replace(/^(<\/?)([\w:-]+)/, (_m, br, tag) => wrap('punc', br) + wrap('tag', tag))
        .replace(/\s([\w:-]+)(=)/g, (_m, a, eq) => ' ' + wrap('attr', a) + wrap('op', eq))
        .replace(/(&gt;|>)$/, (m) => wrap('punc', m))
    })
    .join('')
}

/** Split source into lines for rendering with numbers. */
export function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function highlightBlock(code: string, lang: string): string[] {
  return lines(code).map((l) => highlightLine(l, lang))
}
