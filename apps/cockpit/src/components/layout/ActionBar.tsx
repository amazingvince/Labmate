/** Persistent footer: the agent's recommendation (a link to the Report tab),
 *  the feedback affordance, and the report/grade controls — always reachable. */
import { useState } from 'react'
import { Loader2Icon, MessageSquareIcon } from 'lucide-react'
import type { Critique, Study } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { studyHref } from '@/lib/router'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FeedbackForm } from '@/components/study/FeedbackForm'
import { splitRecommendation } from '@/components/study/RecommendationPanel'
import { cn } from '@/lib/utils'

export function ActionBar({
  studyId,
  study,
  recommendation,
  flag,
  actions,
}: {
  studyId: string
  study?: Study
  recommendation?: string
  flag?: Critique
  actions: StudyActions
}) {
  const [open, setOpen] = useState(false)
  const { verb, detail } = splitRecommendation(recommendation, flag)

  return (
    <div className="sticky bottom-0 z-30 border-t bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <a
          href={studyHref(studyId, 'report')}
          className={cn(
            'flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-1.5 transition-colors hover:bg-accent/50',
            flag && 'border-destructive/40',
          )}
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {flag ? 'Flag' : 'Recommendation'}
          </span>
          <span
            className="font-mono text-sm font-semibold"
            style={flag ? { color: 'var(--crit-leakage)' } : undefined}
          >
            {verb}
          </span>
          {detail && (
            <span className="hidden min-w-0 truncate text-sm text-muted-foreground sm:block">
              {detail}
            </span>
          )}
        </a>

        <div className="ml-auto flex items-center gap-2">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                <MessageSquareIcon className="size-3.5" />
                Feedback
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(28rem,calc(100vw-2rem))]">
              <FeedbackForm
                study={study}
                actions={actions}
                autoFocus
                onSent={() => setOpen(false)}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="sm"
            onClick={() => actions.generateReport.mutate()}
            disabled={!study || actions.generateReport.isPending}
          >
            {actions.generateReport.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              'Generate report'
            )}
          </Button>
          <Button
            size="sm"
            onClick={() => actions.checkDone.mutate()}
            disabled={!study || actions.checkDone.isPending}
          >
            {actions.checkDone.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              'Check done'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
