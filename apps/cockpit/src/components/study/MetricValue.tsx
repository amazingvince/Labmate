/** A calm metric readout. No digit-scramble theatrics — while a run is live it
 *  shows a quiet placeholder; once settled it shows the value in tabular mono. */
import { formatMetricValue, metricLabel } from '@/lib/derive'
import { cn } from '@/lib/utils'

export function MetricValue({
  value,
  metricKey,
  running = false,
  size = 'lg',
  className,
}: {
  value?: number
  metricKey?: string
  running?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const label = metricKey ? metricLabel(metricKey) : undefined
  const sizeClass = size === 'lg' ? 'text-3xl' : size === 'md' ? 'text-xl' : 'text-base'
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span
        className={cn(
          'font-mono font-medium tracking-tight tabular-nums',
          sizeClass,
          running && 'text-muted-foreground',
        )}
      >
        {running ? '· · ·' : value != null ? formatMetricValue(value) : '—'}
      </span>
      {label && (
        <span className="text-xs font-medium text-muted-foreground">
          {running ? 'running…' : label}
        </span>
      )}
    </div>
  )
}
