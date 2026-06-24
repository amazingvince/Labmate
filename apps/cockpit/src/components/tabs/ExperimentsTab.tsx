/** Hypotheses (the cards) and the experiment leaderboard they produced. */
import type { Report, StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useReport } from '@/api/hooks'
import {
  baselineRun,
  bestRun,
  formatMetricValue,
  metricDelta,
  metricLabel,
  pickPrimaryMetric,
  primaryMetricKey,
  runsForHypothesis,
} from '@/lib/derive'
import { ExperimentList } from '@/components/study/ExperimentList'
import { RunsTable } from '@/components/study/RunsTable'

function SectionHeading({ title, summary }: { title: string; summary: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">{summary}</span>
    </div>
  )
}

/** "N runs · best vs baseline {metric} {value} (+Δ)" — the leaderboard headline. */
function leaderboardSummary(detail: StudyDetail, metricKey?: string, report?: Report): string {
  const runs = detail.runs ?? []
  const n = `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`
  if (runs.length === 0 || !metricKey) return n

  const baseline = baselineRun(runs)
  const best = bestRun(runs, metricKey, report, detail.decisions, detail.hypotheses)
  // Read the starred run's headline value the SAME key-tolerant way the column
  // and `bestRun` do, so the summary number matches the row that's starred.
  const bestVal = best ? pickPrimaryMetric(best, metricKey)?.value : undefined
  if (best == null || typeof bestVal !== 'number') return n

  const label = metricLabel(metricKey)
  const delta = metricDelta(best, baseline, metricKey)
  const deltaStr = delta ? ` (${delta.abs >= 0 ? '+' : ''}${formatMetricValue(delta.abs)})` : ''
  return `${n} · best vs baseline ${label} ${formatMetricValue(bestVal)}${deltaStr}`
}

export function ExperimentsTab({
  detail,
  banned,
  reruns,
  actions,
  metricKey,
}: {
  detail: StudyDetail
  banned: Set<string>
  reruns: string[]
  actions: StudyActions
  metricKey?: string
}) {
  const hyps = detail.hypotheses ?? []
  const runs = detail.runs ?? []
  const report = useReport(detail.study?.id).data ?? undefined
  // Resolve the primary metric key the SAME way OverviewTab does
  // (`primaryMetricKey(study)`), so the starred run + headline + table column all
  // agree. Falls back to the prop the parent passed when the study isn't loaded.
  const primaryKey = detail.study ? primaryMetricKey(detail.study) : metricKey

  // "ran" reconciles hypotheses against runs: a hypothesis with at least one run,
  // or a 'tested' status, counts as run.
  const ranCount = hyps.filter(
    (h) => runsForHypothesis(runs, h.id).length > 0 || h.status === 'tested',
  ).length

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <SectionHeading
          title="Experiments"
          summary={`${hyps.length} ${hyps.length === 1 ? 'hypothesis' : 'hypotheses'} · ${ranCount} ran`}
        />
        <ExperimentList
          hypotheses={detail.hypotheses}
          runs={detail.runs}
          study={detail.study}
          banned={banned}
          reruns={reruns}
          actions={actions}
          metricKey={primaryKey}
        />
      </section>
      <section className="space-y-4">
        <SectionHeading title="Leaderboard" summary={leaderboardSummary(detail, primaryKey, report)} />
        <RunsTable
          runs={detail.runs}
          hypotheses={detail.hypotheses}
          study={detail.study}
          report={report}
          decisions={detail.decisions}
          feedback={detail.feedback}
          metricKey={primaryKey}
        />
      </section>
    </div>
  )
}
