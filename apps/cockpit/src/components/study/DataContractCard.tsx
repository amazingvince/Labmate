/** The data contract: row count, split strategy, and the column table where
 *  leakage-flagged columns carry a [Ban] action. */
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react'
import type { DatasetVersion } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
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

function splitLine(ds: DatasetVersion): string | undefined {
  const s = ds.split_strategy
  if (!s) return undefined
  const ratios =
    s.ratios?.length === 3 ? s.ratios.map((r) => Math.round(r * 100)).join('/') : undefined
  const col = s.time_col ? `(${s.time_col})` : ''
  return `${s.strategy}${col} ${ratios ?? ''} · seed ${s.seed}`.trim()
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
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Column</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Missing</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {columns.map((col, i) => {
                  const isBanned = banned.has(col.name)
                  const leaky = col.is_candidate_leakage || isBanned
                  const miss = col.missing_fraction ?? 0
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
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="w-8 font-mono text-xs tabular-nums text-muted-foreground">
                            {(miss * 100).toFixed(0)}%
                          </span>
                          <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full bg-muted-foreground/60"
                              style={{ width: `${Math.min(100, miss * 100)}%` }}
                            />
                          </span>
                        </div>
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
