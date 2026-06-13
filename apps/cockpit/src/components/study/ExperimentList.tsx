/** The grid of hypothesis cards. */
import { FlaskConicalIcon } from 'lucide-react'
import type { Critique, Hypothesis, Run } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { ExperimentCard } from '@/components/study/ExperimentCard'
import { EmptyCard } from '@/components/states/EmptyCard'

export function ExperimentList({
  hypotheses = [],
  runs = [],
  critiques = [],
  banned,
  reruns,
  actions,
  metricKey,
}: {
  hypotheses?: Hypothesis[]
  runs?: Run[]
  critiques?: Critique[]
  banned: Set<string>
  reruns: string[]
  actions: StudyActions
  metricKey?: string
}) {
  if (hypotheses.length === 0) {
    return (
      <EmptyCard
        icon={<FlaskConicalIcon />}
        title="No experiments proposed"
        hint="Claude proposes hypothesis cards via the propose_experiments tool."
      />
    )
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {hypotheses.map((hyp) => (
        <ExperimentCard
          key={hyp.id}
          hyp={hyp}
          runs={runs}
          critiques={critiques}
          banned={banned}
          rerunRequested={reruns.includes(hyp.id)}
          actions={actions}
          metricKey={metricKey}
        />
      ))}
    </div>
  )
}
