/** Hypotheses (the cards) and the runs they produced. */
import type { StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { ExperimentList } from '@/components/study/ExperimentList'
import { RunsTable } from '@/components/study/RunsTable'

function SectionHeading({ title, count, unit }: { title: string; count: number; unit: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {count} {unit}
      </span>
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
  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <SectionHeading title="Experiments" count={hyps.length} unit="hypotheses" />
        <ExperimentList
          hypotheses={detail.hypotheses}
          runs={detail.runs}
          critiques={detail.critiques}
          banned={banned}
          reruns={reruns}
          actions={actions}
          metricKey={metricKey}
        />
      </section>
      <section className="space-y-4">
        <SectionHeading title="Runs" count={runs.length} unit="runs" />
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
