/** §03 EXPERIMENT CARDS — one card per hypothesis with the latest run's metric,
 *  agent rationale, and the Approve / Deny / Rerun segmented control. */
import type { Critique, Hypothesis, Run } from '../../api/types'
import type { StudyActions } from '../../api/hooks'
import {
  CRITIQUE_LABEL,
  critiquesForRun,
  latestRun,
  metricLabel,
  pickPrimaryMetric,
  runsForHypothesis,
} from '../../lib/derive'
import { EmptyState, MetricReadout, Panel, SkeletonRows } from '../primitives'

function statusChip(status: Hypothesis['status']) {
  if (status === 'approved') return <span className="chip chip--cyan">approved</span>
  if (status === 'rejected') return <span className="chip chip--struck">rejected</span>
  return <span className="chip chip--amber">proposed</span>
}

function Card({
  hyp,
  runs,
  critiques,
  banned,
  rerunRequested,
  actions,
  metricKey,
}: {
  hyp: Hypothesis
  runs: Run[]
  critiques: Critique[]
  banned: Set<string>
  rerunRequested: boolean
  actions: StudyActions
  metricKey?: string
}) {
  const run = latestRun(runsForHypothesis(runs, hyp.id))
  const primary = run ? pickPrimaryMetric(run, metricKey) : undefined
  const linked = critiquesForRun(critiques, run?.id)
  const flag = linked.find((c) => c.kind === 'leakage' || c.kind === 'test_set_tuning')
  const running = run?.status === 'running'
  const status = hyp.status ?? 'proposed'

  const approvePending = actions.approve.isPending && actions.approve.variables?.id === hyp.id
  const denyPending = actions.deny.isPending && actions.deny.variables?.id === hyp.id
  const rerunPending = actions.rerun.isPending && actions.rerun.variables?.id === hyp.id

  return (
    <article
      className={`xcard ${status === 'approved' ? 'is-approved' : ''} ${
        status === 'rejected' ? 'is-rejected' : ''
      } ${flag ? 'is-flagged' : ''} ${running ? 'is-busy' : ''}`}
    >
      {flag && (
        <div className="xcard__flag">
          <span aria-hidden="true">⚠</span> {CRITIQUE_LABEL[flag.kind]} — {flag.finding}
        </div>
      )}

      <div className="xcard__top">
        <h3 className="xcard__statement">{hyp.statement}</h3>
        {statusChip(status)}
      </div>

      {hyp.rationale && <p className="xcard__rationale">{hyp.rationale}</p>}

      <div className="xcard__chips">
        {hyp.model_family && <span className="chip chip--cyan">{hyp.model_family}</span>}
        {(hyp.features ?? []).map((f) => (
          <span className={`chip ${banned.has(f) ? 'chip--struck' : 'chip--muted'}`} key={f}>
            {f}
          </span>
        ))}
      </div>

      {hyp.expected_outcome && <p className="xcard__expected">Expected: {hyp.expected_outcome}</p>}

      <div className="xcard__metricwrap">
        {run ? (
          <>
            <MetricReadout value={primary?.value} running={running} />
            <span className="metric-hero__label">
              {primary ? metricLabel(primary.key) : 'no metric'}
              {running && <span className="xcard__elapsed">◉ acquiring…</span>}
            </span>
          </>
        ) : (
          <span className="metric-hero__label">no run yet</span>
        )}
      </div>

      <div className="xcard__foot">
        <div className="segmented" role="group" aria-label="experiment actions">
          <button
            type="button"
            className={`seg ${status === 'approved' ? 'seg--on-approve' : ''}`}
            disabled={status !== 'proposed' || approvePending}
            onClick={() => actions.approve.mutate(hyp)}
          >
            {approvePending ? <span className="seg__spin">···</span> : 'Approve'}
          </button>
          <button
            type="button"
            className={`seg ${status === 'rejected' ? 'seg--on-deny' : ''}`}
            disabled={status !== 'proposed' || denyPending}
            onClick={() => actions.deny.mutate(hyp)}
          >
            {denyPending ? <span className="seg__spin">···</span> : 'Deny'}
          </button>
          <button
            type="button"
            className="seg"
            disabled={rerunPending}
            onClick={() => actions.rerun.mutate(hyp)}
          >
            {rerunPending ? <span className="seg__spin">···</span> : 'Rerun'}
          </button>
        </div>
        {rerunRequested && <span className="chip chip--cyan">rerun requested</span>}
      </div>
    </article>
  )
}

export function ExperimentCards({
  hypotheses = [],
  runs = [],
  critiques = [],
  banned,
  reruns,
  actions,
  metricKey,
  loading = false,
}: {
  hypotheses?: Hypothesis[]
  runs?: Run[]
  critiques?: Critique[]
  banned: Set<string>
  reruns: string[]
  actions: StudyActions
  metricKey?: string
  loading?: boolean
}) {
  const body = () => {
    if (loading) return <SkeletonRows rows={4} />
    if (hypotheses.length === 0) {
      return (
        <EmptyState label="No experiments proposed">
          <div className="ghost-card">[ + PROPOSE HYPOTHESIS ]</div>
        </EmptyState>
      )
    }
    return (
      <div className="cards">
        {hypotheses.map((hyp) => (
          <Card
            key={hyp.id}
            hyp={hyp}
            runs={runs}
            critiques={critiques}
            banned={banned}
            rerunRequested={reruns.includes(hyp.id)}
            actions={actions}
            metricKey={metricKey}
          />
        ))}
      </div>
    )
  }

  return (
    <Panel
      num="03"
      title="EXPERIMENT CARDS"
      areaClass="area-cards"
      acquiring={loading}
      meta={hypotheses.length > 0 ? `${hypotheses.length} hypotheses` : undefined}
    >
      {body()}
    </Panel>
  )
}
