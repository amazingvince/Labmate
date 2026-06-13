/** §04 EVIDENCE LEDGER — the product centerpiece. One feed merging runs,
 *  critiques, decisions, and feedback, with an alert pin on a caught issue. */
import type { ReactNode } from 'react'
import type { Decision, DecisionAction, StudyDetail } from '../../api/types'
import {
  buildLedger,
  CRITIQUE_COLOR,
  CRITIQUE_LABEL,
  formatMetricValue,
  type LedgerEntry,
  methodologicalFlag,
  metricLabel,
  pickPrimaryMetric,
  runStatusMeta,
  shortId,
} from '../../lib/derive'
import { EmptyState, Flatline, ParsedChips, SkeletonRows } from '../primitives'

const DECISION_GLYPH: Record<DecisionAction, string> = {
  promote: '↑',
  reject: '✕',
  rerun: '↻',
  branch: '⎇',
  stop: '■',
}
const DECISION_COLOR: Record<DecisionAction, string> = {
  promote: 'var(--st-completed)',
  reject: 'var(--st-failed)',
  rerun: 'var(--cyan)',
  branch: 'var(--crit-calibration)',
  stop: 'var(--amber)',
}

function decisionTarget(d: Decision): string {
  if (d.promoted_run_id) return ` ${shortId(d.promoted_run_id, 6)}`
  if (d.rejected_run_id) return ` ${shortId(d.rejected_run_id, 6)}`
  return ''
}

function Entry({ entry, metricKey }: { entry: LedgerEntry; metricKey?: string }) {
  if (entry.kind === 'run') {
    const run = entry.data
    const meta = runStatusMeta(run.status)
    const primary = pickPrimaryMetric(run, metricKey)
    return (
      <Node color={meta.cssVar} glyph="◆" type="RUN">
        <b>Run {shortId(run.id, 6)}</b> — {meta.label.toLowerCase()}
        {primary && (
          <>
            {' · '}
            {metricLabel(primary.key)} {formatMetricValue(primary.value)}
          </>
        )}
        {run.rationale && <div className="parse-hint">{run.rationale}</div>}
      </Node>
    )
  }
  if (entry.kind === 'critique') {
    const c = entry.data
    return (
      <Node color={CRITIQUE_COLOR[c.kind]} glyph="!" type={CRITIQUE_LABEL[c.kind]}>
        <b>{c.finding}</b>
        {c.recommendation && <div className="parse-hint">→ {c.recommendation}</div>}
        {c.led_to_decision && <span className="chip chip--muted">{c.led_to_decision}</span>}
      </Node>
    )
  }
  if (entry.kind === 'decision') {
    const d = entry.data
    return (
      <Node color={DECISION_COLOR[d.action]} glyph={DECISION_GLYPH[d.action]} type="DECISION">
        <b>
          {d.action}
          {decisionTarget(d)}
        </b>
        {d.reason && <> — {d.reason}</>}
      </Node>
    )
  }
  // feedback
  const f = entry.data
  const parsed = f.parsed_constraints as Record<string, unknown> | undefined
  return (
    <Node color="var(--amber)" glyph="✎" type={f.type}>
      {f.content}
      {parsed && <ParsedChips parsed={parsed} />}
    </Node>
  )
}

function Node({
  color,
  glyph,
  type,
  children,
}: {
  color: string
  glyph: string
  type: string
  children: ReactNode
}) {
  return (
    <div className="tl-entry tl-entry--enter">
      <span className="tl-entry__node" style={{ borderColor: color, color }} aria-hidden="true">
        {glyph}
      </span>
      <div className="tl-entry__head">
        <span className="tl-entry__type" style={{ color }}>
          {type}
        </span>
      </div>
      <div className="tl-entry__body">{children}</div>
    </div>
  )
}

export function EvidenceLedger({
  detail,
  metricKey,
  loading = false,
}: {
  detail?: StudyDetail
  metricKey?: string
  loading?: boolean
}) {
  const flag = detail ? methodologicalFlag(detail) : undefined
  const entries = detail ? buildLedger(detail) : []

  const inner = () => {
    if (loading) return <SkeletonRows rows={6} />
    if (!detail || entries.length === 0) {
      return (
        <EmptyState label="Ledger awaiting first signal">
          <Flatline />
        </EmptyState>
      )
    }
    return (
      <>
        {flag && (
          <div className="alert-pin" role="alert" aria-live="polite">
            <span className="alert-pin__glyph" aria-hidden="true">
              ⚠
            </span>
            <div>
              <div className="alert-pin__title">Methodological flag · {CRITIQUE_LABEL[flag.kind]}</div>
              <div className="alert-pin__body">
                {flag.finding}
                {flag.recommendation && ` — ${flag.recommendation}`}
              </div>
            </div>
          </div>
        )}
        <div className="timeline">
          {entries.map((entry) => (
            <Entry key={`${entry.kind}-${entry.id}`} entry={entry} metricKey={metricKey} />
          ))}
        </div>
      </>
    )
  }

  return (
    <section className="panel area-ledger">
      <header className={`panel__head ${loading ? 'panel__head--acquiring' : ''}`}>
        <span className="panel__num">§04</span>
        <span className="panel__title" role="heading" aria-level={2}>
          {loading ? 'ACQUIRING…' : 'EVIDENCE LEDGER'}
        </span>
        {entries.length > 0 && <span className="panel__meta">{entries.length} events</span>}
      </header>
      <div className="ledger crosshair">{inner()}</div>
    </section>
  )
}
