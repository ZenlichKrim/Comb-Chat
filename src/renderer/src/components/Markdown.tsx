import React, { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { CodeBlock } from './CodeBlock'

export function Markdown({ text }: { text: string }): React.ReactElement {
  const segments = useMemo(() => renderMarkdown(text), [text])
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = (e.target as HTMLElement).closest('a[data-href]') as HTMLAnchorElement | null
    if (target) {
      e.preventDefault()
      const href = target.getAttribute('data-href') || ''
      if (/^https?:/i.test(href)) window.comb.app.openExternal(href)
    }
  }
  return (
    <div className="md" onClick={onClick}>
      {segments.map((s, i) =>
        s.kind === 'code' ? (
          <CodeBlock key={i} code={s.code || ''} lang={s.lang || 'text'} file={s.file} />
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: s.html || '' }} />
        )
      )}
    </div>
  )
}
