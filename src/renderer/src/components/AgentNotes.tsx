import React, { useState } from 'react'
import type { AgentVote, SpecReport } from '../../../shared/types'
import { Icon, type IconName } from './Icon'
import { useStore } from '../store'
import { useT } from '../lib/i18n'
import type { DictKey } from '../../../shared/i18n'

/**
 * The agent asked for a decision. It never blocks the run: the cards are live
 * while the agent keeps working, and if nobody answers it goes ahead with the
 * option it recommended itself — shown plainly, so the user can still correct it.
 */
export function VoteCard({ vote }: { vote: AgentVote }): React.ReactElement {
  const t = useT()
  const running = useStore((s) => s.running)
  const answerLiveVote = useStore((s) => s.answerLiveVote)
  const answerVote = useStore((s) => s.answerVote)
  const [own, setOwn] = useState('')
  const answered = !!vote.answer
  // while the run is in flight the answer goes into the live run; if it already
  // moved on, answering simply becomes the next message
  const submit = (value: string): void => {
    if (running) void answerLiveVote(vote.id, value)
    else void answerVote(value)
  }

  return (
    <div className="vote-card" data-answered={answered} data-auto={!!vote.auto}>
      <div className="vote-head">
        <Icon name="chat" size={12} className="acc" />
        <span className="vote-title">{t('vote.title')}</span>
        <span className="vote-hint t-xs faint">{running && !answered ? t('vote.liveHint') : t('vote.hint')}</span>
      </div>
      <div className="vote-question selectable">{vote.question}</div>
      {answered ? (
        <div className="vote-answered">
          <Icon name={vote.auto ? 'clock' : 'check-circle'} size={11} className={vote.auto ? 'warn' : 'ok'} />
          <span className="t-xs faint">{vote.auto ? t('vote.autoPicked') : t('vote.answered')}</span>
          <span className="vote-picked">{vote.answer}</span>
        </div>
      ) : (
        <>
          <div className="vote-options">
            {vote.options.map((opt, i) => (
              <button
                key={opt + i}
                className="vote-option"
                onClick={() => submit(opt)}
                data-recommended={opt === vote.recommend}
              >
                <span className="vote-key">{i + 1}</span>
                <span className="vote-label">{opt}</span>
                {opt === vote.recommend && <span className="vote-badge">{t('vote.recommend')}</span>}
                <Icon name="arrow-right" size={11} className="vote-go" />
              </button>
            ))}
          </div>
          {running && vote.recommend && (
            <button className="vote-now link t-xs" onClick={() => submit(vote.recommend!)}>
              <Icon name="zap" size={10} /> {t('vote.now')}
            </button>
          )}
          <div className="vote-own">
            <input
              value={own}
              placeholder={t('vote.own')}
              onChange={(e) => setOwn(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && own.trim()) submit(own.trim())
              }}
            />
            <button className="btn" disabled={!own.trim()} onClick={() => submit(own.trim())}>
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
  contract: 'file',
  rework: 'alert',
  cost: 'wallet',
  stuck: 'alert',
  errors: 'alert',
  steer: 'chat'
}

/** A quiet, single-line record of something the app did on the user's behalf. */
export function GuardNote({ kind, title, detail }: { kind: string; title: string; detail?: string }): React.ReactElement {
  const t = useT()
  const labels: Record<string, DictKey> = {
    done: 'guard.done',
    verify: 'guard.verify',
    contract: 'guard.contract',
    rework: 'guard.rework',
    cost: 'guard.cost',
    stuck: 'guard.stuck',
    errors: 'guard.errors',
    steer: 'guard.steer'
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

/** Follow-ups the agent proposes: one click is the next request. */
export function Suggestions({ items }: { items: string[] }): React.ReactElement {
  const sendMessage = useStore((s) => s.sendMessage)
  const running = useStore((s) => s.running)
  return (
    <div className="suggest-row">
      {items.map((s) => (
        <button key={s} className="suggest-chip" disabled={running} onClick={() => void sendMessage(s)}>
          <Icon name="sparkles" size={10} className="acc" />
          {s}
        </button>
      ))}
    </div>
  )
}


/**
 * The contract check, as the user reads it: every criterion in their own words,
 * either with the file that proves it or with the reason it is missing. This is
 * what makes «готово» a claim with evidence instead of a word from a model.
 */
export function SpecCard({ report }: { report: SpecReport }): React.ReactElement {
  const t = useT()
  const failed = report.checks.filter((c) => c.status === 'fail')
  return (
    <div className="spec-card" data-verdict={failed.length ? 'rework' : 'done'}>
      <div className="spec-head">
        <Icon name={failed.length ? 'alert' : 'check-circle'} size={12} className="spec-icon" />
        <span className="spec-title">
          {failed.length ? t('spec.rework', { n: String(failed.length), total: String(report.checks.length) }) : t('spec.passed', { n: String(report.checks.length) })}
        </span>
      </div>
      <ul className="spec-list">
        {report.checks.map((c, i) => (
          <li key={i} data-status={c.status}>
            <Icon name={c.status === 'done' ? 'check' : 'alert'} size={10} className="spec-mark" />
            <div className="col" style={{ gap: 1 }}>
              <span className="spec-claim">{c.claim}</span>
              {(c.evidence || c.fix) && (
                <span className="spec-proof">{c.status === 'done' ? c.evidence : c.fix}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
