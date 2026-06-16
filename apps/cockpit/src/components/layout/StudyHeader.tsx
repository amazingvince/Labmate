/** Persistent study context — a study switcher, target/metric, the trials gauge,
 *  the lifecycle + live status (or a methodological-flag pill), and the tabs. */
import { ChevronsUpDownIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react'
import type { Critique, Run, Study } from '@/api/types'
import { useStudies } from '@/api/hooks'
import {
  byCreatedAt,
  CRITIQUE_LABEL,
  guardrailFprBound,
  headlineMetric,
  runTargetFpr,
  shortId,
} from '@/lib/derive'
import { navigate, studyHref, type StudyTab } from '@/lib/router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StudyStatusBadge } from '@/components/study/StudyStatusBadge'
import { TabBar } from '@/components/layout/TabBar'

function StudySwitcher({ studyId, tab }: { studyId: string; tab: StudyTab }) {
  const { data } = useStudies()
  const studies = data?.studies ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 font-mono text-xs">
          {shortId(studyId, 10)}
          <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => navigate({ name: 'new' })}>
          <PlusIcon className="size-4" />
          New study
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Studies</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {studies.length === 0 && <DropdownMenuItem disabled>No studies</DropdownMenuItem>}
        {studies.map((s) => (
          <DropdownMenuItem
            key={s.id}
            className="flex-col items-start gap-0.5"
            onSelect={() => navigate({ name: 'study', id: s.id, tab })}
          >
            <span className="font-mono text-xs">{s.id}</span>
            <span className="line-clamp-1 text-xs text-muted-foreground">{s.brief}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TrialsGauge({ runs, study }: { runs: Run[]; study?: Study }) {
  const max = study?.budget?.max_trials
  const trials = runs.length
  const pct = max ? Math.min(100, (trials / max) * 100) : 0
  return (
    <div className="hidden items-center gap-2 lg:flex" title="Trials run against budget">
      <span className="text-xs text-muted-foreground">trials</span>
      <Progress value={pct} className="w-20" />
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {trials}/{max ?? '—'}
      </span>
    </div>
  )
}

function StatusPill({ runs }: { runs: Run[] }) {
  const running = runs.some((r) => r.status === 'running')
  const queued = !running && runs.some((r) => r.status === 'queued')
  const color = running ? 'var(--st-running)' : queued ? 'var(--st-queued)' : 'var(--muted-foreground)'
  const label = running ? 'Running' : queued ? 'Queued' : 'Idle'
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="relative inline-flex size-2">
        {running && (
          <span
            className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="relative inline-flex size-2 rounded-full" style={{ backgroundColor: color }} />
      </span>
      {label}
    </span>
  )
}

function FlagPill({ flag, studyId }: { flag: Critique; studyId: string }) {
  return (
    <a href={studyHref(studyId, 'ledger')} aria-label={`Methodological flag: ${CRITIQUE_LABEL[flag.kind]}`}>
      <Badge variant="destructive" className="gap-1.5">
        <TriangleAlertIcon className="size-3" />
        Flag · {CRITIQUE_LABEL[flag.kind]}
      </Badge>
    </a>
  )
}

/** The headline metric. Shows the human-facing primary_metric and, when it
 *  differs, the recorded study.metric the runner optimizes — so e.g. recall vs
 *  recall_at_fpr isn't hidden. */
function MetricBadge({ study }: { study: Study }) {
  const { name, metric, differ } = headlineMetric(study)
  const primary = name ?? metric
  if (!primary) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="gap-1.5 font-mono font-normal">
          {primary}
          {differ && <span className="text-muted-foreground/80">· {metric}</span>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {differ
          ? `Primary metric "${name}" (what you asked for); the runner optimizes "${metric}".`
          : `Primary metric "${primary}".`}
      </TooltipContent>
    </Tooltip>
  )
}

/** Guardrail FPR bound vs the FPR the latest completed run actually tuned at —
 *  surfaced side-by-side so a 0.10-vs-0.20 gap is visible, not hidden. */
function FprBadge({ study, runs }: { study: Study; runs: Run[] }) {
  const guardExprs = (study.constraints?.guardrails ?? [])
    .map((g) => g.expr)
    .filter((e): e is string => Boolean(e))
  const bound = guardrailFprBound(guardExprs)
  const latestCompleted = byCreatedAt(runs.filter((r) => r.status === 'completed')).slice(-1)[0]
  const runFpr = runTargetFpr(latestCompleted)
  if (bound == null && runFpr == null) return null
  const mismatch = bound != null && runFpr != null && Math.abs(bound - runFpr) > 1e-9
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="gap-1.5 bg-transparent font-mono font-normal"
          style={mismatch ? { borderColor: 'var(--amber)', color: 'var(--amber)' } : undefined}
        >
          FPR ≤ {bound != null ? bound : '—'}
          {runFpr != null && <span className="text-muted-foreground">@ {runFpr}</span>}
          {mismatch && <TriangleAlertIcon className="size-3" />}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Guardrail FPR ≤ {bound ?? '—'}
        {runFpr != null && ` · latest run tuned at FPR ${runFpr}`}
        {mismatch && ' — the run target differs from the guardrail.'}
      </TooltipContent>
    </Tooltip>
  )
}

export function StudyHeader({
  studyId,
  study,
  runs,
  flag,
  tab,
}: {
  studyId: string
  study?: Study
  runs: Run[]
  flag?: Critique
  tab: StudyTab
}) {
  return (
    <div className="sticky top-14 z-20 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
          <StudySwitcher studyId={studyId} tab={tab} />
          {study?.brief && (
            <span className="hidden max-w-sm truncate text-sm text-muted-foreground xl:block">
              {study.brief}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
            {study?.target && (
              <Badge variant="secondary" className="font-mono font-normal">
                target · {study.target}
              </Badge>
            )}
            {study && <MetricBadge study={study} />}
            {study && <FprBadge study={study} runs={runs} />}
            <TrialsGauge runs={runs} study={study} />
            <Separator orientation="vertical" className="hidden h-5 sm:block" />
            {study && <StudyStatusBadge status={study.status} />}
            {flag ? <FlagPill flag={flag} studyId={studyId} /> : <StatusPill runs={runs} />}
          </div>
        </div>
        <TabBar studyId={studyId} active={tab} />
      </div>
    </div>
  )
}
