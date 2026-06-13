/** A badge for a critique kind, tinted by its semantic color, with the finding
 *  in a tooltip. */
import type { CritiqueKind } from '@/api/types'
import { CRITIQUE_COLOR, CRITIQUE_LABEL } from '@/lib/derive'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function CritiqueBadge({
  kind,
  finding,
  className,
}: {
  kind: CritiqueKind
  finding?: string
  className?: string
}) {
  const color = CRITIQUE_COLOR[kind]
  const badge = (
    <Badge
      variant="outline"
      className={cn('gap-1.5 bg-transparent font-medium', className)}
      style={{ borderColor: color, color }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {CRITIQUE_LABEL[kind]}
    </Badge>
  )
  if (!finding) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{finding}</TooltipContent>
    </Tooltip>
  )
}
