/**
 * The GENERATED per-study data + metric contract.
 *
 * `GET /api/studies/{id}` returns these under `dataset_version.contracts = { data, metric }`
 * (built by apps/web/src/contracts.js for ANY uploaded dataset — this is what makes
 * "the contract is the product" dataset-agnostic, not just the golden sla_tickets docs).
 *
 * The canonical `DatasetVersion` type (@labmate/api-types) does not yet carry `contracts`,
 * so we read it defensively off the dataset version. Studies written before this existed
 * (older rows, some golden-path runs) simply have no `contracts` — we render nothing.
 */
import type { ReactNode } from 'react'
import type { DatasetVersion } from '@/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

// ---- Contract shapes (mirror apps/web/src/contracts.js — buildContracts()). ----
// Kept local because @labmate/api-types' DatasetVersion has no `contracts` field yet.

type LeakageCandidate = { column: string; reason?: string }

type SplitStrategy = {
  strategy: string
  ratios?: number[]
  seed?: number
  time_col?: string
}

type DataContract = {
  target?: string
  target_definition?: string | null
  prediction_time_assumption?: string
  leakage_candidates?: LeakageCandidate[]
  safe_features?: string[]
  categoricals?: string[]
  datetime_columns?: string[]
  numeric?: string[]
  row_count?: number
  missingness?: Record<string, number>
  split_strategy?: SplitStrategy
  banned_columns?: string[]
}

type MetricContract = {
  task_type?: string
  primary_metric?: string
  rationale?: string
  guardrails?: string[]
  secondary_metrics?: string[]
  segments?: string[]
  threshold_tuned_on?: string | null
}

type Contracts = { data?: DataContract | null; metric?: MetricContract | null }

/** DatasetVersion does not declare `contracts` in the canonical types — read it off safely. */
function contractsOf(dataset?: DatasetVersion): Contracts | undefined {
  const c = (dataset as { contracts?: Contracts } | undefined)?.contracts
  return c && (c.data || c.metric) ? c : undefined
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  )
}

function ChipList({ items, mono = true }: { items?: string[]; mono?: boolean }) {
  if (!items || items.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <Badge
          key={it}
          variant="secondary"
          className={mono ? 'font-mono font-normal' : 'font-normal'}
        >
          {it}
        </Badge>
      ))}
    </div>
  )
}

function splitLine(s?: SplitStrategy): string | undefined {
  if (!s || !s.strategy) return undefined
  const ratios =
    s.ratios && s.ratios.length === 3
      ? s.ratios.map((r) => Math.round(r * 100)).join('/')
      : undefined
  const col = s.time_col ? ` (${s.time_col})` : ''
  const seed = s.seed != null ? ` · seed ${s.seed}` : ''
  return `${s.strategy}${col}${ratios ? ` ${ratios}` : ''}${seed}`.trim()
}

function DataSection({ data }: { data: DataContract }) {
  const split = splitLine(data.split_strategy)
  const leakage = data.leakage_candidates ?? []
  return (
    <div className="space-y-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Data contract
      </p>

      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-6 gap-y-2.5 text-sm">
        <Field label="Target">
          <span className="font-mono">{data.target ?? '—'}</span>
        </Field>
        {data.target_definition && (
          <Field label="Definition">
            <span className="text-foreground/80">{data.target_definition}</span>
          </Field>
        )}
        {data.prediction_time_assumption && (
          <Field label="Prediction time">
            <span className="text-foreground/80">{data.prediction_time_assumption}</span>
          </Field>
        )}
        <Field label="Split">
          {split ? <span className="font-mono text-xs">{split}</span> : '—'}
        </Field>
        <Field label="Rows">
          <span className="font-mono tabular-nums">
            {data.row_count != null ? data.row_count.toLocaleString() : '—'}
          </span>
        </Field>
        <Field label="Columns">
          <span className="text-foreground/80">
            <span className="tabular-nums">{data.categoricals?.length ?? 0}</span> categorical ·{' '}
            <span className="tabular-nums">{data.datetime_columns?.length ?? 0}</span> datetime ·{' '}
            <span className="tabular-nums">{data.numeric?.length ?? 0}</span> numeric
          </span>
        </Field>
      </dl>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Safe features (available at prediction time)</p>
        <ChipList items={data.safe_features} />
      </div>

      {leakage.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium" style={{ color: 'var(--crit-leakage)' }}>
            Leakage candidates · default-banned
          </p>
          <ul className="space-y-1.5">
            {leakage.map((l) => (
              <li
                key={l.column}
                className="rounded-md border bg-destructive/5 px-2.5 py-1.5 text-sm"
                style={{ borderColor: 'var(--crit-leakage)' }}
              >
                <span className="font-mono" style={{ color: 'var(--crit-leakage)' }}>
                  {l.column}
                </span>
                {l.reason && (
                  <span className="ml-2 text-muted-foreground">— {l.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function MetricSection({ metric }: { metric: MetricContract }) {
  return (
    <div className="space-y-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Metric contract
      </p>

      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-6 gap-y-2.5 text-sm">
        <Field label="Task">
          <span className="font-mono">{metric.task_type ?? '—'}</span>
        </Field>
        <Field label="Primary">
          <span className="font-mono">{metric.primary_metric ?? '—'}</span>
        </Field>
        {metric.rationale && (
          <Field label="Why">
            <span className="text-foreground/80">{metric.rationale}</span>
          </Field>
        )}
        {metric.threshold_tuned_on && (
          <Field label="Threshold on">
            <span className="font-mono">{metric.threshold_tuned_on}</span>
          </Field>
        )}
      </dl>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Guardrails</p>
        {metric.guardrails && metric.guardrails.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {metric.guardrails.map((g) => (
              <Badge
                key={g}
                variant="outline"
                className="bg-transparent font-mono font-normal"
                style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }}
              >
                {g}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Secondary metrics</p>
        <ChipList items={metric.secondary_metrics} />
      </div>

      {metric.segments && metric.segments.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Segments</p>
          <ChipList items={metric.segments} />
        </div>
      )}
    </div>
  )
}

/**
 * Renders the generated per-study data + metric contract. Returns null when the
 * study carries no `contracts` (older rows / golden path) so callers can drop it.
 */
export function ContractCard({ dataset }: { dataset?: DatasetVersion }) {
  const contracts = contractsOf(dataset)
  if (!contracts) return null
  const { data, metric } = contracts
  return (
    <Card>
      <CardHeader>
        <CardTitle>Generated contract</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {data && <DataSection data={data} />}
        {data && metric && <Separator />}
        {metric && <MetricSection metric={metric} />}
      </CardContent>
    </Card>
  )
}
