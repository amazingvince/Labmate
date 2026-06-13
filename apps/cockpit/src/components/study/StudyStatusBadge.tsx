/** Study lifecycle badge (open / done / stopped). */
import type { Study } from '@/api/types'
import { Badge } from '@/components/ui/badge'

export function StudyStatusBadge({ status }: { status: Study['status'] }) {
  if (status === 'done') {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 bg-transparent font-medium capitalize"
        style={{ borderColor: 'var(--st-completed)', color: 'var(--st-completed)' }}
      >
        <span className="size-1.5 rounded-full" style={{ backgroundColor: 'var(--st-completed)' }} />
        done
      </Badge>
    )
  }
  if (status === 'stopped') {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 bg-transparent font-medium capitalize"
        style={{ borderColor: 'var(--st-failed)', color: 'var(--st-failed)' }}
      >
        <span className="size-1.5 rounded-full" style={{ backgroundColor: 'var(--st-failed)' }} />
        stopped
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="capitalize">
      open
    </Badge>
  )
}
