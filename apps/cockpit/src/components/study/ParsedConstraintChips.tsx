/** Render parsed_constraints as mono chips — the NL→constraint translation made
 *  visible (shared by the feedback form and the evidence timeline). */
import { guardrailLabel } from '@/lib/derive'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export function ParsedConstraintChips({
  parsed,
  className,
}: {
  parsed?: Record<string, unknown>
  className?: string
}) {
  if (!parsed) return null
  const chips: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (value == null) continue
    if (key === 'primary_metric') chips.push(`primary · ${String(value)}`)
    else if (key === 'guardrail' || key === 'guardrails') {
      const list = Array.isArray(value) ? value : [value]
      list.forEach((v) => chips.push(guardrailLabel(String(v))))
    } else chips.push(`${key.replace(/_/g, ' ')} · ${String(value)}`)
  }
  if (chips.length === 0) return null
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {chips.map((c) => (
        <Badge key={c} variant="secondary" className="font-mono text-xs font-normal">
          {c}
        </Badge>
      ))}
    </div>
  )
}
