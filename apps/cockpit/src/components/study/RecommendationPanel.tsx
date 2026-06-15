/** The agent's current recommendation, the generated model-card artifact, and
 *  the Generate report / Check done controls. */
import { FileTextIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react'
import type { Critique, Report, Study, StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useHasApiToken } from '@/api/token'
import { api } from '@/api/client'
import { CRITIQUE_LABEL, shortId } from '@/lib/derive'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The known leading verbs the agent emits as a recommendation headline. Only when
 * the first token is one of these do we render it as a verb headline + the rest as
 * detail; otherwise the whole string is prose (avoids turning the first word of a
 * sentence — "Best model is…", "Profile shows…" — into a fake "BEST"/"PROFILE"
 * headline).
 */
const REC_VERBS = new Set([
  'promote',
  'reject',
  'rerun',
  'branch',
  'stop',
  'review',
  'investigate',
  'hold',
  'wait',
  'tune',
  'continue',
  'proceed',
])

export function splitRecommendation(
  rec: string | undefined,
  flag: Critique | undefined,
): { verb: string; detail: string } {
  const text = (rec ?? '').trim()
  if (text) {
    // Special-case the idle phrase so it isn't split into "STANDING" + "BY".
    if (/^standing by\b/i.test(text)) {
      return { verb: 'STANDING BY', detail: text.slice('standing by'.length).replace(/^[\s—-]+/, '') }
    }
    const m = text.match(/^(\S+)\s*([\s\S]*)$/)
    const first = m?.[1] ?? text
    // Only treat the first token as a headline verb when it's a known imperative.
    if (REC_VERBS.has(first.toLowerCase())) {
      return { verb: first.toUpperCase(), detail: m?.[2]?.trim() ?? '' }
    }
    // Otherwise it's prose — render the whole thing as detail, no fake headline.
    return { verb: '', detail: text }
  }
  if (flag) return { verb: 'REVIEW', detail: flag.finding }
  return { verb: 'STANDING BY', detail: '' }
}

/**
 * Reconcile the report's `best_run_id` against the run a promote decision actually
 * promoted. When they differ, the human should know the promoted model isn't the
 * report's best — return that mismatch so the panel can warn.
 */
export function bestVsPromoted(
  report: Report | undefined,
  detail: StudyDetail | undefined,
): { bestRunId?: string; baselineRunId?: string; promotedRunId?: string; mismatch: boolean } {
  const bestRunId = report?.best_run_id
  const baselineRunId = report?.baseline_run_id
  const promote = (detail?.decisions ?? []).find((d) => d.action === 'promote' && d.promoted_run_id)
  const promotedRunId = promote?.promoted_run_id
  const mismatch = Boolean(bestRunId && promotedRunId && bestRunId !== promotedRunId)
  return { bestRunId, baselineRunId, promotedRunId, mismatch }
}

export function RecommendationPanel({
  study,
  detail,
  recommendation,
  flag,
  actions,
  report,
}: {
  study?: Study
  detail?: StudyDetail
  recommendation?: string
  flag?: Critique
  actions: StudyActions
  report?: Report
}) {
  const locked = !useHasApiToken()
  const { verb, detail: recDetail } = splitRecommendation(recommendation, flag)
  const { bestRunId, baselineRunId, promotedRunId, mismatch } = bestVsPromoted(report, detail)
  return (
    <Card className={cn(flag && 'border-destructive/40')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {flag ? (
            <>
              <TriangleAlertIcon className="size-3.5 text-destructive" />
              Methodological flag · {CRITIQUE_LABEL[flag.kind]}
            </>
          ) : (
            'Current recommendation'
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          {verb && (
            <div
              className="font-mono text-3xl font-semibold tracking-tight"
              style={flag ? { color: 'var(--crit-leakage)' } : undefined}
            >
              {verb}
            </div>
          )}
          {recDetail && (
            <p className={cn('text-sm text-muted-foreground', verb && 'mt-1.5')}>{recDetail}</p>
          )}
        </div>

        {report && (
          <>
            <Separator />
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <FileTextIcon className="size-4 text-muted-foreground" />
                <span className="font-medium">Model card</span>
                {report.compares_best_to_baseline && (
                  <Badge
                    variant="outline"
                    className="bg-transparent font-normal"
                    style={{ borderColor: 'var(--st-completed)', color: 'var(--st-completed)' }}
                  >
                    best vs baseline ✓
                  </Badge>
                )}
              </div>

              {/* Best / baseline / promoted reconciliation. The report names a
                  best + baseline run; the promote decision names what was actually
                  promoted. When best ≠ promoted, warn. */}
              {(bestRunId || baselineRunId || promotedRunId) && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {bestRunId && (
                    <Badge variant="secondary" className="font-mono font-normal">
                      best · {shortId(bestRunId, 6)}
                    </Badge>
                  )}
                  {baselineRunId && (
                    <Badge variant="secondary" className="font-mono font-normal">
                      baseline · {shortId(baselineRunId, 6)}
                    </Badge>
                  )}
                  {promotedRunId && (
                    <Badge variant="secondary" className="font-mono font-normal">
                      promoted · {shortId(promotedRunId, 6)}
                    </Badge>
                  )}
                  {mismatch && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className="gap-1 bg-transparent font-normal"
                          style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }}
                        >
                          <TriangleAlertIcon className="size-3" />
                          report best ≠ promoted
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        The report&apos;s best run ({shortId(bestRunId, 6)}) is not the run that was
                        promoted ({shortId(promotedRunId, 6)}). Reconcile before trusting the
                        recommendation.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}

              {study?.id && (
                <a
                  href={api.reportMarkdownUrl(study.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-mono text-xs text-brand hover:underline"
                  title={report.uri}
                >
                  {report.uri}
                </a>
              )}
              {report.reproducible_command && (
                <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {report.reproducible_command}
                </pre>
              )}
              {report.provenance?.seed != null && (
                <p className="font-mono text-xs text-muted-foreground">
                  seed {report.provenance.seed}
                  {report.provenance.dataset_hash
                    ? ` · data ${shortId(report.provenance.dataset_hash, 6)}`
                    : ''}
                </p>
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap gap-2">
          <WriteButton
            locked={locked}
            disabled={!study || actions.generateReport.isPending}
            onClick={() => actions.generateReport.mutate()}
            pendingLabel="Generating…"
            pending={actions.generateReport.isPending}
          >
            Generate report
          </WriteButton>
          <WriteButton
            locked={locked}
            variant="outline"
            disabled={!study || actions.checkDone.isPending}
            onClick={() => actions.checkDone.mutate()}
            pendingLabel="Grading…"
            pending={actions.checkDone.isPending}
          >
            Check done
          </WriteButton>
        </div>
      </CardContent>
    </Card>
  )
}

/** A write button that disables + explains itself when the cockpit is locked. */
function WriteButton({
  locked,
  variant,
  disabled,
  pending,
  pendingLabel,
  onClick,
  children,
}: {
  locked: boolean
  variant?: 'default' | 'outline'
  disabled?: boolean
  pending?: boolean
  pendingLabel: string
  onClick: () => void
  children: React.ReactNode
}) {
  const btn = (
    <Button variant={variant} disabled={locked || disabled} onClick={onClick}>
      {pending ? (
        <>
          <Loader2Icon className="size-4 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  )
  if (!locked) return btn
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{btn}</span>
      </TooltipTrigger>
      <TooltipContent>Unlock to enable writes</TooltipContent>
    </Tooltip>
  )
}
