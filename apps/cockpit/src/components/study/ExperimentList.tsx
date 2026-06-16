/** The grid of hypothesis cards, with a filter row. */
import { useState } from 'react'
import { FlaskConicalIcon } from 'lucide-react'
import type { Hypothesis, Run } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { runsForHypothesis } from '@/lib/derive'
import { ExperimentCard } from '@/components/study/ExperimentCard'
import { EmptyCard } from '@/components/states/EmptyCard'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'has-run' | 'flagged' | 'proposed'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'has-run', label: 'Has run' },
  { id: 'flagged', label: 'Flagged' },
  { id: 'proposed', label: 'Proposed' },
]

/** A hypothesis is "flagged" when one of its runs failed (the run-level signal we
 *  can show; methodological critiques live at study scope, not per-run). */
function isFlagged(hyp: Hypothesis, runs: Run[]): boolean {
  return runsForHypothesis(runs, hyp.id).some((r) => r.status === 'failed')
}

export function ExperimentList({
  hypotheses = [],
  runs = [],
  banned,
  reruns,
  actions,
  metricKey,
}: {
  hypotheses?: Hypothesis[]
  runs?: Run[]
  banned: Set<string>
  reruns: string[]
  actions: StudyActions
  metricKey?: string
}) {
  const [filter, setFilter] = useState<Filter>('all')

  if (hypotheses.length === 0) {
    return (
      <EmptyCard
        icon={<FlaskConicalIcon />}
        title="No experiments proposed"
        hint="Claude proposes hypothesis cards via the propose_experiments tool."
      />
    )
  }

  const matches = (hyp: Hypothesis): boolean => {
    const ran = runsForHypothesis(runs, hyp.id).length > 0 || hyp.status === 'tested'
    switch (filter) {
      case 'has-run':
        return ran
      case 'flagged':
        return isFlagged(hyp, runs)
      case 'proposed':
        return !ran && hyp.status !== 'rejected'
      default:
        return true
    }
  }

  const shown = hypotheses.filter(matches)
  const count = (f: Filter): number =>
    hypotheses.filter((h) => {
      const ran = runsForHypothesis(runs, h.id).length > 0 || h.status === 'tested'
      if (f === 'has-run') return ran
      if (f === 'flagged') return isFlagged(h, runs)
      if (f === 'proposed') return !ran && h.status !== 'rejected'
      return true
    }).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter experiments">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
              filter === f.id
                ? 'border-foreground/20 bg-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-accent/50',
            )}
          >
            {f.label}
            <span className="ml-1.5 font-mono tabular-nums text-muted-foreground">{count(f.id)}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyCard title="No experiments match this filter" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((hyp) => (
            <ExperimentCard
              key={hyp.id}
              hyp={hyp}
              runs={runs}
              banned={banned}
              rerunRequested={reruns.includes(hyp.id)}
              actions={actions}
              metricKey={metricKey}
            />
          ))}
        </div>
      )}
    </div>
  )
}
