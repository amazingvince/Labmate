/** Hypotheses (the cards) and the runs they produced. */
import type { StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { runsForHypothesis } from '@/lib/derive'
import { ExperimentList } from '@/components/study/ExperimentList'
import { RunsTable } from '@/components/study/RunsTable'

function SectionHeading({ title, summary }: { title: string; summary: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">{summary}</span>
    </div>
  )
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
          banned={banned}
          reruns={reruns}
          actions={actions}
          metricKey={metricKey}
        />
      </section>
      <section className="space-y-4">
        <SectionHeading title="Runs" summary={`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`} />
        <RunsTable
          runs={detail.runs}
          hypotheses={detail.hypotheses}
          critiques={detail.critiques}
          metricKey={metricKey}
        />
      </section>
    </div>
  )
}
