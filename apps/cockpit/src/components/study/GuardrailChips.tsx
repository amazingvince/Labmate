/** Primary-metric + guardrail + banned-count chips, derived from parsed feedback. */
import type { StudyDetail } from '@/api/types'
import { deriveGuardrails, guardrailLabel } from '@/lib/derive'
import { Badge } from '@/components/ui/badge'

export function GuardrailChips({
  detail,
  banned,
}: {
  detail: StudyDetail
  banned: Set<string>
}) {
  const guards = deriveGuardrails(detail)
  const empty =
    !guards.primaryMetric && guards.guardrails.length === 0 && banned.size === 0
  if (empty) {
    return (
      <p className="text-xs text-muted-foreground">
        None recorded yet — add via the feedback box.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {guards.primaryMetric && (
        <Badge variant="secondary" className="font-mono font-normal">
          primary · {guards.primaryMetric}
        </Badge>
      )}
      {guards.guardrails.map((g) => (
        <Badge
          key={g}
          variant="outline"
          className="bg-transparent font-mono font-normal"
          style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }}
        >
          {guardrailLabel(g)}
        </Badge>
      ))}
      {banned.size > 0 && (
        <Badge
          variant="outline"
          className="bg-transparent font-normal"
          style={{ borderColor: 'var(--crit-leakage)', color: 'var(--crit-leakage)' }}
        >
          {banned.size} banned {banned.size === 1 ? 'col' : 'cols'}
        </Badge>
      )}
    </div>
  )
}
