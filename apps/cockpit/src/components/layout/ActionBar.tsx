/** Persistent footer: the agent's recommendation (a link to the Report tab),
 *  the feedback affordance, and the report/grade controls — always reachable.
 *  Report/grade controls disable when the cockpit is locked. */
import { useState } from 'react'
import { Loader2Icon, MessageSquareIcon } from 'lucide-react'
import type { Critique, Study } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useHasApiToken } from '@/api/token'
import { studyHref } from '@/lib/router'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  const locked = !useHasApiToken()
  const { verb, detail } = splitRecommendation(recommendation, flag)
  // verb is '' for prose recommendations — fall back to the detail in the pill.
  const headline = verb || (detail ? '' : 'STANDING BY')

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
          {headline && (
            <span
              className="font-mono text-sm font-semibold"
              style={flag ? { color: 'var(--crit-leakage)' } : undefined}
            >
              {headline}
            </span>
          )}
          {detail && (
            <span className="min-w-0 truncate text-sm text-muted-foreground sm:block">
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
          <LockableButton
            locked={locked}
            variant="outline"
            disabled={!study || actions.generateReport.isPending}
            pending={actions.generateReport.isPending}
            onClick={() => actions.generateReport.mutate()}
          >
            Generate report
          </LockableButton>
          <LockableButton
            locked={locked}
            disabled={!study || actions.checkDone.isPending}
            pending={actions.checkDone.isPending}
            onClick={() => actions.checkDone.mutate()}
          >
            Check done
          </LockableButton>
        </div>
      </div>
    </div>
  )
}

/** A footer write button that disables + explains itself when locked. */
function LockableButton({
  locked,
  variant,
  disabled,
  pending,
  onClick,
  children,
}: {
  locked: boolean
  variant?: 'default' | 'outline'
  disabled?: boolean
  pending?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const btn = (
    <Button size="sm" variant={variant} disabled={locked || disabled} onClick={onClick}>
      {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : children}
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
