/** The study registry (home) — a filterable grid of study cards. */
import { useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { useStudies } from '@/api/hooks'
import type { Study } from '@/api/types'
import { studyHref } from '@/lib/router'
import { AppShell } from '@/components/layout/AppShell'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StudyStatusBadge } from '@/components/study/StudyStatusBadge'
import { ErrorCard } from '@/components/states/ErrorCard'
import { GridSkeleton } from '@/components/states/LoadingSkeletons'
import { EmptyCard } from '@/components/states/EmptyCard'
import { cn } from '@/lib/utils'

const FILTERS: { key: Study['status'] | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'done', label: 'Done' },
  { key: 'stopped', label: 'Stopped' },
]

export function StudyListView() {
  const [filter, setFilter] = useState<Study['status'] | 'all'>('all')
  const query = useStudies(filter === 'all' ? undefined : filter)
  const studies = query.data?.studies ?? []

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Studies</h1>
            <p className="text-sm text-muted-foreground">
              hypothesis → experiment → evidence → decision
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-lg border p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    filter === f.key
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <Button asChild>
              <a href="#/new">
                <PlusIcon className="size-4" />
                New study
              </a>
            </Button>
          </div>
        </div>

        <div className="mt-8">
          {query.isLoading ? (
            <GridSkeleton />
          ) : query.isError ? (
            <ErrorCard error={query.error} onRetry={() => query.refetch()} />
          ) : studies.length === 0 ? (
            <EmptyCard
              title="No studies yet"
              hint="Start your first study from a business question and a dataset."
            >
              <Button asChild className="mt-2">
                <a href="#/new">
                  <PlusIcon className="size-4" />
                  New study
                </a>
              </Button>
            </EmptyCard>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {studies.map((s) => (
                <a key={s.id} href={studyHref(s.id)} className="group block">
                  <Card className="h-full gap-4 transition-colors hover:border-foreground/20">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {s.id}
                        </span>
                        <StudyStatusBadge status={s.status} />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="line-clamp-3 text-sm leading-relaxed">{s.brief}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {s.target && (
                          <Badge variant="secondary" className="font-mono font-normal">
                            target · {s.target}
                          </Badge>
                        )}
                        {s.metric && (
                          <Badge variant="secondary" className="font-mono font-normal">
                            {s.metric}
                          </Badge>
                        )}
                        {s.task_type && (
                          <Badge variant="outline" className="bg-transparent font-normal">
                            {s.task_type}
                          </Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
