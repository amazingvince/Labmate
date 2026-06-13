/** §01 BRIEF + RUBRIC — objective, metric + rationale, budget, derived guardrails,
 *  and a definition-of-done checklist (authoritative grade if present, else a
 *  live readiness readout derived from the ledger). */
import type { GradeResult, Report, Study, StudyDetail } from '../../api/types'
import {
  deriveGuardrails,
  guardrailLabel,
  methodologicalFlag,
} from '../../lib/derive'
import { EmptyState, Panel, SkeletonRows } from '../primitives'

type Check = { id: string; label: string; pass: boolean; keystone?: boolean }

function readiness(detail: StudyDetail, banned: Set<string>, report?: Report): Check[] {
  const runs = detail.runs ?? []
  const critiques = detail.critiques ?? []
  const decisions = detail.decisions ?? []
  const artifacts = detail.artifacts ?? []
  const baseline = runs.some(
    (r) => (r.tags ?? []).some((t) => /baseline/i.test(t)) || /baseline/i.test(r.hypothesis_id),
  )
  return [
    { id: 'contract', label: 'Data contract written', pass: Boolean(detail.dataset_version) },
    { id: 'baseline', label: 'Baseline model ran', pass: baseline },
    { id: 'five', label: '≥ 5 experiments ran', pass: runs.length >= 5 },
    {
      id: 'leakage',
      label: 'Leakage review',
      pass: critiques.some((c) => c.kind === 'leakage') || banned.size > 0,
    },
    {
      id: 'best',
      label: 'Best vs baseline',
      pass: decisions.some((d) => d.action === 'promote') || Boolean(report?.compares_best_to_baseline),
    },
    {
      id: 'report',
      label: 'Report / model card',
      pass: artifacts.some((a) => a.kind === 'report') || Boolean(report),
    },
    { id: 'feedback', label: 'Human feedback recorded', pass: (detail.feedback ?? []).length > 0 },
    { id: 'caught_an_issue', label: 'Caught an issue', pass: Boolean(methodologicalFlag(detail)), keystone: true },
  ]
}

function ReadinessRow({ check }: { check: Check }) {
  const cls = check.pass ? 'check--pass' : 'check--pending'
  return (
    <div className={`check ${cls} ${check.keystone ? 'check--keystone' : ''}`}>
      <span className="check__glyph" aria-hidden="true">
        {check.pass ? '●' : '○'}
      </span>
      <span>{check.label}</span>
      {!check.pass && <span className="check__opt">awaiting</span>}
    </div>
  )
}

function GradeRow({
  check,
}: {
  check: GradeResult['checks'][number]
}) {
  const keystone = check.id === 'caught_an_issue'
  const cls = check.passed ? 'check--pass' : check.required ? 'check--fail' : 'check--pending'
  const glyph = check.passed ? '●' : check.required ? '✕' : '○'
  return (
    <div className={`check ${cls} ${keystone ? 'check--keystone' : ''}`} title={check.detail ?? ''}>
      <span className="check__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{check.id.replace(/_/g, ' ')}</span>
      <span className="check__opt">{check.required ? 'required' : 'optional'}</span>
    </div>
  )
}

export function BriefPane({
  study,
  detail,
  banned,
  report,
  grade,
  loading = false,
}: {
  study?: Study
  detail?: StudyDetail
  banned: Set<string>
  report?: Report
  grade?: GradeResult
  loading?: boolean
}) {
  const body = () => {
    if (loading) return <SkeletonRows rows={6} />
    if (!study || !detail) return <EmptyState label="No study loaded" />

    const guards = deriveGuardrails(detail)
    const checks = readiness(detail, banned, report)

    return (
      <>
        <p className="brief__objective">{study.brief}</p>

        <div className="kv">
          <span className="kv__k">Target</span>
          <span className="kv__v">{study.target}</span>
          <span className="kv__k">Task</span>
          <span className="kv__v">{study.task_type ?? '—'}</span>
          <span className="kv__k">Metric</span>
          <span className="kv__v">{study.metric}</span>
          {study.metric_rationale && (
            <>
              <span className="kv__k">Why</span>
              <span className="kv__v kv__v--prose">{study.metric_rationale}</span>
            </>
          )}
          <span className="kv__k">Max trials</span>
          <span className="kv__v">{study.budget?.max_trials ?? '—'}</span>
          <span className="kv__k">Budget</span>
          <span className="kv__v">{study.budget?.budget_seconds ?? '—'}s</span>
          <span className="kv__k">Status</span>
          <span className="kv__v">
            <span
              className={`chip ${
                study.status === 'done'
                  ? 'chip--green'
                  : study.status === 'stopped'
                    ? 'chip--danger'
                    : 'chip--cyan'
              }`}
            >
              {study.status}
            </span>
          </span>
        </div>

        <div className="subhead">Guardrails</div>
        <div className="chip-row">
          {guards.primaryMetric && (
            <span className="chip chip--cyan">primary · {guards.primaryMetric}</span>
          )}
          {guards.guardrails.map((g) => (
            <span className="chip chip--amber" key={g}>
              {guardrailLabel(g)}
            </span>
          ))}
          {banned.size > 0 && <span className="chip chip--danger">{banned.size} banned cols</span>}
          {!guards.primaryMetric && guards.guardrails.length === 0 && banned.size === 0 && (
            <span className="parse-hint">none recorded yet — add via the feedback box</span>
          )}
        </div>

        <div className="subhead">{grade ? `Definition of done · ${grade.verdict}` : 'Readiness'}</div>
        <div className="checklist">
          {grade
            ? grade.checks.map((c) => <GradeRow check={c} key={c.id} />)
            : checks.map((c) => <ReadinessRow check={c} key={c.id} />)}
        </div>
      </>
    )
  }

  return (
    <Panel num="01" title="BRIEF + RUBRIC" areaClass="area-brief" acquiring={loading}>
      {body()}
    </Panel>
  )
}
