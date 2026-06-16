/** Study lifecycle badge — open / running / done / stopped. "done" = success
 *  styling; "running" = live styling; "stopped" = failed styling. */
import type { Study } from '@/api/types'
import { Badge } from '@/components/ui/badge'

// Widen to string so we can handle 'running' (which lands in the contract in a
// separate branch) without a hard dependency on the not-yet-merged enum member.
type StatusLike = Study['status'] | 'running'

function dot(color: string) {
  return <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
}

export function StudyStatusBadge({ status }: { status: StatusLike }) {
  if (status === 'done') {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 bg-transparent font-medium capitalize"
        style={{ borderColor: 'var(--st-completed)', color: 'var(--st-completed)' }}
      >
        {dot('var(--st-completed)')}
        done
      </Badge>
    )
  }
  if (status === 'running') {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 bg-transparent font-medium capitalize"
        style={{ borderColor: 'var(--st-running)', color: 'var(--st-running)' }}
      >
        {dot('var(--st-running)')}
        running
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
        {dot('var(--st-failed)')}
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
