/** The application frame: a slim top bar (brand + theme toggle), the scrollable
 *  content, and an optional sticky footer (the study action bar). */
import type { ReactNode } from 'react'
import { ModeToggle } from '@/components/layout/ModeToggle'
import { UnlockButton } from '@/components/layout/UnlockButton'

export function AppShell({
  children,
  footer,
}: {
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          <a href="#/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="grid size-6 place-items-center rounded-md bg-foreground text-[11px] font-bold text-background">
              L
            </span>
            Labmate
          </a>
          <div className="ml-auto flex items-center gap-1.5">
            <UnlockButton />
            <ModeToggle />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      {footer}
    </div>
  )
}
