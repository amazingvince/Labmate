/** One hypothesis card: statement, rationale, features, the latest run's metric,
 *  and the Approve / Deny / Rerun controls (optimistic via the overlay). */
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react'
import type { Critique, Hypothesis, Run } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import {
  CRITIQUE_LABEL,
  critiquesForRun,
  latestRun,
  pickPrimaryMetric,
  runsForHypothesis,
} from '@/lib/derive'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { MetricValue } from '@/components/study/MetricValue'
import { cn } from '@/lib/utils'

function HypStatusBadge({ status }: { status: Hypothesis['status'] }) {
  if (status === 'approved') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 bg-transparent capitalize"
        style={{ borderColor: 'var(--st-completed)', color: 'var(--st-completed)' }}
      >
        approved
      </Badge>
    )
  }
  if (status === 'rejected') {
    return (
      <Badge variant="secondary" className="shrink-0 capitalize text-muted-foreground line-through">
        rejected
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="shrink-0 capitalize">
      proposed
    </Badge>
  )
}

export function ExperimentCard({
  hyp,
  runs,
  critiques,
  banned,
  rerunRequested,
  actions,
  metricKey,
}: {
  hyp: Hypothesis
  runs: Run[]
  critiques: Critique[]
  banned: Set<string>
  rerunRequested: boolean
  actions: StudyActions
  metricKey?: string
}) {
  const run = latestRun(runsForHypothesis(runs, hyp.id))
  const primary = run ? pickPrimaryMetric(run, metricKey) : undefined
  const linked = critiquesForRun(critiques, run?.id)
  const flag = linked.find((c) => c.kind === 'leakage' || c.kind === 'test_set_tuning')
  const running = run?.status === 'running'
  const status = hyp.status ?? 'proposed'

  const approvePending = actions.approve.isPending && actions.approve.variables?.id === hyp.id
  const denyPending = actions.deny.isPending && actions.deny.variables?.id === hyp.id
  const rerunPending = actions.rerun.isPending && actions.rerun.variables?.id === hyp.id

  return (
    <Card className={cn('flex flex-col gap-0', flag && 'border-destructive/40')}>
      <CardHeader className="gap-3">
        {flag && (
          <Alert variant="destructive" className="py-2.5">
            <TriangleAlertIcon />
            <AlertTitle className="text-xs">{CRITIQUE_LABEL[flag.kind]}</AlertTitle>
            <AlertDescription className="text-xs">{flag.finding}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold leading-snug">{hyp.statement}</h3>
          <HypStatusBadge status={status} />
        </div>
        {hyp.rationale && (
          <p className="text-xs leading-relaxed text-muted-foreground">{hyp.rationale}</p>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">
          {hyp.model_family && (
            <Badge variant="secondary" className="font-mono font-normal">
              {hyp.model_family}
            </Badge>
          )}
          {(hyp.features ?? []).map((f) => (
            <Badge
              key={f}
              variant="outline"
              className={cn(
                'bg-transparent font-mono font-normal',
                banned.has(f) && 'text-muted-foreground line-through',
              )}
            >
              {f}
            </Badge>
          ))}
        </div>

        {hyp.expected_outcome && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Expected: </span>
            {hyp.expected_outcome}
          </p>
        )}

        <div className="mt-auto flex items-end justify-between gap-4 border-t pt-4">
          {run ? (
            <MetricValue
              value={primary?.value}
              metricKey={primary?.key}
              running={running}
              size="md"
            />
          ) : (
            <span className="text-xs text-muted-foreground">No run yet</span>
          )}
          {rerunRequested && (
            <Badge variant="secondary" className="shrink-0">
              rerun requested
            </Badge>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            variant={status === 'approved' ? 'default' : 'outline'}
            disabled={status !== 'proposed' || approvePending}
            onClick={() => actions.approve.mutate(hyp)}
          >
            {approvePending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : status === 'approved' ? (
              'Approved'
            ) : (
              'Approve'
            )}
          </Button>
          <Button
            size="sm"
            className="flex-1"
            variant="outline"
            disabled={status !== 'proposed' || denyPending}
            onClick={() => actions.deny.mutate(hyp)}
          >
            {denyPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : status === 'rejected' ? (
              'Denied'
            ) : (
              'Deny'
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={rerunPending}
            onClick={() => actions.rerun.mutate(hyp)}
          >
            {rerunPending ? <Loader2Icon className="size-3.5 animate-spin" /> : 'Rerun'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
