/**
 * The "start a study" mutation. Creates the study, then best-effort profiles the
 * dataset and proposes experiments so the new study opens with content rather than
 * empty panes, then navigates to it. Additive — leaves the read/poll hooks alone.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, HttpError } from './client'
import type { Constraints, CreateStudyRequest } from './types'
import { useToast } from '../components/Toast'
import { navigate } from '../lib/router'

export type TaskType = 'binary_classification' | 'regression'

/** Flat form state for the New Study view. */
export type CreateStudyInput = {
  brief: string
  dataset_id: string
  target: string
  metric: string
  task_type: TaskType
  metric_rationale: string
  primary_metric: string
  guardrail: string
  banned_columns: string
  max_trials: number
  budget_seconds: number
}

export const BLANK_INPUT: CreateStudyInput = {
  brief: '',
  dataset_id: '',
  target: '',
  metric: '',
  task_type: 'binary_classification',
  metric_rationale: '',
  primary_metric: '',
  guardrail: '',
  banned_columns: '',
  max_trials: 20,
  budget_seconds: 600,
}

/** The bundled golden-path dataset, mirrored from the OpenAPI example. */
export const DEMO_PRESET: CreateStudyInput = {
  brief:
    'Predict which support tickets will breach SLA. Optimize recall at an acceptable false-positive cost. Do not use fields created after ticket close.',
  dataset_id: 'sla_tickets',
  target: 'breached_sla',
  metric: 'recall_at_fpr',
  task_type: 'binary_classification',
  metric_rationale: 'Missed breaches are costlier than false alarms up to 20% FPR.',
  primary_metric: 'recall',
  guardrail: 'false_positive_rate <= 0.20',
  banned_columns: 'resolved_at, time_to_resolution, closed_status, agent_notes_final',
  max_trials: 20,
  budget_seconds: 600,
}

export function isComplete(input: CreateStudyInput): boolean {
  return Boolean(
    input.brief.trim() && input.dataset_id.trim() && input.target.trim() && input.metric.trim(),
  )
}

function buildRequest(input: CreateStudyInput): CreateStudyRequest {
  const guardrails = input.guardrail.trim() ? [{ expr: input.guardrail.trim() }] : []
  const banned = input.banned_columns
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const hasConstraints =
    Boolean(input.primary_metric.trim()) || guardrails.length > 0 || banned.length > 0
  const constraints: Constraints | undefined = hasConstraints
    ? {
        ...(input.primary_metric.trim() ? { primary_metric: input.primary_metric.trim() } : {}),
        ...(guardrails.length ? { guardrails } : {}),
        ...(banned.length ? { banned_columns: banned } : {}),
        require_interpretability: false,
      }
    : undefined

  return {
    brief: input.brief.trim(),
    dataset_id: input.dataset_id.trim(),
    target: input.target.trim(),
    metric: input.metric.trim(),
    task_type: input.task_type,
    rubric: 'docs/rubric.json',
    ...(input.metric_rationale.trim() ? { metric_rationale: input.metric_rationale.trim() } : {}),
    ...(constraints ? { constraints } : {}),
    budget: { max_trials: input.max_trials, budget_seconds: input.budget_seconds },
  }
}

function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 0) return 'Signal lost — API unreachable'
    if (err.status === 401) return 'Unauthorized — set VITE_API_TOKEN to create studies'
    return err.detail ? `${err.message}: ${err.detail}` : err.message
  }
  return err instanceof Error ? err.message : 'Unknown error'
}

export function useCreateStudy() {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: async (input: CreateStudyInput) => {
      const { id } = await api.createStudy(buildRequest(input))
      // Best-effort: don't fail the whole creation if profiling/proposing hiccups.
      await api.profileDataset(id).catch(() => undefined)
      await api.proposeExperiments(id, 6).catch(() => undefined)
      return id
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['studies'] })
      toast.push('ok', 'Study created — profiled and proposed experiments')
      navigate({ name: 'study', id, tab: 'overview' })
    },
    onError: (err) => toast.push('err', describeError(err)),
  })
}
