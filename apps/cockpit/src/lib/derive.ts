/**
 * Pure helpers that turn the raw ledger (StudyDetail) into the things the panes
 * render: metric formatting, guardrail derivation, run/critique linking, the
 * merged ledger feed, and a best-effort NL→constraint parse for the feedback box.
 *
 * NOTE: every entity carries a `created_at` (date-time) — the ledger is ordered
 * by that real clock when present, falling back to array sequence only when a
 * timestamp is missing.
 */
import type {
  Constraints,
  Critique,
  CritiqueKind,
  Decision,
  Feedback,
  Report,
  Run,
  RunStatus,
  Study,
  StudyDetail,
} from '../api/types'

/** Entities that may carry an ISO `created_at`. */
type Timestamped = { created_at?: string }

/** Epoch millis for a `created_at`, or NaN when absent/unparseable. */
function createdAtMs(x: Timestamped): number {
  if (!x.created_at) return Number.NaN
  const t = Date.parse(x.created_at)
  return Number.isNaN(t) ? Number.NaN : t
}

/**
 * Stable chronological sort by `created_at`. Items with a timestamp come first
 * in clock order; items missing one keep their original array order (appended
 * after the timestamped block). Never mutates the input.
 */
export function byCreatedAt<T extends Timestamped>(items: readonly T[]): T[] {
  return items
    .map((data, i) => ({ data, i, t: createdAtMs(data) }))
    .sort((a, b) => {
      const aHas = !Number.isNaN(a.t)
      const bHas = !Number.isNaN(b.t)
      if (aHas && bHas) return a.t - b.t || a.i - b.i
      if (aHas) return -1
      if (bHas) return 1
      return a.i - b.i
    })
    .map((x) => x.data)
}

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

/** "Latest" = the run with the newest `created_at`; falls back to array order
 *  (last element) when timestamps are missing. */
export function latestRun(runs: Run[]): Run | undefined {
  if (runs.length === 0) return undefined
  const ordered = byCreatedAt(runs)
  return ordered[ordered.length - 1]
}

/**
 * Critiques are surfaced at STUDY scope, not per-run. The backend never sets
 * `Critique.target_run_id`, so a run-level filter on it always returns [] — that
 * false linking is dropped. Callers that want the study's flagged critiques
 * (leakage / test-set tuning) use `flaggedCritiques` instead.
 */
export function flaggedCritiques(critiques: Critique[]): Critique[] {
  return critiques.filter((c) => c.kind === 'leakage' || c.kind === 'test_set_tuning')
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

function constraintsOf(detail: StudyDetail): Constraints | undefined {
  return detail.study?.constraints
}

/**
 * Guardrails + primary metric. PRIMARY source is `study.constraints` (the human
 * checkpoint persists `primary_metric` + `guardrails[].expr` there). We then
 * union any additional signals parsed from natural-language feedback notes, so a
 * mid-study steer that adds a guardrail still shows up. (Fixes the old
 * "None recorded yet" — guardrails ARE on Study, via `constraints`.)
 */
export function deriveGuardrails(detail: StudyDetail): DerivedGuardrails {
  const guardrails = new Set<string>()
  let primaryMetric: string | undefined

  const constraints = constraintsOf(detail)
  if (constraints) {
    if (typeof constraints.primary_metric === 'string') primaryMetric = constraints.primary_metric
    for (const g of constraints.guardrails ?? []) {
      if (typeof g.expr === 'string' && g.expr.trim()) guardrails.add(g.expr.trim())
    }
  }

  for (const fb of detail.feedback ?? []) {
    const parsed = fb.parsed_constraints as Record<string, unknown> | undefined
    if (!parsed) continue
    // Feedback only overrides the headline metric if constraints didn't set one.
    if (!primaryMetric && typeof parsed.primary_metric === 'string') {
      primaryMetric = parsed.primary_metric
    }
    const g = parsed.guardrail ?? parsed.guardrails
    if (typeof g === 'string') guardrails.add(g)
    else if (Array.isArray(g)) g.forEach((x) => typeof x === 'string' && guardrails.add(x))
  }

  return { primaryMetric, guardrails: [...guardrails] }
}

/** Pull a numeric FPR bound out of a guardrail expr like "false_positive_rate <= 0.20". */
export function guardrailFprBound(exprs: string[]): number | undefined {
  for (const e of exprs) {
    const m = e.match(/false[_ ]?positive[_ ]?rate\s*<?=\s*(0?\.\d+|\d+(?:\.\d+)?)/i)
    if (m) {
      const v = Number(m[1])
      if (Number.isFinite(v)) return v
    }
  }
  return undefined
}

/** The FPR a run actually tuned/evaluated at, if it reports one (`target_fpr`). */
export function runTargetFpr(run: Run | undefined): number | undefined {
  const v = run?.metrics?.target_fpr
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// ---------------------------------------------------------------------------
// Leaderboard derivations — baseline, best, deltas, guardrail, applied feedback.
// All pure + null-guarded so the table can render against partial live data.
// ---------------------------------------------------------------------------

/** A finite numeric metric off a run, or undefined. */
function metricNumber(run: Run | undefined, key: string): number | undefined {
  const v = run?.metrics?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** True when a run carries a dummy-baseline marker in its artifacts (the runner
 *  stamps `artifacts.dummy` — a boolean flag on the shim, an object of baseline
 *  metrics on the script path). Either truthy form counts. */
function carriesDummyArtifact(run: Run): boolean {
  const d = (run.artifacts as Record<string, unknown> | undefined)?.dummy
  return Boolean(d)
}

/**
 * The baseline run for a study: prefer one tagged `baseline`, else the one that
 * carries a `dummy` artifact, else the chronologically-first run. The baseline is
 * what every other run's primary metric is compared against.
 */
export function baselineRun(runs: Run[]): Run | undefined {
  if (runs.length === 0) return undefined
  const tagged = runs.find((r) => (r.tags ?? []).includes('baseline'))
  if (tagged) return tagged
  const dummy = runs.find(carriesDummyArtifact)
  if (dummy) return dummy
  return byCreatedAt(runs)[0]
}

/** A promoted run id from the decision log (the latest `promote` wins). */
function promotedRunId(decisions: Decision[] | undefined): string | undefined {
  let id: string | undefined
  for (const d of byCreatedAt(decisions ?? [])) {
    if (d.action === 'promote' && d.promoted_run_id) id = d.promoted_run_id
  }
  return id
}

/**
 * The "best" run to star in the leaderboard. Resolution order:
 *   1. `report.best_run_id` (the report's recorded winner), if it exists in `runs`
 *   2. a promoted run from the decision log, if present
 *   3. the non-baseline run with the max primary-metric value
 * Returns undefined only when there are no eligible runs.
 */
export function bestRun(
  runs: Run[],
  primaryKey: string | undefined,
  report?: Report,
  decisions?: Decision[],
): Run | undefined {
  if (runs.length === 0) return undefined
  const byId = (id?: string) => (id ? runs.find((r) => r.id === id) : undefined)

  const reported = byId(report?.best_run_id)
  if (reported) return reported
  const promoted = byId(promotedRunId(decisions))
  if (promoted) return promoted

  const base = baselineRun(runs)
  const candidates = runs.filter(
    (r) => r.id !== base?.id && r.status === 'completed' && metricNumber(r, primaryKey ?? '') != null,
  )
  const pool = candidates.length ? candidates : runs.filter((r) => r.status === 'completed')
  if (pool.length === 0) return undefined
  // Max the primary metric. For error metrics (rmse/mae/brier/log_loss) lower is
  // better, so flip the comparison.
  const lowerIsBetter = isLowerBetter(primaryKey)
  return pool.reduce((best, r) => {
    const rv = metricNumber(r, primaryKey ?? '')
    const bv = metricNumber(best, primaryKey ?? '')
    if (rv == null) return best
    if (bv == null) return r
    return lowerIsBetter ? (rv < bv ? r : best) : rv > bv ? r : best
  })
}

const LOWER_IS_BETTER = new Set(['rmse', 'mae', 'brier', 'log_loss', 'false_positive_rate', 'fpr'])

/** Whether a metric is an error/loss where smaller is better. */
export function isLowerBetter(key: string | undefined): boolean {
  return key ? LOWER_IS_BETTER.has(key) : false
}

export type MetricDelta = { abs: number; pp: number; better: boolean }

/**
 * The delta of `run`'s metric vs the `baseline`'s, for `key`. `abs` is the raw
 * difference; `pp` is the same expressed in percentage points (×100) for rates.
 * `better` accounts for lower-is-better metrics. Returns undefined when either
 * side is missing the metric (never invents a comparison).
 */
export function metricDelta(
  run: Run | undefined,
  baseline: Run | undefined,
  key: string | undefined,
): MetricDelta | undefined {
  if (!key) return undefined
  const rv = metricNumber(run, key)
  const bv = metricNumber(baseline, key)
  if (rv == null || bv == null) return undefined
  const abs = rv - bv
  const better = isLowerBetter(key) ? abs < 0 : abs > 0
  return { abs, pp: abs * 100, better }
}

export type GuardrailStatus = {
  /** true = satisfied, false = violated, undefined = not evaluable. */
  satisfied: boolean | undefined
  /** The run's actual false-positive rate, if reported. */
  actualFpr: number | undefined
  /** The study's FPR bound (ceiling), if one is in force. */
  bound: number | undefined
}

/**
 * Whether a run honors the study's FPR guardrail. Sources, in order:
 *   1. an explicit `run.metrics.fpr_guardrail_satisfied` (1/0) if the runner
 *      flattened it into metrics — rare, since the worker keeps `metrics`
 *      numbers-only and the flag lives at result top-level
 *   2. otherwise compare the run's `false_positive_rate` against the bound parsed
 *      from `study.constraints.guardrails[].expr`
 * Returns satisfied=undefined when neither the bound nor the FPR is known.
 */
export function guardrailStatus(run: Run, study: Study | undefined): GuardrailStatus {
  const exprs = (study?.constraints?.guardrails ?? [])
    .map((g) => g.expr)
    .filter((e): e is string => typeof e === 'string')
  const bound = guardrailFprBound(exprs)
  const actualFpr = metricNumber(run, 'false_positive_rate')

  const flag = run.metrics?.fpr_guardrail_satisfied
  if (typeof flag === 'number') {
    return { satisfied: flag === 1, actualFpr, bound }
  }
  if (bound != null && actualFpr != null) {
    return { satisfied: actualFpr <= bound + 1e-9, actualFpr, bound }
  }
  return { satisfied: undefined, actualFpr, bound }
}

/** The Feedback entry whose parsed constraint shaped this run, if any. */
export function appliedFeedback(run: Run, feedback: Feedback[] | undefined): Feedback | undefined {
  if (!run.applied_feedback_id) return undefined
  return (feedback ?? []).find((f) => f.id === run.applied_feedback_id)
}

/**
 * Banned columns. PRIMARY source is `study.constraints.banned_columns` (the
 * authoritative ban list from the contract / human checkpoint). We then union
 * dataset leakage candidates and any explicit `ban_feature` feedback so a
 * mid-study ban shows up before the contract is re-persisted.
 */
export function deriveBannedColumns(detail: StudyDetail): Set<string> {
  const banned = new Set<string>()
  for (const name of constraintsOf(detail)?.banned_columns ?? []) {
    if (name) banned.add(name)
  }
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
  | { kind: 'feedback'; id: string; data: Feedback; created_at?: string }
  | { kind: 'run'; id: string; data: Run; created_at?: string }
  | { kind: 'critique'; id: string; data: Critique; created_at?: string }
  | { kind: 'decision'; id: string; data: Decision; created_at?: string }

/**
 * The merged ledger feed, ordered by real `created_at` across all event types.
 * Each entry carries the source timestamp so the timeline can sort one unified
 * stream (a critique that lands between two runs shows between them). Entries
 * without a timestamp keep their relative array order at the end.
 */
export function buildLedger(detail: StudyDetail): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  ;(detail.feedback ?? []).forEach((data, i) =>
    entries.push({ kind: 'feedback', id: data.id ?? `fb-${i}`, data, created_at: data.created_at }),
  )
  ;(detail.runs ?? []).forEach((data) =>
    entries.push({ kind: 'run', id: data.id, data, created_at: data.created_at }),
  )
  ;(detail.critiques ?? []).forEach((data) =>
    entries.push({ kind: 'critique', id: data.id, data, created_at: data.created_at }),
  )
  ;(detail.decisions ?? []).forEach((data) =>
    entries.push({ kind: 'decision', id: data.id, data, created_at: data.created_at }),
  )
  return byCreatedAt(entries)
}

export function shortId(id: string | undefined, len = 6): string {
  if (!id) return '—'
  return id.length > len ? `…${id.slice(-len)}` : id
}

/**
 * The metric key used to pick a run's headline number from `run.metrics`. The
 * study's recorded `metric` (e.g. "recall_at_fpr") is the key the runner writes,
 * so it stays primary here; `constraints.primary_metric` (e.g. "recall") is the
 * human-facing NAME shown in the header (see `headlineMetric`).
 */
export function primaryMetricKey(study: Study): string | undefined {
  return study.metric || study.constraints?.primary_metric || undefined
}

/**
 * The headline metric for the study header. `name` is what the human asked for
 * (`constraints.primary_metric`, e.g. "recall"); `metric` is what the runner
 * optimizes/records (`study.metric`, e.g. "recall_at_fpr"). When they differ we
 * surface both so the 0.10-vs-0.20 / recall-vs-recall@fpr gap isn't hidden.
 */
export function headlineMetric(study: Study): { name?: string; metric?: string; differ: boolean } {
  const name = study.constraints?.primary_metric || undefined
  const metric = study.metric || undefined
  return { name, metric, differ: Boolean(name && metric && name !== metric) }
}
