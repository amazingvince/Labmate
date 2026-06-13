/** §05 RUN TABLE — every run with status LED, model family (joined from its
 *  hypothesis), aligned metrics, seed, tags, and linked critique badges. */
import type { Critique, Hypothesis, Run } from '../../api/types'
import {
  CRITIQUE_COLOR,
  CRITIQUE_LABEL,
  critiquesForRun,
  formatMetricValue,
  metricEntries,
  metricLabel,
  runStatusMeta,
  shortId,
} from '../../lib/derive'
import { EmptyState, Panel, SkeletonRows } from '../primitives'

function metricCells(run: Run, metricKey?: string) {
  const entries = metricEntries(run)
  if (entries.length === 0) {
    return run.status === 'running' || run.status === 'queued' ? (
      <span className="run-metric__k">· · ·</span>
    ) : (
      <span className="run-metric__k">—</span>
    )
  }
  const ordered = metricKey
    ? [...entries].sort((a, b) => (a.key === metricKey ? -1 : b.key === metricKey ? 1 : 0))
    : entries
  return (
    <span className="run-metrics">
      {ordered.slice(0, 3).map((m) => (
        <span key={m.key}>
          <span className="run-metric__k">{metricLabel(m.key)} </span>
          {formatMetricValue(m.value)}
        </span>
      ))}
    </span>
  )
}

export function RunTable({
  runs = [],
  hypotheses = [],
  critiques = [],
  metricKey,
  loading = false,
}: {
  runs?: Run[]
  hypotheses?: Hypothesis[]
  critiques?: Critique[]
  metricKey?: string
  loading?: boolean
}) {
  const familyOf = (hypId: string) => hypotheses.find((h) => h.id === hypId)?.model_family

  const body = () => {
    if (loading) return <SkeletonRows rows={5} />
    if (runs.length === 0) return <EmptyState label="No runs queued" />

    return (
      <table className="runtable">
        <thead>
          <tr>
            <th>Status</th>
            <th>Run</th>
            <th>Model</th>
            <th>Metrics</th>
            <th>Seed</th>
            <th>Tags</th>
            <th>Critiques</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const meta = runStatusMeta(run.status)
            const linked = critiquesForRun(critiques, run.id)
            const flagged = linked.some((c) => c.kind === 'leakage' || c.kind === 'test_set_tuning')
            return (
              <tr key={run.id} className={`runrow ${meta.className} ${flagged ? 'is-flagged' : ''}`}>
                <td>
                  <span className={`led ${meta.className}`}>
                    <span className="led__dot" aria-hidden="true">
                      {meta.glyph}
                    </span>
                    {meta.label}
                  </span>
                </td>
                <td className="run-id" title={run.rationale ?? run.id}>
                  {shortId(run.id, 7)}
                </td>
                <td className="run-model">{familyOf(run.hypothesis_id) ?? '—'}</td>
                <td>{metricCells(run, metricKey)}</td>
                <td className="tnum">{run.seed ?? '—'}</td>
                <td>
                  {(run.tags ?? []).slice(0, 3).map((t) => (
                    <span className="tag-chip" key={t}>
                      {t}
                    </span>
                  ))}
                </td>
                <td>
                  <span className="crit-dots">
                    {linked.map((c) => (
                      <span
                        key={c.id}
                        className="crit-dot"
                        style={{ background: CRITIQUE_COLOR[c.kind] }}
                        title={`${CRITIQUE_LABEL[c.kind]}: ${c.finding}`}
                        role="img"
                        aria-label={`${CRITIQUE_LABEL[c.kind]} critique: ${c.finding}`}
                      />
                    ))}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )
  }

  return (
    <Panel
      num="05"
      title="RUN TABLE"
      areaClass="area-runs"
      acquiring={loading}
      crosshair
      meta={runs.length > 0 ? `${runs.length} runs` : undefined}
    >
      {body()}
    </Panel>
  )
}
