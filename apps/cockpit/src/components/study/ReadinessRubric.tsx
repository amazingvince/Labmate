/** Definition-of-done checklist. Uses the authoritative grade when present, else
 *  a live readiness readout derived from the ledger. The keystone check —
 *  "caught an issue" — is highlighted. */
import { CheckCircle2Icon, CircleIcon, XCircleIcon } from 'lucide-react'
import type { GradeResult, Report, StudyDetail } from '@/api/types'
import { methodologicalFlag } from '@/lib/derive'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type RowState = 'pass' | 'pending' | 'fail'
type Row = {
  id: string
  label: string
  state: RowState
  keystone?: boolean
  required?: boolean
  detail?: string
}

function derivedRows(detail: StudyDetail, banned: Set<string>, report?: Report): Row[] {
  const runs = detail.runs ?? []
  const critiques = detail.critiques ?? []
  const decisions = detail.decisions ?? []
  const artifacts = detail.artifacts ?? []
  const baseline = runs.some(
    (r) => (r.tags ?? []).some((t) => /baseline/i.test(t)) || /baseline/i.test(r.hypothesis_id),
  )
  const r = (id: string, label: string, pass: boolean, keystone?: boolean): Row => ({
    id,
    label,
    state: pass ? 'pass' : 'pending',
    keystone,
  })
  return [
    r('contract', 'Data contract written', Boolean(detail.dataset_version)),
    r('baseline', 'Baseline model ran', baseline),
    r('five', '≥ 5 experiments ran', runs.length >= 5),
    r('leakage', 'Leakage review', critiques.some((c) => c.kind === 'leakage') || banned.size > 0),
    r(
      'best',
      'Best vs baseline',
      decisions.some((d) => d.action === 'promote') || Boolean(report?.compares_best_to_baseline),
    ),
    r('report', 'Report / model card', artifacts.some((a) => a.kind === 'report') || Boolean(report)),
    r('feedback', 'Human feedback recorded', (detail.feedback ?? []).length > 0),
    r('caught_an_issue', 'Caught an issue', Boolean(methodologicalFlag(detail)), true),
  ]
}

function gradeRows(grade: GradeResult): Row[] {
  return grade.checks.map((c) => ({
    id: c.id,
    label: c.id.replace(/_/g, ' '),
    state: c.passed ? 'pass' : c.required ? 'fail' : 'pending',
    keystone: c.id === 'caught_an_issue',
    required: c.required,
    detail: c.detail,
  }))
}

export function buildReadiness(
  detail: StudyDetail,
  banned: Set<string>,
  report?: Report,
  grade?: GradeResult,
): { rows: Row[]; passed: number; total: number; verdict?: string } {
  const rows = grade ? gradeRows(grade) : derivedRows(detail, banned, report)
  const passed = rows.filter((r) => r.state === 'pass').length
  return { rows, passed, total: rows.length, verdict: grade?.verdict }
}

function StateIcon({ state }: { state: RowState }) {
  if (state === 'pass') {
    return <CheckCircle2Icon className="size-4 shrink-0" style={{ color: 'var(--st-completed)' }} />
  }
  if (state === 'fail') {
    return <XCircleIcon className="size-4 shrink-0" style={{ color: 'var(--st-failed)' }} />
  }
  return <CircleIcon className="size-4 shrink-0 text-muted-foreground/50" />
}

export function ReadinessRubric({
  detail,
  banned,
  report,
  grade,
}: {
  detail: StudyDetail
  banned: Set<string>
  report?: Report
  grade?: GradeResult
}) {
  const { rows, passed, total, verdict } = buildReadiness(detail, banned, report, grade)
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Definition of done</CardTitle>
          {verdict ? (
            <Badge
              variant="outline"
              className="bg-transparent capitalize"
              style={
                verdict === 'done'
                  ? { borderColor: 'var(--st-completed)', color: 'var(--st-completed)' }
                  : undefined
              }
            >
              {verdict}
            </Badge>
          ) : (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {passed} / {total}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-0.5">
          {rows.map((row) => {
            const rowEl = (
              <div
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm',
                  row.keystone && 'bg-muted/60 font-medium',
                )}
              >
                <StateIcon state={row.state} />
                <span className={cn('capitalize', row.state === 'pending' && 'text-muted-foreground')}>
                  {row.label}
                </span>
                {row.keystone && (
                  <Badge variant="secondary" className="ml-auto text-[10px] uppercase">
                    keystone
                  </Badge>
                )}
                {!row.keystone && row.required === false && (
                  <span className="ml-auto text-[10px] uppercase text-muted-foreground">optional</span>
                )}
              </div>
            )
            return row.detail ? (
              <Tooltip key={row.id}>
                <TooltipTrigger asChild>{rowEl}</TooltipTrigger>
                <TooltipContent className="max-w-xs">{row.detail}</TooltipContent>
              </Tooltip>
            ) : (
              <div key={row.id}>{rowEl}</div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

/** Condensed progress for the Overview tab — a bar + count + keystone status. */
export function ReadinessSummary({
  detail,
  banned,
  report,
  grade,
}: {
  detail: StudyDetail
  banned: Set<string>
  report?: Report
  grade?: GradeResult
}) {
  const { rows, passed, total } = buildReadiness(detail, banned, report, grade)
  const keystone = rows.find((r) => r.keystone)
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-2xl font-medium tabular-nums">
          {passed}
          <span className="text-muted-foreground">/{total}</span>
        </span>
        <span className="text-xs text-muted-foreground">checks complete</span>
      </div>
      <Progress value={total ? (passed / total) * 100 : 0} />
      {keystone && (
        <div className="flex items-center gap-2 text-xs">
          <StateIcon state={keystone.state} />
          <span className={cn(keystone.state !== 'pass' && 'text-muted-foreground')}>
            {keystone.state === 'pass' ? 'Caught a methodological issue' : 'No issue caught yet'}
          </span>
        </div>
      )}
    </div>
  )
}
