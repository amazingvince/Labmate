/** The agent's current recommendation, the generated model-card artifact, and
 *  the Generate report / Check done controls. */
import { FileTextIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react'
import type { Critique, Report, Study } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { api } from '@/api/client'
import { CRITIQUE_LABEL, shortId } from '@/lib/derive'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export function splitRecommendation(
  rec: string | undefined,
  flag: Critique | undefined,
): { verb: string; detail: string } {
  const text = (rec ?? '').trim()
  if (text) {
    const m = text.match(/^(\S+)\s*(.*)$/)
    return { verb: (m?.[1] ?? text).toUpperCase(), detail: m?.[2] ?? '' }
  }
  if (flag) return { verb: 'REVIEW', detail: flag.finding }
  return { verb: 'STANDING BY', detail: '' }
}

export function RecommendationPanel({
  study,
  recommendation,
  flag,
  actions,
  report,
}: {
  study?: Study
  recommendation?: string
  flag?: Critique
  actions: StudyActions
  report?: Report
}) {
  const { verb, detail } = splitRecommendation(recommendation, flag)
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
          <div
            className="font-mono text-3xl font-semibold tracking-tight"
            style={flag ? { color: 'var(--crit-leakage)' } : undefined}
          >
            {verb}
          </div>
          {detail && <p className="mt-1.5 text-sm text-muted-foreground">{detail}</p>}
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
          <Button
            onClick={() => actions.generateReport.mutate()}
            disabled={!study || actions.generateReport.isPending}
          >
            {actions.generateReport.isPending ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                Generating…
              </>
            ) : (
              'Generate report'
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => actions.checkDone.mutate()}
            disabled={!study || actions.checkDone.isPending}
          >
            {actions.checkDone.isPending ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                Grading…
              </>
            ) : (
              'Check done'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
