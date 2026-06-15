/** One hypothesis card: statement, rationale, features, the latest run's metric,
 *  and the Approve / Deny / Rerun controls (optimistic via the overlay). Once the
 *  hypothesis has a run (or status 'tested'), Approve/Deny are gone — only Rerun
 *  remains. Write controls are disabled until the operator unlocks. */
import { Loader2Icon } from 'lucide-react'
import type { Hypothesis, Run } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useHasApiToken } from '@/api/token'
import { latestRun, pickPrimaryMetric, runsForHypothesis } from '@/lib/derive'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MetricValue } from '@/components/study/MetricValue'
import { cn } from '@/lib/utils'

const LOCK_HINT = 'Unlock to enable writes'

function HypStatusBadge({ status, ran }: { status: Hypothesis['status']; ran: boolean }) {
  // A hypothesis with a run is "tested" regardless of its stored status.
  if (ran || status === 'tested') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 bg-transparent capitalize"
        style={{ borderColor: 'var(--st-completed)', color: 'var(--st-completed)' }}
      >
        tested
      </Badge>
    )
  }
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

/** A write button that disables + explains itself when the cockpit is locked. */
function WriteButton({
  locked,
  className,
  variant,
  pending,
  disabled,
  onClick,
  children,
}: {
  locked: boolean
  className?: string
  variant?: 'default' | 'outline' | 'ghost'
  pending?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const btn = (
    <Button
      size="sm"
      className={className}
      variant={variant}
      disabled={locked || pending || disabled}
      onClick={onClick}
    >
      {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : children}
    </Button>
  )
  if (!locked) return btn
  return (
    <Tooltip>
      {/* span wrapper: a disabled button doesn't fire the hover that opens the tip */}
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)}>{btn}</span>
      </TooltipTrigger>
      <TooltipContent>{LOCK_HINT}</TooltipContent>
    </Tooltip>
  )
}

export function ExperimentCard({
  hyp,
  runs,
  banned,
  rerunRequested,
  actions,
  metricKey,
}: {
  hyp: Hypothesis
  runs: Run[]
  banned: Set<string>
  rerunRequested: boolean
  actions: StudyActions
  metricKey?: string
}) {
  const locked = !useHasApiToken()
  const run = latestRun(runsForHypothesis(runs, hyp.id))
  const primary = run ? pickPrimaryMetric(run, metricKey) : undefined
  const running = run?.status === 'running'
  const status = hyp.status ?? 'proposed'
  const ran = Boolean(run) || status === 'tested'

  const approvePending = actions.approve.isPending && actions.approve.variables?.id === hyp.id
  const denyPending = actions.deny.isPending && actions.deny.variables?.id === hyp.id
  const rerunPending = actions.rerun.isPending && actions.rerun.variables?.id === hyp.id

  return (
    <Card className="flex flex-col gap-0">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold leading-snug">{hyp.statement}</h3>
          <HypStatusBadge status={status} ran={ran} />
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
          {/* Approve/Deny only make sense before the hypothesis has been run.
              Once it's tested they're hidden; Rerun stays available. */}
          {!ran && (
            <>
              <WriteButton
                locked={locked}
                className="flex-1"
                variant={status === 'approved' ? 'default' : 'outline'}
                pending={approvePending}
                disabled={status !== 'proposed'}
                onClick={() => actions.approve.mutate(hyp)}
              >
                {status === 'approved' ? 'Approved' : 'Approve'}
              </WriteButton>
              <WriteButton
                locked={locked}
                className="flex-1"
                variant="outline"
                pending={denyPending}
                disabled={status !== 'proposed'}
                onClick={() => actions.deny.mutate(hyp)}
              >
                {status === 'rejected' ? 'Denied' : 'Deny'}
              </WriteButton>
            </>
          )}
          <WriteButton
            locked={locked}
            className={cn(ran && 'flex-1')}
            variant="ghost"
            pending={rerunPending}
            onClick={() => actions.rerun.mutate(hyp)}
          >
            Rerun
          </WriteButton>
        </div>
      </CardContent>
    </Card>
  )
}
