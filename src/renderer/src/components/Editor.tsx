import React, { useEffect, useRef, useState } from 'react'
import { EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, search as cmSearch, openSearchPanel } from '@codemirror/search'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  indentUnit
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { sql } from '@codemirror/lang-sql'
import { php } from '@codemirror/lang-php'
import { xml } from '@codemirror/lang-xml'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { go } from '@codemirror/legacy-modes/mode/go'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { Icon } from './Icon'
import { useStore, useActiveTab } from '../store'
import { useT, tr } from '../lib/i18n'

/* ------------------------------------------------------------------ */
/* Language resolution                                                 */
/* ------------------------------------------------------------------ */

const LEGACY_LANGS: Record<string, any> = { shell, sh: shell, bash: shell, yaml, yml: yaml, toml, ini: toml, go, ruby, lua, docker: dockerFile, dockerfile: dockerFile }

export function languageExtension(lang: string): Extension {
  switch (lang) {
    case 'typescript':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'javascript':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'python':
      return python()
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'html':
    case 'vue':
    case 'svelte':
      return html()
    case 'rust':
      return rust()
    case 'cpp':
    case 'c':
      return cpp()
    case 'java':
    case 'kotlin':
      return java()
    case 'sql':
      return sql()
    case 'php':
      return php()
    case 'xml':
      return xml()
    default:
      return LEGACY_LANGS[lang] ? StreamLanguage.define(LEGACY_LANGS[lang]) : []
  }
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const combHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--fg-4)', fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: 'color-mix(in oklab, #d98fd8 82%, var(--fg-0))' },
  { tag: [t.name, t.deleted, t.character, t.propertyName], color: 'var(--fg-1)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'color-mix(in oklab, #8fc9e0 85%, var(--fg-0))' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'color-mix(in oklab, #e5b567 85%, var(--fg-0))' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--fg-1)' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: 'color-mix(in oklab, #e3c27e 82%, var(--fg-0))' },
  { tag: [t.operator, t.operatorKeyword], color: 'var(--fg-2)' },
  { tag: [t.url, t.escape, t.regexp, t.link], color: 'color-mix(in oklab, #7fd6c9 85%, var(--fg-0))' },
  { tag: [t.meta, t.documentMeta], color: 'var(--fg-3)' },
  { tag: [t.string, t.special(t.string)], color: 'color-mix(in oklab, #b8d98f 82%, var(--fg-0))' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: 'color-mix(in oklab, #e5b567 85%, var(--fg-0))' },
  { tag: [t.processingInstruction, t.inserted], color: 'color-mix(in oklab, #6dcf8a 85%, var(--fg-0))' },
  { tag: [t.tagName], color: 'color-mix(in oklab, #e78a80 85%, var(--fg-0))' },
  { tag: [t.attributeName], color: 'color-mix(in oklab, #8fc9e0 85%, var(--fg-0))' },
  { tag: [t.heading], color: 'var(--fg-0)', fontWeight: '700' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.invalid], color: 'var(--err)' }
])

const combTheme = EditorView.theme({
  '&': {
    color: 'var(--fg-1)',
    backgroundColor: 'var(--bg-1)',
    fontSize: 'var(--fs-md)',
    height: '100%'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: '1.62',
    overflow: 'auto'
  },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklab, var(--accent) 22%, transparent)' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in oklab, var(--accent) 14%, transparent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-1)',
    color: 'var(--fg-4)',
    border: 'none',
    borderRight: '1px solid var(--line-1)',
    paddingLeft: '4px',
    fontSize: 'var(--fs-sm)'
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-2)', color: 'var(--accent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--fg-0) 3.5%, transparent)' },
  '.cm-foldGutter span': { color: 'var(--fg-4)' },
  '.cm-foldPlaceholder': { background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--fg-2)', borderRadius: '3px', padding: '0 4px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 20%, transparent)',
    outline: '1px solid var(--accent-line)',
    color: 'inherit'
  },
  '.cm-nonmatchingBracket': { color: 'var(--err)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-3)',
    border: '1px solid var(--line-3)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow-2)',
    color: 'var(--fg-1)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--fs-sm)'
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--fg-0)' },
  '.cm-searchMatch': { background: 'color-mix(in oklab, var(--warn) 26%, transparent)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch.cm-searchMatch-selected': { background: 'color-mix(in oklab, var(--accent) 38%, transparent)' },
  '.cm-selectionMatch': { background: 'color-mix(in oklab, var(--fg-0) 8%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--fg-1)', borderTop: '1px solid var(--line-2)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line-2)', borderTop: 'none' },
  '.cm-panel input, .cm-panel button': { fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-sm)' },
  '.cm-textfield': { background: 'var(--bg-inset)', border: '1px solid var(--line-2)', borderRadius: '4px', padding: '2px 6px', color: 'var(--fg-0)' },
  '.cm-button': { background: 'var(--bg-3)', border: '1px solid var(--line-2)', borderRadius: '4px', color: 'var(--fg-1)', backgroundImage: 'none', textTransform: 'none', padding: '2px 8px' },
  '.cm-placeholder': { color: 'var(--fg-4)' }
})

/* ------------------------------------------------------------------ */
/* Editor component                                                    */
/* ------------------------------------------------------------------ */

export interface EditorHandle {
  undo(): void
  redo(): void
  find(): void
  focus(): void
  goToLine(line: number): void
  getSelection(): { text: string; from: number; to: number; fromLine: number; toLine: number } | null
}

interface Props {
  value: string
  language: string
  fontSize: number
  showLineNumbers: boolean
  wordWrap: boolean
  tabSize: number
  readOnly?: boolean
  onChange: (value: string) => void
  onSave?: () => void
  onSelectionChange?: (sel: { fromLine: number; toLine: number; empty: boolean }) => void
  handleRef?: React.MutableRefObject<EditorHandle | null>
}

export function CodeEditor({
  value,
  language,
  fontSize,
  showLineNumbers,
  wordWrap,
  tabSize,
  readOnly,
  onChange,
  onSave,
  onSelectionChange,
  handleRef
}: Props): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const changeCb = useRef(onChange)
  const selCb = useRef(onSelectionChange)
  const saveCb = useRef(onSave)
  changeCb.current = onChange
  selCb.current = onSelectionChange
  saveCb.current = onSave
  const langComp = useRef(new Compartment())
  const configComp = useRef(new Compartment())
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 })

  useEffect(() => {
    if (!host.current) return
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) changeCb.current(u.state.doc.toString())
      if (u.selectionSet || u.docChanged) {
        const sel = u.state.selection.main
        const line = u.state.doc.lineAt(sel.head)
        setCursor({ line: line.number, col: sel.head - line.from + 1, sel: Math.abs(sel.to - sel.from) })
        const fromLine = u.state.doc.lineAt(sel.from).number
        const toLine = u.state.doc.lineAt(sel.to).number
        selCb.current?.({ fromLine, toLine, empty: sel.empty })
      }
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        configComp.current.of([
          showLineNumbers ? lineNumbers() : [],
          showLineNumbers ? highlightActiveLineGutter() : [],
          wordWrap ? EditorView.lineWrapping : [],
          EditorState.tabSize.of(tabSize),
          indentUnit.of(' '.repeat(tabSize)),
          EditorView.editable.of(!readOnly)
        ]),
        langComp.current.of(languageExtension(language)),
        history(),
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        highlightActiveLine(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ icons: false, maxRenderedOptions: 24 }),
        foldGutter({ markerDOM: (open) => {
          const el = document.createElement('span')
          el.textContent = open ? '▾' : '▸'
          el.style.opacity = '0.6'
          el.style.fontSize = '9px'
          el.style.cursor = 'pointer'
          return el
        } }),
        highlightSelectionMatches(),
        cmSearch({ top: true }),
        syntaxHighlighting(combHighlight),
        combTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            // keep font size synced via theme
          }
        }),
        updateListener,
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              saveCb.current?.()
              return true
            }
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab
        ])
      ]
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v

    if (handleRef) {
      handleRef.current = {
        undo: () => undo(v),
        redo: () => redo(v),
        find: () => {
          v.focus()
          openSearchPanel(v)
        },
        focus: () => v.focus(),
        goToLine: (line: number) => {
          const l = Math.min(Math.max(1, line), v.state.doc.lines)
          const pos = v.state.doc.line(l).from
          v.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
          v.focus()
        },
        getSelection: () => {
          const s = v.state.selection.main
          if (s.empty) return null
          return {
            text: v.state.sliceDoc(s.from, s.to),
            from: s.from,
            to: s.to,
            fromLine: v.state.doc.lineAt(s.from).number,
            toLine: v.state.doc.lineAt(s.to).number
          }
        }
      }
    }
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly])

  // external value sync (agent edits / checkpoint restore)
  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  // dynamic config
  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({
      effects: configComp.current.reconfigure([
        showLineNumbers ? lineNumbers() : [],
        showLineNumbers ? highlightActiveLineGutter() : [],
        wordWrap ? EditorView.lineWrapping : [],
        EditorState.tabSize.of(tabSize),
        indentUnit.of(' '.repeat(tabSize)),
        EditorView.editable.of(!readOnly)
      ])
    })
  }, [showLineNumbers, wordWrap, tabSize, readOnly])

  return (
    <div className="editor-host" style={{ ['--editor-font-size' as any]: `${fontSize}px` }}>
      <div ref={host} className="cm-host" />
      <div className="editor-status">
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        {cursor.sel > 0 && <span className="acc">{cursor.sel} selected</span>}
        <span className="spacer" />
        <span className="faint">{language}</span>
        <span className="faint">spaces: {tabSize}</span>
        <span className="faint">UTF-8</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Editor tab strip + empty state                                      */
/* ------------------------------------------------------------------ */

export function EditorPane(): React.ReactElement {
  const t = useT()
  const tabs = useStore((s) => s.tabs)
  const activePath = useStore((s) => s.activeTabPath)
  const setActive = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const setContent = useStore((s) => s.setTabContent)
  const saveTab = useStore((s) => s.saveTab)
  const settings = useStore((s) => s.settings)
  const workspace = useStore((s) => s.workspace)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const active = useActiveTab()
  const handleRef = useRef<EditorHandle | null>(null)
  const [selection, setSelection] = useState<{ fromLine: number; toLine: number; empty: boolean } | null>(null)
  const addContextFile = useStore((s) => s.addContextFile)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    const onFind = (): void => handleRef.current?.find()
    const onAttach = (): void => {
      handleRef.current?.focus()
      const sel = handleRef.current?.getSelection()
      const activeTab = useStore.getState().tabs.find((t) => t.path === useStore.getState().activeTabPath)
      if (!sel || !activeTab) {
        useStore.getState().toast('warn', 'Select code in the editor first')
        return
      }
      useStore.getState().addContextFile({
        id: `sel_${Date.now()}`,
        kind: 'selection',
        path: activeTab.path,
        rel: activeTab.rel,
        name: `${activeTab.rel.split('/').pop()}:${sel.fromLine}-${sel.toLine}`,
        content: sel.text,
        from: sel.fromLine,
        to: sel.toLine
      })
      useStore.getState().toast('ok', tr('ed.selectionAttached'))
    }
    window.addEventListener('comb:find-click', onFind)
    window.addEventListener('comb:attach-selection', onAttach)
    return () => {
      window.removeEventListener('comb:find-click', onFind)
      window.removeEventListener('comb:attach-selection', onAttach)
    }
  }, [])

  const attachSelection = (): void => {
    if (!active || !handleRef.current) return
    const sel = handleRef.current.getSelection()
    if (!sel) {
      toast('warn', 'Select some code first')
      return
    }
    addContextFile({
      id: `sel_${Date.now()}`,
      kind: 'selection',
      path: active.path,
      rel: active.rel,
      name: `${active.rel.split('/').pop()}:${sel.fromLine}-${sel.toLine}`,
      content: sel.text,
      from: sel.fromLine,
      to: sel.toLine
    })
    toast('ok', tr('ed.selectionAttached'))
  }

  const attachFile = (): void => {
    if (!active) return
    addContextFile({
      id: `file_${Date.now()}`,
      kind: 'file',
      path: active.path,
      rel: active.rel,
      name: active.rel.split('/').pop() || active.rel,
      content: active.content
    })
    toast('ok', tr('ed.fileAttached'))
  }

  return (
    <div className="editor-pane">
      <div className="tabstrip">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className="tab"
            data-active={tab.path === activePath}
            onClick={() => setActive(tab.path)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(tab.path)
            }}
            title={tab.rel}
          >
            <span className="tab-name">{tab.rel.split('/').pop()}</span>
            {tab.dirty ? (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  void saveTab(tab.path)
                }}
                data-tip="Save"
              >
                <span className="dirty-dot" />
              </button>
            ) : (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.path)
                }}
              >
                <Icon name="close" size={10} />
              </button>
            )}
          </div>
        ))}
        <div className="spacer" />
        {active && (
          <div className="tab-actions">
            <button className="icon-btn" data-tip={t('ed.attachSelection')} onClick={attachSelection}>
              <Icon name="diff" size={12} />
            </button>
            <button className="icon-btn" data-tip={t('ed.attachFile')} onClick={attachFile}>
              <Icon name="file-plus" size={12} />
            </button>
            <button
              className="icon-btn"
              data-tip={t('ed.saveTip')}
              disabled={!active.dirty}
              onClick={() => void saveTab()}
              style={{ opacity: active.dirty ? 1 : 0.4 }}
            >
              <Icon name="save" size={12} />
            </button>
            <button
              className="icon-btn"
              data-tip={t('ed.findTip')}
              onClick={() => {
                window.dispatchEvent(new Event('comb:find-click'))
              }}
            >
              <Icon name="search" size={12} />
            </button>
          </div>
        )}
      </div>

      {active ? (
        <CodeEditor
          key={active.path}
          value={active.content}
          language={active.language}
          fontSize={settings.fontSize}
          showLineNumbers={settings.showLineNumbers}
          wordWrap={settings.wordWrap}
          tabSize={settings.tabSize}
          onChange={(v) => setContent(active.path, v)}
          onSave={() => void saveTab()}
          onSelectionChange={setSelection}
          handleRef={handleRef}
        />
      ) : (
        <EmptyEditor workspace={workspace} onOpen={() => void openWorkspace()} />
      )}
    </div>
  )
}

function EmptyEditor({ workspace, onOpen }: { workspace: string | null; onOpen: () => void }): React.ReactElement {
  const t = useT()
  const shortcuts = [
    ['Ctrl O', t('keys.openFolder')],
    ['Ctrl N', t('keys.newSession')],
    ['Ctrl K', t('keys.palette')],
    ['Ctrl P', t('keys.quickOpen')],
    ['Ctrl B', t('keys.toggleSidebar')],
    ['Ctrl `', t('keys.toggleTerminal')],
    ['Ctrl ,', t('keys.settings')]
  ]
  return (
    <div className="empty-editor">
      <div className="empty-grid">
        <div className="empty-mark">
          <Icon name="bee" size={44} strokeWidth={1.1} />
        </div>
        <h1 className="empty-title">
          Comb<span className="acc">.</span>
        </h1>
        <p className="empty-sub">
          {workspace ? (
            <>
              {t('ed.readyLine1')}
              <br />
              {t('ed.readyLine2')}
            </>
          ) : (
            <>
              {t('ed.noFolderLine1')}
              <br />
              {t('ed.noFolderLine2')}
            </>
          )}
        </p>
        <button className="btn primary" onClick={onOpen} style={{ height: 32, padding: '0 16px' }}>
          <Icon name="folder" size={13} /> {workspace ? t('common.changeFolder') : t('common.openFolder')} <kbd style={{ marginLeft: 4 }}>Ctrl O</kbd>
        </button>
        <div className="empty-keys">
          {shortcuts.map(([k, label]) => (
            <div key={k} className="empty-key">
              <span className="kbd-group">
                {k.split(' ').map((part) => (
                  <kbd key={part}>{part}</kbd>
                ))}
              </span>
              <span className="faint t-xs">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
