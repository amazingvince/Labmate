/** Every run with status, model family (joined from its hypothesis), aligned
 *  metrics, seed, tags, and linked critique markers. */
import type { Critique, Hypothesis, Run } from '@/api/types'
import {
  CRITIQUE_COLOR,
  CRITIQUE_LABEL,
  critiquesForRun,
  formatMetricValue,
  metricEntries,
  metricLabel,
  runStatusMeta,
  shortId,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusDot } from '@/components/study/StatusDot'
import { EmptyCard } from '@/components/states/EmptyCard'
import { cn } from '@/lib/utils'

function MetricCells({ run, metricKey }: { run: Run; metricKey?: string }) {
  const entries = metricEntries(run)
  if (entries.length === 0) {
    return (
      <span className="text-muted-foreground">
        {run.status === 'running' || run.status === 'queued' ? '· · ·' : '—'}
      </span>
    )
  }
  const ordered = metricKey
    ? [...entries].sort((a, b) => (a.key === metricKey ? -1 : b.key === metricKey ? 1 : 0))
    : entries
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      {ordered.slice(0, 3).map((m) => (
        <span key={m.key} className="font-mono text-xs tabular-nums">
          <span className="text-muted-foreground">{metricLabel(m.key)} </span>
          {formatMetricValue(m.value)}
        </span>
      ))}
    </span>
  )
}

export function RunsTable({
  runs = [],
  hypotheses = [],
  critiques = [],
  metricKey,
}: {
  runs?: Run[]
  hypotheses?: Hypothesis[]
  critiques?: Critique[]
  metricKey?: string
}) {
  if (runs.length === 0) {
    return <EmptyCard title="No runs yet" hint="Approved experiments launch runs on the Modal runner." />
  }
  const familyOf = (hypId: string) => hypotheses.find((h) => h.id === hypId)?.model_family

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Run</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Metrics</TableHead>
            <TableHead>Seed</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Critiques</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const meta = runStatusMeta(run.status)
            const linked = critiquesForRun(critiques, run.id)
            const flagged = linked.some(
              (c) => c.kind === 'leakage' || c.kind === 'test_set_tuning',
            )
            return (
              <TableRow key={run.id} className={cn(flagged && 'bg-destructive/5')}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <StatusDot status={run.status} />
                    <span className="text-xs capitalize text-muted-foreground">
                      {meta.label.toLowerCase()}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono text-xs">{shortId(run.id, 7)}</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">{run.rationale ?? run.id}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {familyOf(run.hypothesis_id) ?? '—'}
                </TableCell>
                <TableCell>
                  <MetricCells run={run} metricKey={metricKey} />
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {run.seed ?? '—'}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {(run.tags ?? []).slice(0, 3).map((t) => (
                      <Badge key={t} variant="secondary" className="font-mono text-[10px] font-normal">
                        {t}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1">
                    {linked.map((c) => (
                      <Tooltip key={c.id}>
                        <TooltipTrigger asChild>
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: CRITIQUE_COLOR[c.kind] }}
                            role="img"
                            aria-label={`${CRITIQUE_LABEL[c.kind]} critique`}
                          />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <span className="font-medium">{CRITIQUE_LABEL[c.kind]}</span>: {c.finding}
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
