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
import type { Decision, DecisionAction, Report, StudyDetail } from '@/api/types'
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

function resolve(entry: LedgerEntry, metricKey?: string, report?: Report): Resolved {
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
    // When this is a promote and the report's best run differs from what was
    // promoted, flag it — the human should know the promoted model isn't the best.
    const bestRunId = report?.best_run_id
    const baselineRunId = report?.baseline_run_id
    const mismatch =
      d.action === 'promote' &&
      Boolean(bestRunId && d.promoted_run_id && bestRunId !== d.promoted_run_id)
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
          {d.action === 'promote' && (bestRunId || baselineRunId) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {bestRunId && (
                <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                  report best · {shortId(bestRunId, 6)}
                </Badge>
              )}
              {baselineRunId && (
                <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                  baseline · {shortId(baselineRunId, 6)}
                </Badge>
              )}
              {mismatch && (
                <Badge
                  variant="outline"
                  className="gap-1 bg-transparent text-[10px] font-normal"
                  style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }}
                >
                  <TriangleAlertIcon className="size-3" />
                  report best ≠ promoted
                </Badge>
              )}
            </div>
          )}
        </>
      ),
    }
  }
  const f = entry.data
  const parsed = f.parsed_constraints as Record<string, unknown> | undefined
  return {
    color: 'var(--amber)',
    Icon: PenLineIcon,
    type: feedbackTypeLabel(f.type),
    body: (
      <>
        {f.content}
        {parsed && <ParsedConstraintChips parsed={parsed} className="mt-1.5" />}
      </>
    ),
  }
}

/** Friendly label for a feedback row's type — incl. the live `human_feedback`. */
function feedbackTypeLabel(type: string): string {
  switch (type) {
    case 'human_feedback':
      return 'Human feedback'
    case 'ban_feature':
      return 'Ban feature'
    case 'change_metric':
      return 'Change metric'
    case 'increase_budget':
      return 'Increase budget'
    case 'focus_segment':
      return 'Focus segment'
    case 'approval':
      return 'Approval'
    case 'note':
      return 'Note'
    default:
      return type.replace(/_/g, ' ')
  }
}

function TimelineRow({
  entry,
  metricKey,
  report,
  last,
}: {
  entry: LedgerEntry
  metricKey?: string
  report?: Report
  last: boolean
}) {
  const { color, Icon, type, body } = resolve(entry, metricKey, report)
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
  report,
  metricKey,
}: {
  detail?: StudyDetail
  report?: Report
  metricKey?: string
}) {
  const flag = detail ? methodologicalFlag(detail) : undefined
  // Ordered chronologically by created_at (buildLedger sorts the merged feed).
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
            report={report}
            last={i === entries.length - 1}
          />
        ))}
      </div>
    </div>
  )
}
