import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useStore } from '../store'
import type { StickyNote } from '../../../shared/types'
import { useT } from '../lib/i18n'

/** The six pastel slots a note can live in. Kept apart from the theme so a board
 *  of notes reads as a board, not as another surface of the IDE. */
const TONES = ['butter', 'mint', 'sky', 'lilac', 'peach', 'rose']

/**
 * Little square tile with a plus: the place to write a note about a file the user
 * just attached ("не трогай, это сгенерировано"). Sits inside the context chip so
 * the note is attached to that exact file, not to the whole chat.
 */
export function NotePin({ target, label }: { target?: string; label?: string }): React.ReactElement {
  const t = useT()
  const addNote = useStore((s) => s.addNote)
  const notes = useStore((s) => s.notes)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const existing = notes.filter((n) => n.target === target && n.status !== 'done')

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const save = (): void => {
    if (!text.trim()) return setOpen(false)
    addNote({ text, target, targetLabel: label || target })
    setText('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button
        className="note-pin"
        data-has={existing.length > 0}
        data-tip={target ? t('note.pinFileTip', { name: label || target }) : t('note.pinTip')}
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" size={8} strokeWidth={2.4} />
        {existing.length > 0 && <span className="note-pin-dot" />}
      </button>
    )
  }

  return (
    <div className="note-pop" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <div className="note-pop-head">
        <Icon name="sticky" size={11} className="acc" />
        <span>{target ? t('note.forFile', { name: label || target }) : t('note.new')}</span>
      </div>
      <textarea
        ref={inputRef as unknown as React.RefObject<HTMLTextAreaElement>}
        className="note-pop-input"
        rows={2}
        value={text}
        placeholder={t('note.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          }
        }}
      />
      <div className="note-pop-actions">
        <button className="btn ghost sm" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
        <button className="btn primary sm" onClick={save} disabled={!text.trim()}>
          {t('note.save')}
        </button>
      </div>
    </div>
  )
}

/** One note: rounded square, colour slot, tiny actions on hover. */
export function NoteTile({
  note,
  onEdit,
  compact
}: {
  note: StickyNote
  onEdit?: () => void
  compact?: boolean
}): React.ReactElement {
  const t = useT()
  const updateNote = useStore((s) => s.updateNote)
  const removeNote = useStore((s) => s.removeNote)
  const openFile = useStore((s) => s.openFile)
  const workspace = useStore((s) => s.workspace)

  return (
    <div
      className={`note-tile tone-${TONES[note.tone % TONES.length]}`}
      data-status={note.status}
      data-compact={!!compact}
    >
      <div className="note-tile-head">
        <Icon name={note.byAgent ? 'bee' : 'sticky'} size={9} />
        {note.target && (
          <button
            className="note-target ellipsis"
            title={note.target}
            onClick={() => {
              if (!workspace) return
              const abs = note.target!.startsWith('/') || /^[A-Za-z]:/.test(note.target!)
                ? note.target!
                : `${workspace.replace(/\\/g, '/')}/${note.target}`
              void openFile(abs, note.target!)
            }}
          >
            {note.targetLabel || note.target.split(/[\\/]/).pop()}
          </button>
        )}
        <span className="spacer" />
        {note.status !== 'sent' && (
          <button
            className="note-mini"
            data-tip={t('note.doneTip')}
            onClick={() => updateNote(note.id, { status: note.status === 'done' ? 'pending' : 'done' })}
          >
            <Icon name="check" size={9} />
          </button>
        )}
        <button className="note-mini" data-tip={t('note.editTip')} onClick={onEdit}>
          <Icon name="edit" size={9} />
        </button>
        <button className="note-mini" data-tip={t('common.delete')} onClick={() => removeNote(note.id)}>
          <Icon name="close" size={9} />
        </button>
      </div>
      <div className="note-text selectable">{note.text}</div>
      {!note.byAgent && (
        <div className="note-state">
          <Icon name={note.status === 'sent' ? 'arrow-right' : note.status === 'done' ? 'check' : 'clock'} size={8} />
          {note.status === 'sent' ? t('note.stateSent') : note.status === 'done' ? t('note.stateDone') : t('note.statePending')}
        </div>
      )}
    </div>
  )
}

/** The board itself: opens over the chat, colours make it readable at a glance. */
export function NotesPanel(): React.ReactElement | null {
  const t = useT()
  const open = useStore((s) => s.notesOpen)
  const setOpen = useStore((s) => s.setNotesOpen)
  const notes = useStore((s) => s.notes)
  const addNote = useStore((s) => s.addNote)
  const updateNote = useStore((s) => s.updateNote)
  const running = useStore((s) => s.running)
  const [draft, setDraft] = useState('')
  const [tone, setTone] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)

  if (!open) return null
  const active = notes.filter((n) => n.status !== 'done')
  const done = notes.filter((n) => n.status === 'done')

  const submit = (): void => {
    if (!draft.trim()) return
    if (editing) {
      updateNote(editing, { text: draft.trim() })
      setEditing(null)
    } else {
      addNote({ text: draft, tone })
      setTone((tone + 1) % TONES.length)
    }
    setDraft('')
  }

  return (
    <div className="notes-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="notes-panel">
        <div className="notes-head">
          <Icon name="sticky" size={14} className="acc" />
          <span className="notes-title">{t('note.board')}</span>
          <span className="t-xs faint">{running ? t('note.boardHintLive') : t('note.boardHint')}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setOpen(false)}>
            <Icon name="close" size={11} />
          </button>
        </div>

        <div className="notes-compose">
          <div className="note-palette">
            {TONES.map((tn, i) => (
              <button
                key={tn}
                className={`note-swatch tone-${tn}`}
                data-active={tone === i}
                onClick={() => setTone(i)}
                data-tip={t('note.colour')}
              />
            ))}
          </div>
          <textarea
            className="notes-input"
            rows={2}
            value={draft}
            placeholder={t('note.placeholderLong')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="notes-compose-actions">
            {editing && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  setEditing(null)
                  setDraft('')
                }}
              >
                {t('common.cancel')}
              </button>
            )}
            <button className="btn primary sm" onClick={submit} disabled={!draft.trim()}>
              <Icon name={editing ? 'save' : 'plus'} size={10} /> {editing ? t('common.save') : t('note.add')}
            </button>
          </div>
        </div>

        <div className="notes-grid">
          {active.map((n) => (
            <NoteTile
              key={n.id}
              note={n}
              onEdit={() => {
                setEditing(n.id)
                setDraft(n.text)
                setTone(n.tone)
              }}
            />
          ))}
          {!active.length && <div className="notes-empty t-sm faint">{t('note.empty')}</div>}
        </div>

        {!!done.length && (
          <>
            <div className="notes-sub">{t('note.doneGroup', { n: done.length })}</div>
            <div className="notes-grid">
              {done.map((n) => (
                <NoteTile key={n.id} note={n} compact />
              ))}
            </div>
          </>
        )}

        <div className="notes-foot t-xs faint">{t('note.foot')}</div>
      </div>
    </div>
  )
}
