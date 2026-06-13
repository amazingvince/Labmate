/** The evidence ledger — the product centerpiece. One feed merging runs,
 *  critiques, decisions, and feedback, with an alert when an issue is caught. */
import {
  ArrowUpIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  type LucideIcon,
  PenLineIcon,
  RotateCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { Decision, DecisionAction, StudyDetail } from '@/api/types'
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
} from '@/lib/derive'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { EmptyCard } from '@/components/states/EmptyCard'
import { ParsedConstraintChips } from '@/components/study/ParsedConstraintChips'

const DECISION_ICON: Record<DecisionAction, LucideIcon> = {
  promote: ArrowUpIcon,
  reject: XIcon,
  rerun: RotateCwIcon,
  branch: GitBranchIcon,
  stop: SquareIcon,
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

type Resolved = { color: string; Icon: LucideIcon; type: string; body: ReactNode }

function resolve(entry: LedgerEntry, metricKey?: string): Resolved {
  if (entry.kind === 'run') {
    const run = entry.data
    const meta = runStatusMeta(run.status)
    const primary = pickPrimaryMetric(run, metricKey)
    return {
      color: meta.cssVar,
      Icon: FlaskConicalIcon,
      type: 'Run',
      body: (
        <>
          <span className="font-medium">Run {shortId(run.id, 6)}</span> —{' '}
          {meta.label.toLowerCase()}
          {primary && (
            <>
              {' · '}
              <span className="font-mono tabular-nums">
                {metricLabel(primary.key)} {formatMetricValue(primary.value)}
              </span>
            </>
          )}
          {run.rationale && (
            <div className="mt-0.5 text-xs text-muted-foreground">{run.rationale}</div>
          )}
        </>
      ),
    }
  }
  if (entry.kind === 'critique') {
    const c = entry.data
    return {
      color: CRITIQUE_COLOR[c.kind],
      Icon: TriangleAlertIcon,
      type: CRITIQUE_LABEL[c.kind],
      body: (
        <>
          <span className="font-medium">{c.finding}</span>
          {c.recommendation && (
            <div className="mt-0.5 text-xs text-muted-foreground">→ {c.recommendation}</div>
          )}
          {c.led_to_decision && (
            <Badge variant="secondary" className="ml-2 capitalize">
              {c.led_to_decision}
            </Badge>
          )}
        </>
      ),
    }
  }
  if (entry.kind === 'decision') {
    const d = entry.data
    return {
      color: DECISION_COLOR[d.action],
      Icon: DECISION_ICON[d.action],
      type: 'Decision',
      body: (
        <>
          <span className="font-medium capitalize">
            {d.action}
            {decisionTarget(d)}
          </span>
          {d.reason && <> — {d.reason}</>}
        </>
      ),
    }
  }
  const f = entry.data
  const parsed = f.parsed_constraints as Record<string, unknown> | undefined
  return {
    color: 'var(--amber)',
    Icon: PenLineIcon,
    type: f.type,
    body: (
      <>
        {f.content}
        {parsed && <ParsedConstraintChips parsed={parsed} className="mt-1.5" />}
      </>
    ),
  }
}

function TimelineRow({
  entry,
  metricKey,
  last,
}: {
  entry: LedgerEntry
  metricKey?: string
  last: boolean
}) {
  const { color, Icon, type, body } = resolve(entry, metricKey)
  return (
    <div className="relative flex gap-3 pb-5 last:pb-0">
      {!last && <span className="absolute bottom-0 left-3 top-7 w-px bg-border" aria-hidden="true" />}
      <span
        className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background"
        style={{ borderColor: color, color }}
        aria-hidden="true"
      >
        <Icon className="size-3" />
      </span>
      <div className="-mt-0.5 min-w-0 flex-1">
        <div
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color }}
        >
          {type}
        </div>
        <div className="mt-0.5 text-sm leading-relaxed">{body}</div>
      </div>
    </div>
  )
}

export function EvidenceTimeline({
  detail,
  metricKey,
}: {
  detail?: StudyDetail
  metricKey?: string
}) {
  const flag = detail ? methodologicalFlag(detail) : undefined
  const entries = detail ? buildLedger(detail) : []

  if (!detail || entries.length === 0) {
    return <EmptyCard title="Ledger awaiting first signal" hint="Runs, critiques, decisions, and your feedback land here." />
  }

  return (
    <div className="space-y-4">
      {flag && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Methodological flag · {CRITIQUE_LABEL[flag.kind]}</AlertTitle>
          <AlertDescription>
            {flag.finding}
            {flag.recommendation && ` — ${flag.recommendation}`}
          </AlertDescription>
        </Alert>
      )}
      <div>
        {entries.map((entry, i) => (
          <TimelineRow
            key={`${entry.kind}-${entry.id}`}
            entry={entry}
            metricKey={metricKey}
            last={i === entries.length - 1}
          />
        ))}
      </div>
    </div>
  )
}
