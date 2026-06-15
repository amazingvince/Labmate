/** At-a-glance summary that links into the other tabs. */
import type { ReactNode } from 'react'
import { ArrowRightIcon } from 'lucide-react'
import type { Critique, GradeResult, Report, Study, StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { studyHref } from '@/lib/router'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { runsForHypothesis } from '@/lib/derive'
import { BriefCard } from '@/components/study/BriefCard'
import { ReadinessSummary } from '@/components/study/ReadinessRubric'
import { FeedbackForm } from '@/components/study/FeedbackForm'
import { splitRecommendation } from '@/components/study/RecommendationPanel'

function StatTile({
  href,
  label,
  value,
  sub,
}: {
  href: string
  label: string
  value: ReactNode
  sub?: string
}) {
  return (
    <a
      href={href}
      className="group rounded-lg border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/40"
    >
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        <ArrowRightIcon className="size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
      </div>
      <div className="mt-2 font-mono text-2xl font-medium tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{sub}</div>}
    </a>
  )
}

export function OverviewTab({
  studyId,
  study,
  detail,
  banned,
  report,
  grade,
  recommendation,
  flag,
  actions,
}: {
  studyId: string
  study: Study
  detail: StudyDetail
  banned: Set<string>
  report?: Report
  grade?: GradeResult
  recommendation?: string
  flag?: Critique
  actions: StudyActions
}) {
  const hyps = detail.hypotheses ?? []
  const runs = detail.runs ?? []
  // "Activated" = approved OR already run OR tested. Live hypotheses keep
  // status 'proposed' after they run, so a plain status==='approved' count reads
  // 0/19 — derive from runs-or-approved-or-tested instead.
  const activated = hyps.filter(
    (h) =>
      h.status === 'approved' ||
      h.status === 'tested' ||
      runsForHypothesis(runs, h.id).length > 0,
  ).length
  const completed = runs.filter((r) => r.status === 'completed').length
  const rows = detail.dataset_version?.row_count
  const { verb, detail: recDetail } = splitRecommendation(recommendation, flag)
  // splitRecommendation returns verb='' for prose; show a sensible tile value.
  const recValue = verb || (recDetail ? 'Note' : '—')

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          href={studyHref(studyId, 'experiments')}
          label="Experiments"
          value={`${activated}/${hyps.length}`}
          sub="approved or run"
        />
        <StatTile
          href={studyHref(studyId, 'experiments')}
          label="Runs"
          value={`${completed}/${runs.length}`}
          sub="completed"
        />
        <StatTile
          href={studyHref(studyId, 'ledger')}
          label="Dataset"
          value={rows != null ? rows.toLocaleString() : '—'}
          sub="rows"
        />
        <StatTile
          href={studyHref(studyId, 'report')}
          label="Recommendation"
          value={<span className="text-xl">{recValue}</span>}
          sub={recDetail || undefined}
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <BriefCard study={study} detail={detail} banned={banned} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Readiness</CardTitle>
          </CardHeader>
          <CardContent>
            <ReadinessSummary detail={detail} banned={banned} report={report} grade={grade} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Steer the study</CardTitle>
          <CardDescription>
            Record your judgment in plain language — it is parsed into constraints that shape
            later experiments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FeedbackForm study={study} actions={actions} />
        </CardContent>
      </Card>
    </div>
  )
}
