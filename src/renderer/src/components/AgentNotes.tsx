import React, { useState } from 'react'
import type { AgentVote } from '../../../shared/types'
import { Icon, type IconName } from './Icon'
import { useStore } from '../store'
import { useT } from '../lib/i18n'
import type { DictKey } from '../../../shared/i18n'

/**
 * The agent asked something. Rendered as pickable cards rather than a text blob:
 * one click is a complete answer, and the choice is what the next turn starts from.
 */
export function VoteCard({ vote }: { vote: AgentVote }): React.ReactElement {
  const t = useT()
  const answerVote = useStore((s) => s.answerVote)
  const running = useStore((s) => s.running)
  const [own, setOwn] = useState('')
  const answered = !!vote.answer

  return (
    <div className="vote-card" data-answered={answered}>
      <div className="vote-head">
        <Icon name="chat" size={12} className="acc" />
        <span className="vote-title">{t('vote.title')}</span>
        <span className="vote-hint t-xs faint">{t('vote.hint')}</span>
      </div>
      <div className="vote-question selectable">{vote.question}</div>
      {answered ? (
        <div className="vote-answered">
          <Icon name="check-circle" size={11} className="ok" />
          <span className="t-xs faint">{t('vote.answered')}</span>
          <span className="vote-picked">{vote.answer}</span>
        </div>
      ) : (
        <>
          <div className="vote-options">
            {vote.options.map((opt, i) => (
              <button
                key={opt + i}
                className="vote-option"
                onClick={() => void answerVote(opt)}
                data-recommended={opt === vote.recommend}
              >
                <span className="vote-key">{i + 1}</span>
                <span className="vote-label">{opt}</span>
                {opt === vote.recommend && <span className="vote-badge">{t('vote.recommend')}</span>}
                <Icon name="arrow-right" size={11} className="vote-go" />
              </button>
            ))}
          </div>
          <div className="vote-own">
            <input
              value={own}
              placeholder={t('vote.own')}
              onChange={(e) => setOwn(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && own.trim()) void answerVote(own)
              }}
            />
            <button className="btn" disabled={!own.trim() || running} onClick={() => void answerVote(own)}>
              {t('vote.send')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const GUARD_ICON: Record<string, IconName> = {
  done: 'check-circle',
  verify: 'shield',
  cost: 'wallet',
  stuck: 'alert',
  errors: 'alert'
}

/** A quiet, single-line record of something the app did on the user's behalf. */
export function GuardNote({ kind, title, detail }: { kind: string; title: string; detail?: string }): React.ReactElement {
  const t = useT()
  const labels: Record<string, DictKey> = {
    done: 'guard.done',
    verify: 'guard.verify',
    cost: 'guard.cost',
    stuck: 'guard.stuck',
    errors: 'guard.errors'
  }
  const label = labels[kind] ? t(labels[kind]) : kind
  return (
    <div className="guard-note" data-kind={kind} title={detail ? `${title}\n${detail}` : title}>
      <div className="guard-line">
        <Icon name={GUARD_ICON[kind] || 'info'} size={11} className="guard-icon" />
        <span className="guard-label">{label}</span>
        <span className="guard-title">{title}</span>
      </div>
      {detail && <div className="guard-detail">{detail}</div>}
    </div>
  )
}
