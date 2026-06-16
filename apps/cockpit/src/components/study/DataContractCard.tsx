/** The data contract: row count, split strategy, and the column table where
 *  leakage-flagged columns carry a [Ban] action (disabled until unlocked). */
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react'
import type { ColumnProfile, DatasetVersion } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useHasApiToken } from '@/api/token'
import { shortId } from '@/lib/derive'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyCard } from '@/components/states/EmptyCard'
import { cn } from '@/lib/utils'

// Columns with a missing-fraction above this read as a data-quality warning.
const HIGH_MISSING = 0.4

function splitLine(ds: DatasetVersion): string | undefined {
  const s = ds.split_strategy
  if (!s) return undefined
  const ratios =
    s.ratios?.length === 3 ? s.ratios.map((r) => Math.round(r * 100)).join('/') : undefined
  const col = s.time_col ? `(${s.time_col})` : ''
  return `${s.strategy}${col} ${ratios ?? ''} · seed ${s.seed}`.trim()
}

/**
 * The cockpit's `profile_dataset` writes richer per-column stats (cardinality,
 * example_values, missing_pct) than the canonical `ColumnProfile` type declares —
 * they ride along on `dataset_version.columns`. Read them off defensively so a
 * study profiled before they existed simply omits them.
 */
type RichColumn = ColumnProfile & {
  cardinality?: number
  missing_pct?: number
  example_values?: unknown[]
}

function distinctCount(col: RichColumn): number | undefined {
  const v = col.cardinality ?? col.n_unique
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function missingFraction(col: RichColumn): number {
  if (typeof col.missing_fraction === 'number') return col.missing_fraction
  if (typeof col.missing_pct === 'number') return col.missing_pct / 100
  return 0
}

function exampleValues(col: RichColumn): string[] {
  return Array.isArray(col.example_values)
    ? col.example_values.map((v) => String(v)).filter((s) => s.length > 0).slice(0, 5)
    : []
}

export function DataContractCard({
  dataset,
  banned,
  actions,
}: {
  dataset?: DatasetVersion
  banned: Set<string>
  actions: StudyActions
}) {
  if (!dataset) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Data contract</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyCard title="No contract" hint="Run profile_dataset to write the data contract." />
        </CardContent>
      </Card>
    )
  }

  const columns = dataset.columns ?? []
  const split = splitLine(dataset)
  const banPending = actions.banColumn.isPending ? actions.banColumn.variables : undefined
  const locked = !useHasApiToken()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data contract</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-3xl font-medium tabular-nums">
            {dataset.row_count.toLocaleString()}
          </span>
          <span className="text-sm text-muted-foreground">rows</span>
          {dataset.file_hash && (
            <Badge variant="secondary" className="ml-auto font-mono font-normal" title={dataset.file_hash}>
              {shortId(dataset.file_hash, 8)}
            </Badge>
          )}
        </div>

        {split && <p className="font-mono text-xs text-muted-foreground">{split}</p>}

        {columns.length === 0 ? (
          <EmptyCard title="No columns profiled" />
        ) : (
          // overflow-x-auto (not overflow-hidden) so the table scrolls rather
          // than clips on narrow viewports.
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[40rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Column</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Distinct</TableHead>
                  <TableHead>Missing</TableHead>
                  <TableHead>Examples</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(columns as RichColumn[]).map((col, i) => {
                  const isBanned = banned.has(col.name)
                  const leaky = col.is_candidate_leakage || isBanned
                  const miss = missingFraction(col)
                  const highMissing = miss > HIGH_MISSING
                  const distinct = distinctCount(col)
                  const examples = exampleValues(col)
                  return (
                    <TableRow
                      key={`${col.name}-${i}`}
                      className={cn(leaky && 'bg-destructive/5')}
                    >
                      <TableCell className="font-mono">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cn(isBanned && 'text-muted-foreground line-through')}>
                            {col.name}
                          </span>
                          {col.is_candidate_leakage && col.leakage_reason && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <TriangleAlertIcon
                                  className="size-3.5"
                                  style={{ color: 'var(--crit-leakage)' }}
                                />
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">{col.leakage_reason}</TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{col.dtype}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {distinct != null ? distinct.toLocaleString() : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'w-8 font-mono text-xs tabular-nums',
                              highMissing ? 'font-medium' : 'text-muted-foreground',
                            )}
                            style={highMissing ? { color: 'var(--amber)' } : undefined}
                          >
                            {(miss * 100).toFixed(0)}%
                          </span>
                          <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full"
                              style={{
                                width: `${Math.min(100, miss * 100)}%`,
                                backgroundColor: highMissing
                                  ? 'var(--amber)'
                                  : 'var(--muted-foreground)',
                                opacity: highMissing ? 1 : 0.6,
                              }}
                            />
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {examples.length ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block max-w-[12rem] cursor-default truncate font-mono text-xs text-muted-foreground">
                                {examples.join(', ')}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <span className="font-mono text-xs">{examples.join(', ')}</span>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {isBanned ? (
                          <Badge
                            variant="outline"
                            className="bg-transparent font-normal"
                            style={{ borderColor: 'var(--crit-leakage)', color: 'var(--crit-leakage)' }}
                          >
                            banned
                          </Badge>
                        ) : col.is_candidate_leakage ? (
                          locked ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-destructive hover:text-destructive"
                                    disabled
                                  >
                                    Ban
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>Unlock to enable writes</TooltipContent>
                            </Tooltip>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-destructive hover:text-destructive"
                              disabled={banPending === col.name}
                              onClick={() => actions.banColumn.mutate(col.name)}
                            >
                              {banPending === col.name ? (
                                <Loader2Icon className="size-3.5 animate-spin" />
                              ) : (
                                'Ban'
                              )}
                            </Button>
                          )
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
