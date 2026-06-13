/** A small colored status dot. Motion (a soft ping) is reserved for the one
 *  state that is actually live: a running job. */
import type { RunStatus } from '@/api/types'
import { runStatusMeta } from '@/lib/derive'
import { cn } from '@/lib/utils'

export function StatusDot({
  status,
  className,
  pulse = true,
}: {
  status: RunStatus
  className?: string
  pulse?: boolean
}) {
  const meta = runStatusMeta(status)
  const running = status === 'running'
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden="true">
      {running && pulse && (
        <span
          className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
          style={{ backgroundColor: meta.cssVar }}
        />
      )}
      <span
        className="relative inline-flex size-2 rounded-full"
        style={{ backgroundColor: meta.cssVar }}
      />
    </span>
  )
}
