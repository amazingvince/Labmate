/** A small colored status dot. Motion (a soft ping) is reserved for the one
 *  state that is actually live: a running job. Color is never the only cue: the
 *  status label is exposed to screen readers (callers like the runs table also
 *  show it as adjacent visible text — those mark the dot decorative). */
import type { RunStatus } from '@/api/types'
import { runStatusMeta } from '@/lib/derive'
import { cn } from '@/lib/utils'

export function StatusDot({
  status,
  className,
  pulse = true,
  /** True when an adjacent text label already names the status, so the dot is
   *  purely decorative; otherwise it carries the label for assistive tech. */
  decorative = false,
}: {
  status: RunStatus
  className?: string
  pulse?: boolean
  decorative?: boolean
}) {
  const meta = runStatusMeta(status)
  const running = status === 'running'
  const label = meta.label.toLowerCase()
  return (
    <span
      className={cn('relative inline-flex size-2 shrink-0', className)}
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      title={label}
    >
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
