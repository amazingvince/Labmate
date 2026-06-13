/** Vercel-style underlined tab navigation. Tabs are real anchors (URL-driven),
 *  so deep-linking, back/forward, and middle-click all work natively. */
import { STUDY_TABS, STUDY_TAB_LABELS, studyHref, type StudyTab } from '@/lib/router'
import { cn } from '@/lib/utils'

export function TabBar({ studyId, active }: { studyId: string; active: StudyTab }) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Study sections">
      {STUDY_TABS.map((tab) => {
        const isActive = tab === active
        return (
          <a
            key={tab}
            href={studyHref(studyId, tab)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              isActive
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {STUDY_TAB_LABELS[tab]}
          </a>
        )
      })}
    </nav>
  )
}
