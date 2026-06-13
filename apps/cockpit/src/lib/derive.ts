/**
 * Pure helpers that turn the raw ledger (StudyDetail) into the things the panes
 * render: metric formatting, guardrail derivation, run/critique linking, the
 * merged ledger feed, and a best-effort NL→constraint parse for the feedback box.
 *
 * NOTE: the API carries no timestamps, so the ledger is ordered by event type
 * then array sequence (feedback → runs → critiques → decisions), not by clock.
 */
import type {
  Critique,
  CritiqueKind,
  Decision,
  Feedback,
  Run,
  RunStatus,
  Study,
  StudyDetail,
} from '../api/types'

export const METRIC_LABELS: Record<string, string> = {
  recall: 'Recall',
  recall_at_fpr: 'Recall@FPR',
  precision: 'Precision',
  false_positive_rate: 'FPR',
  fpr: 'FPR',
  pr_auc: 'PR-AUC',
  roc_auc: 'ROC-AUC',
  auc: 'AUC',
  accuracy: 'Accuracy',
  f1: 'F1',
  rmse: 'RMSE',
  mae: 'MAE',
  r2: 'R²',
  brier: 'Brier',
  log_loss: 'LogLoss',
}

export function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? key.replace(/_/g, ' ')
}

/** Stable, tabular-friendly metric formatting. Rates → 3dp, larger values → fewer. */
export function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  const abs = Math.abs(value)
  if (abs < 1) return value.toFixed(3)
  if (abs < 100) return value.toFixed(2)
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

export type NamedMetric = { key: string; value: number }

/** The primary metric for a run: the study's metric if present, else the first. */
export function pickPrimaryMetric(run: Run, metricKey?: string): NamedMetric | undefined {
  const metrics = run.metrics
  if (!metrics) return undefined
  if (metricKey && metricKey in metrics) return { key: metricKey, value: metrics[metricKey] }
  const entries = Object.entries(metrics)
  return entries.length ? { key: entries[0][0], value: entries[0][1] } : undefined
}

export function metricEntries(run: Run): NamedMetric[] {
  return Object.entries(run.metrics ?? {}).map(([key, value]) => ({ key, value }))
}

export function runsForHypothesis(runs: Run[], hypothesisId: string): Run[] {
  return runs.filter((r) => r.hypothesis_id === hypothesisId)
}

/** No timestamps in the API — "latest" is the last run in array order. */
export function latestRun(runs: Run[]): Run | undefined {
  return runs.length ? runs[runs.length - 1] : undefined
}

export function critiquesForRun(critiques: Critique[], runId: string | undefined): Critique[] {
  if (!runId) return []
  return critiques.filter((c) => c.target_run_id === runId)
}

export function decisionsForRun(decisions: Decision[], runId: string | undefined): Decision[] {
  if (!runId) return []
  return decisions.filter((d) => d.promoted_run_id === runId || d.rejected_run_id === runId)
}

export function isActiveStatus(status: RunStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** The planted-issue detector: an unresolved leakage / test-set-tuning critique. */
export function methodologicalFlag(detail: StudyDetail): Critique | undefined {
  return (detail.critiques ?? []).find(
    (c) => c.kind === 'leakage' || c.kind === 'test_set_tuning',
  )
}

export const CRITIQUE_COLOR: Record<CritiqueKind, string> = {
  leakage: 'var(--crit-leakage)',
  test_set_tuning: 'var(--crit-testtuning)',
  metric: 'var(--crit-metric)',
  calibration: 'var(--crit-calibration)',
  robustness: 'var(--crit-robustness)',
}

export const CRITIQUE_LABEL: Record<CritiqueKind, string> = {
  leakage: 'LEAKAGE',
  test_set_tuning: 'TEST-SET TUNING',
  metric: 'METRIC',
  calibration: 'CALIBRATION',
  robustness: 'ROBUSTNESS',
}

export type RunStatusMeta = { glyph: string; label: string; cssVar: string; className: string }

export function runStatusMeta(status: RunStatus): RunStatusMeta {
  switch (status) {
    case 'running':
      return { glyph: '◉', label: 'RUNNING', cssVar: 'var(--st-running)', className: 'is-running' }
    case 'completed':
      return { glyph: '●', label: 'COMPLETED', cssVar: 'var(--st-completed)', className: 'is-completed' }
    case 'failed':
      return { glyph: '✕', label: 'FAILED', cssVar: 'var(--st-failed)', className: 'is-failed' }
    case 'queued':
      return { glyph: '◌', label: 'QUEUED', cssVar: 'var(--st-queued)', className: 'is-queued' }
    default:
      // Spec-unknown status from a misbehaving backend — show it honestly.
      return { glyph: '?', label: 'UNKNOWN', cssVar: 'var(--text-muted)', className: 'is-queued' }
  }
}

export type DerivedGuardrails = { primaryMetric?: string; guardrails: string[] }

/** Guardrails aren't on Study; derive them from parsed feedback constraints. */
export function deriveGuardrails(detail: StudyDetail): DerivedGuardrails {
  const guardrails = new Set<string>()
  let primaryMetric: string | undefined
  for (const fb of detail.feedback ?? []) {
    const parsed = fb.parsed_constraints as Record<string, unknown> | undefined
    if (!parsed) continue
    if (typeof parsed.primary_metric === 'string') primaryMetric = parsed.primary_metric
    const g = parsed.guardrail ?? parsed.guardrails
    if (typeof g === 'string') guardrails.add(g)
    else if (Array.isArray(g)) g.forEach((x) => typeof x === 'string' && guardrails.add(x))
  }
  return { primaryMetric, guardrails: [...guardrails] }
}

/** Banned columns = flagged leakage candidates ∪ explicit ban_feature feedback. */
export function deriveBannedColumns(detail: StudyDetail): Set<string> {
  const banned = new Set<string>()
  for (const col of detail.dataset_version?.columns ?? []) {
    if (col.is_candidate_leakage) banned.add(col.name)
  }
  for (const fb of detail.feedback ?? []) {
    if (fb.type === 'ban_feature' && fb.target_id) banned.add(fb.target_id)
  }
  return banned
}

/**
 * Best-effort, clearly-labeled client preview of how a note parses into
 * constraints. The real backend does the authoritative parse; this just lets the
 * demo show the NL→constraint translation immediately, even against the mock.
 */
export function parseConstraints(text: string): Record<string, string> | undefined {
  const t = text.toLowerCase()
  const out: Record<string, string> = {}

  if (/recall\s+(matters|>|over|more|first|priorit)/.test(t)) out.primary_metric = 'recall'
  else if (/precision\s+(matters|>|over|more|first|priorit)/.test(t)) out.primary_metric = 'precision'
  else {
    const m = ['recall', 'precision', 'pr_auc', 'roc_auc', 'auc', 'f1', 'rmse', 'mae', 'accuracy'].find((k) =>
      t.includes(k),
    )
    if (m) out.primary_metric = m
  }

  const fprPct = t.match(/(false[ -]?positive(?:s| rate)?|fpr)[^0-9%]*(\d{1,3})\s*%/)
  const fprDec = t.match(/(false[ -]?positive(?:s| rate)?|fpr)[^0-9]*(0?\.\d+)/)
  if (fprPct) out.guardrail = `false_positive_rate <= ${Number(fprPct[2]) / 100}`
  else if (fprDec) out.guardrail = `false_positive_rate <= ${fprDec[2]}`

  return Object.keys(out).length ? out : undefined
}

export function guardrailLabel(expr: string): string {
  return expr
    .replace(/false_positive_rate/gi, 'FPR')
    .replace(/<=/g, '≤')
    .replace(/>=/g, '≥')
    .replace(/_/g, ' ')
    .trim()
}

export type LedgerEntry =
  | { kind: 'feedback'; id: string; data: Feedback }
  | { kind: 'run'; id: string; data: Run }
  | { kind: 'critique'; id: string; data: Critique }
  | { kind: 'decision'; id: string; data: Decision }

export function buildLedger(detail: StudyDetail): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  ;(detail.feedback ?? []).forEach((data, i) =>
    entries.push({ kind: 'feedback', id: data.id ?? `fb-${i}`, data }),
  )
  ;(detail.runs ?? []).forEach((data) => entries.push({ kind: 'run', id: data.id, data }))
  ;(detail.critiques ?? []).forEach((data) => entries.push({ kind: 'critique', id: data.id, data }))
  ;(detail.decisions ?? []).forEach((data) => entries.push({ kind: 'decision', id: data.id, data }))
  return entries
}

export function shortId(id: string | undefined, len = 6): string {
  if (!id) return '—'
  return id.length > len ? `…${id.slice(-len)}` : id
}

export function primaryMetricKey(study: Study): string | undefined {
  return study.metric || undefined
}
