/** A small badge reporting whether a run honors the study's FPR guardrail.
 *  ✓ (success token) = satisfied, ✗ (leakage token) = violated. When the
 *  guardrail can't be evaluated (no bound or no reported FPR) it renders a muted
 *  dash so the column stays aligned. The tooltip always spells out the numbers. */
import type { Run, Study } from '@/api/types'
import { guardrailStatus } from '@/lib/derive'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

function fmt(n: number | undefined): string {
  return n != null ? n.toFixed(2) : '—'
}

export function GuardrailStatusBadge({
  run,
  study,
  className,
}: {
  run: Run
  study?: Study
  className?: string
}) {
  const { satisfied, actualFpr, bound } = guardrailStatus(run, study)

  // Not evaluable — show a neutral placeholder, not a false pass/fail.
  if (satisfied === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('font-mono text-xs text-muted-foreground', className)}>—</span>
        </TooltipTrigger>
        <TooltipContent>
          {bound != null
            ? `FPR not reported · bound ${fmt(bound)}`
            : 'No FPR guardrail in force'}
        </TooltipContent>
      </Tooltip>
    )
  }

  const color = satisfied ? 'var(--st-completed)' : 'var(--crit-leakage)'
  const glyph = satisfied ? '✓' : '✗'
  const tip = satisfied
    ? `FPR ${fmt(actualFpr)} ≤ bound ${fmt(bound)}`
    : `FPR ${fmt(actualFpr)} > bound ${fmt(bound)}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Badge
            variant="outline"
            className={cn('gap-1 bg-transparent font-mono font-normal tabular-nums', className)}
            style={{ borderColor: color, color }}
          >
            <span aria-hidden="true">{glyph}</span>
            {fmt(actualFpr)}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
