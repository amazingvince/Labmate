/** The experiment leaderboard — the Experiments-tab centerpiece.
 *
 *  A real, sortable <table> of every run: model, the study's PRIMARY metric with
 *  its delta-vs-baseline, the supporting AUCs + Brier, the FPR-guardrail badge,
 *  seed, and status. The best run is starred; a promoted run carries a subtle left
 *  accent. Each row expands inline into a drill-down (params, prevalence/threshold
 *  context, baseline comparison, provenance, the feedback that shaped it, tags,
 *  rationale, and artifacts).
 *
 *  Critiques are NOT shown per-run: the backend never sets `Critique.target_run_id`,
 *  so there is no real run→critique link. Critiques live at study scope (the
 *  evidence ledger + the methodological-flag banner). */
import { Fragment, useMemo, useState } from 'react'
import { ChevronRightIcon, StarIcon } from 'lucide-react'
import type { Decision, Feedback, Hypothesis, Report, Run, Study } from '@/api/types'
import {
  appliedFeedback,
  baselineRun,
  bestRun,
  byCreatedAt,
  formatMetricValue,
  guardrailStatus,
  type MetricDelta,
  metricDelta,
  metricLabel,
  runStatusMeta,
} from '@/lib/derive'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusDot } from '@/components/study/StatusDot'
import { GuardrailStatusBadge } from '@/components/study/GuardrailStatusBadge'
import { EmptyCard } from '@/components/states/EmptyCard'
import { cn } from '@/lib/utils'

// Metric columns shown after the primary one. Each maps to a run.metrics key.
const SECONDARY_COLS: { key: SortKey; label: string }[] = [
  { key: 'roc_auc', label: 'ROC-AUC' },
  { key: 'pr_auc', label: 'PR-AUC' },
  { key: 'brier', label: 'Brier' },
]

type SortKey = 'primary' | 'roc_auc' | 'pr_auc' | 'brier' | 'seed' | 'status'
type SortDir = 'asc' | 'desc'

const STATUS_RANK: Record<string, number> = { completed: 3, running: 2, queued: 1, failed: 0 }

function modelOf(run: Run, hypotheses: Hypothesis[]): string {
  const fromParams = run.params?.model
  if (typeof fromParams === 'string' && fromParams) return fromParams
  const fromFamily = hypotheses.find((h) => h.id === run.hypothesis_id)?.model_family
  return fromFamily ?? '—'
}

function metricNum(run: Run | undefined, key: string): number | undefined {
  const v = run?.metrics?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function pct(n: number | undefined): string {
  return n != null ? `${(n * 100).toFixed(1)}%` : '—'
}

function shortHash(h: string): string {
  return h.length > 8 ? h.slice(0, 8) : h
}

function defaultDirFor(key: SortKey): SortDir {
  // Error metrics + seed default ascending; everything else descending (best first).
  return key === 'brier' || key === 'seed' ? 'asc' : 'desc'
}

function promotedFrom(decisions: Decision[]): string | undefined {
  let id: string | undefined
  for (const d of byCreatedAt(decisions)) {
    if (d.action === 'promote' && d.promoted_run_id) id = d.promoted_run_id
  }
  return id
}

/** A subtle, signed metric delta. Positive (better) gets the success token;
 *  negative is muted (not alarming) — a broken guardrail is flagged separately. */
function Delta({ delta }: { delta: MetricDelta }) {
  const sign = delta.abs > 0 ? '+' : ''
  return (
    <span
      className={cn('tabular-nums', !delta.better && 'text-muted-foreground')}
      style={delta.better ? { color: 'var(--st-completed)' } : undefined}
    >
      {sign}
      {formatMetricValue(delta.abs)}
    </span>
  )
}

/** Sortable column header — a real button so it's keyboard-operable, with aria-sort. */
function SortHeader({
  label,
  col,
  sort,
  onSort,
  className,
  align = 'left',
}: {
  label: string
  col: SortKey
  sort: { key: SortKey; dir: SortDir }
  onSort: (k: SortKey) => void
  className?: string
  align?: 'left' | 'right'
}) {
  const active = sort.key === col
  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
  return (
    <TableHead className={className} aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          align === 'right' && 'flex-row-reverse',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        <span aria-hidden="true" className="text-[10px] leading-none">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </TableHead>
  )
}

function DrillSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  )
}

/** The inline drill-down panel for one run. */
function RunDetail({
  run,
  baseline,
  feedback,
  primaryKey,
}: {
  run: Run
  baseline: Run | undefined
  feedback?: Feedback[]
  primaryKey?: string
}) {
  const paramEntries: [string, string][] = Object.entries(run.params ?? {})
    .filter(([k]) => k !== 'tags')
    .map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)])

  const prevTrain = metricNum(run, 'prevalence_train')
  const prevTest = metricNum(run, 'prevalence_test')
  const targetFpr = metricNum(run, 'target_fpr')
  const threshold = metricNum(run, 'threshold')

  const isBaselineRow = baseline?.id === run.id
  const delta = baseline && !isBaselineRow ? metricDelta(run, baseline, primaryKey) : undefined
  const fb = appliedFeedback(run, feedback)

  const artifacts = (run.artifacts ?? {}) as Record<string, unknown>
  const artifactNames = Object.keys(artifacts).filter((k) => k !== 'features')
  const features = Array.isArray(artifacts.features) ? (artifacts.features as unknown[]) : []

  const provEntries: [string, string][] = []
  if (run.code_hash) provEntries.push(['code', run.code_hash])
  if (run.dataset_hash) provEntries.push(['data', run.dataset_hash])
  if (run.seed != null) provEntries.push(['seed', String(run.seed)])

  return (
    <div className="grid gap-x-8 gap-y-5 bg-muted/30 p-4 md:grid-cols-2">
      <DrillSection title="Params">
        {paramEntries.length ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            {paramEntries.map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-all text-foreground/90">{v}</dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </DrillSection>

      <DrillSection title="Context">
        <ul className="space-y-1 text-xs text-foreground/90">
          <li>
            <span className="text-muted-foreground">prevalence</span> train {pct(prevTrain)} / test{' '}
            {pct(prevTest)}
          </li>
          <li>
            <span className="text-muted-foreground">tuned</span>{' '}
            {targetFpr != null ? `@ FPR ${targetFpr.toFixed(2)}` : '@ FPR —'}
            {threshold != null ? ` → threshold ${threshold.toFixed(3)}` : ''}
          </li>
        </ul>
      </DrillSection>

      <DrillSection title="vs dummy baseline">
        {delta ? (
          <p className="font-mono text-xs tabular-nums">
            {primaryKey ? metricLabel(primaryKey) : 'primary'} <Delta delta={delta} />{' '}
            <span className="text-muted-foreground">
              ({formatMetricValue(metricNum(baseline, primaryKey ?? '') ?? Number.NaN)} →{' '}
              {formatMetricValue(metricNum(run, primaryKey ?? '') ?? Number.NaN)})
            </span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {isBaselineRow ? 'this is the baseline' : '—'}
          </p>
        )}
      </DrillSection>

      <DrillSection title="Provenance">
        {provEntries.length ? (
          <p className="font-mono text-xs">
            {provEntries.map(([k, v], i) => (
              <span key={k}>
                {i > 0 && <span className="text-muted-foreground"> · </span>}
                <span className="text-muted-foreground">{k} </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default">{k === 'seed' ? v : shortHash(v)}</span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono">{v}</TooltipContent>
                </Tooltip>
              </span>
            ))}
          </p>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </DrillSection>

      <DrillSection title="Shaped by">
        {fb ? (
          <div className="space-y-1 text-xs">
            <p className="text-foreground/90">{fb.content}</p>
            {fb.parsed_constraints && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(fb.parsed_constraints).map(([k, v]) => (
                  <Badge key={k} variant="secondary" className="font-mono text-[10px] font-normal">
                    {k}: {String(v)}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </DrillSection>

      <DrillSection title="Tags">
        {(run.tags ?? []).length ? (
          <div className="flex flex-wrap gap-1">
            {(run.tags ?? []).map((t) => (
              <Badge key={t} variant="secondary" className="font-mono text-[10px] font-normal">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </DrillSection>

      <div className="space-y-1.5 md:col-span-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Rationale
        </p>
        <p className="text-xs text-foreground/90">{run.rationale ?? '—'}</p>
      </div>

      <div className="space-y-1.5 md:col-span-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Artifacts
        </p>
        {artifactNames.length || features.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {artifactNames.map((name) => (
              <Badge
                key={name}
                variant="outline"
                className="bg-transparent font-mono text-[10px] font-normal"
              >
                {name}
                {name === 'dummy' && <span className="ml-1 text-muted-foreground">· baseline</span>}
              </Badge>
            ))}
            {features.length > 0 && (
              <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                {features.length} features
              </Badge>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>

      <Separator className="md:col-span-2" />
    </div>
  )
}

export function RunsTable({
  runs = [],
  hypotheses = [],
  study,
  report,
  decisions = [],
  feedback = [],
  metricKey,
}: {
  runs?: Run[]
  hypotheses?: Hypothesis[]
  study?: Study
  report?: Report
  decisions?: Decision[]
  feedback?: Feedback[]
  /** Accepted for call-site compatibility; critiques are study-scoped, not per-run. */
  critiques?: unknown
  metricKey?: string
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'primary', dir: 'desc' })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const baseline = useMemo(() => baselineRun(runs), [runs])
  const best = useMemo(
    () => bestRun(runs, metricKey, report, decisions),
    [runs, metricKey, report, decisions],
  )
  const promotedId = useMemo(() => promotedFrom(decisions), [decisions])

  const ordered = useMemo(() => {
    const chrono = byCreatedAt(runs)
    const dir = sort.dir === 'asc' ? 1 : -1
    const valueOf = (r: Run): number | undefined => {
      switch (sort.key) {
        case 'primary':
          return metricNum(r, metricKey ?? '')
        case 'seed':
          return typeof r.seed === 'number' ? r.seed : undefined
        case 'status':
          return STATUS_RANK[r.status]
        default:
          return metricNum(r, sort.key)
      }
    }
    // Missing values always sort last, regardless of direction.
    return [...chrono].sort((a, b) => {
      const av = valueOf(a)
      const bv = valueOf(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return (av - bv) * dir
    })
  }, [runs, sort, metricKey])

  if (runs.length === 0) {
    return <EmptyCard title="No runs yet" hint="Approved experiments launch runs on the Modal runner." />
  }

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: defaultDirFor(key) },
    )

  const primaryLabel = metricKey ? metricLabel(metricKey) : 'Primary'
  // caret + model + primary + Δ + secondaries + guardrail + seed + status
  const colSpan = 4 + SECONDARY_COLS.length + 3

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="min-w-[60rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Model</TableHead>
            <SortHeader label={primaryLabel} col="primary" sort={sort} onSort={onSort} className="text-right" align="right" />
            <TableHead className="text-right text-xs font-medium text-muted-foreground">Δ base</TableHead>
            {SECONDARY_COLS.map((c) => (
              <SortHeader
                key={c.key}
                label={c.label}
                col={c.key}
                sort={sort}
                onSort={onSort}
                className="text-right"
                align="right"
              />
            ))}
            <TableHead>Guardrail</TableHead>
            <SortHeader label="Seed" col="seed" sort={sort} onSort={onSort} />
            <SortHeader label="Status" col="status" sort={sort} onSort={onSort} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((run) => {
            const isOpen = expanded.has(run.id)
            const isBest = best?.id === run.id
            const isPromoted = promotedId === run.id
            const isBaselineRow = baseline?.id === run.id
            const meta = runStatusMeta(run.status)
            const primary = metricNum(run, metricKey ?? '')
            const delta = baseline && !isBaselineRow ? metricDelta(run, baseline, metricKey) : undefined
            const violated = guardrailStatus(run, study).satisfied === false

            return (
              <Fragment key={run.id}>
                <TableRow
                  data-state={isOpen ? 'open' : undefined}
                  className={cn(
                    'cursor-pointer',
                    isPromoted && 'border-l-2 border-l-[var(--st-completed)]',
                    violated && 'bg-destructive/5',
                    isOpen && 'bg-muted/40',
                  )}
                  onClick={() => toggle(run.id)}
                >
                  <TableCell className="w-8 pr-0">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? 'Collapse run details' : 'Expand run details'}
                      className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(run.id)
                      }}
                    >
                      <ChevronRightIcon className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                    </button>
                  </TableCell>
                  <TableCell className={cn('font-mono text-xs', isPromoted && 'font-medium')}>
                    <span className="inline-flex items-center gap-1.5">
                      {isBest && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <StarIcon
                                className="size-3.5 fill-current"
                                style={{ color: 'var(--amber)' }}
                                aria-label="Best run"
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Best run for the study</TooltipContent>
                        </Tooltip>
                      )}
                      {modelOf(run, hypotheses)}
                      {isBaselineRow && (
                        <Badge variant="secondary" className="text-[10px] font-normal">
                          baseline
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {primary != null ? formatMetricValue(primary) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {delta ? <Delta delta={delta} /> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  {SECONDARY_COLS.map((c) => {
                    const v = metricNum(run, c.key)
                    return (
                      <TableCell
                        key={c.key}
                        className="text-right font-mono text-xs tabular-nums text-muted-foreground"
                      >
                        {v != null ? formatMetricValue(v) : '—'}
                      </TableCell>
                    )
                  })}
                  <TableCell>
                    <GuardrailStatusBadge run={run} study={study} />
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                    {run.seed ?? '—'}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <StatusDot status={run.status} decorative />
                      <span className="text-xs capitalize text-muted-foreground">
                        {meta.label.toLowerCase()}
                      </span>
                    </span>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={colSpan} className="p-0">
                      <RunDetail
                        run={run}
                        baseline={baseline}
                        feedback={feedback}
                        primaryKey={metricKey}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
