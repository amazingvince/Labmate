/** A restrained empty state — a dashed card with an icon, a heading, and a hint. */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function EmptyCard({
  icon,
  title,
  hint,
  className,
  children,
}: {
  icon?: ReactNode
  title: string
  hint?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      {icon && <div className="text-muted-foreground/60 [&>svg]:size-6">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}
