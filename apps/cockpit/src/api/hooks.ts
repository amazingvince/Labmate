/**
 * TanStack Query hooks. Reads are cached + polled live while a run is active;
 * writes hit the real POST routes and push their optimistic delta into the
 * overlay (see state/overlay.tsx) plus a toast.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, HttpError } from './client'
import type { Hypothesis, Study, StudyDetail } from './types'
import { isActiveStatus, parseConstraints } from '../lib/derive'
import { localFeedback, useOverlay } from '../state/overlay'
import { useToast } from '../components/Toast'

export const qk = {
  studies: (status?: string) => ['studies', status ?? 'all'] as const,
  study: (id: string) => ['study', id] as const,
  report: (id: string) => ['report', id] as const,
}

function hasActiveRun(detail: StudyDetail | undefined): boolean {
  return Boolean(detail?.runs?.some((r) => isActiveStatus(r.status)))
}

export function useStudies(status?: Study['status']) {
  return useQuery({
    queryKey: qk.studies(status),
    queryFn: () => api.listStudies(status ? { status } : undefined),
  })
}

export function useStudy(id: string | undefined) {
  return useQuery({
    queryKey: qk.study(id ?? ''),
    queryFn: () => api.getStudy(id as string),
    enabled: Boolean(id),
    // Live cockpit: poll only while the agent is actually computing.
    refetchInterval: (query) => (hasActiveRun(query.state.data) ? 4000 : false),
  })
}

/** The latest rendered model card for a study. Resolves to null (not an error)
 *  when no report has been generated yet. */
export function useReport(id: string | undefined) {
  return useQuery({
    queryKey: qk.report(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => {
      try {
        return await api.getReport(id as string)
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null
        throw err
      }
    },
  })
}

function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 0) return 'Signal lost — API unreachable'
    if (err.status === 402) return 'Compute blocked — approval or budget required'
    if (err.status === 422) return `Manifest rejected — ${err.message}`
    if (err.status === 401) return 'Unauthorized — click Unlock and paste the internal token'
    return err.detail ? `${err.message}: ${err.detail}` : err.message
  }
  return err instanceof Error ? err.message : 'Unknown error'
}

/** All write actions for one study, with optimistic overlay + toasts. */
export function useStudyActions(studyId: string, opts?: { budgetSeconds?: number }) {
  const qc = useQueryClient()
  const { dispatch } = useOverlay(studyId)
  const toast = useToast()
  const estimatedCost = opts?.budgetSeconds ?? 600

  const refresh = () => qc.invalidateQueries({ queryKey: qk.study(studyId) })

  const approve = useMutation({
    mutationFn: async (hyp: Hypothesis) => {
      const approval = await api.requestApproval({
        study_id: studyId,
        experiment_ids: [hyp.id],
        reason: `Approve & run experiment: ${hyp.statement}`,
        estimated_cost_seconds: estimatedCost,
      })
      await api.recordFeedback({
        study_id: studyId,
        type: 'approval',
        scope: 'hypothesis',
        target_id: hyp.id,
        content: `Approved experiment: ${hyp.statement}`,
      })
      return approval
    },
    onMutate: (hyp) => {
      dispatch({
        t: 'hyp',
        studyId,
        hypId: hyp.id,
        status: 'approved',
        feedback: localFeedback({
          study_id: studyId,
          type: 'approval',
          scope: 'hypothesis',
          target_id: hyp.id,
          content: `Approved experiment: ${hyp.statement}`,
        }),
      })
    },
    onSuccess: () => toast.push('ok', 'Approval recorded — experiment cleared to run'),
    onError: (err) => toast.push('err', describeError(err)),
  })

  const deny = useMutation({
    mutationFn: (hyp: Hypothesis) =>
      api.recordFeedback({
        study_id: studyId,
        type: 'note',
        scope: 'hypothesis',
        target_id: hyp.id,
        content: `Denied experiment: ${hyp.statement}`,
      }),
    onMutate: (hyp) => {
      dispatch({
        t: 'hyp',
        studyId,
        hypId: hyp.id,
        status: 'rejected',
        feedback: localFeedback({
          study_id: studyId,
          type: 'note',
          scope: 'hypothesis',
          target_id: hyp.id,
          content: `Denied experiment: ${hyp.statement}`,
        }),
      })
    },
    onSuccess: () => toast.push('info', 'Experiment denied'),
    onError: (err) => toast.push('err', describeError(err)),
  })

  const rerun = useMutation({
    mutationFn: (hyp: Hypothesis) =>
      api.requestApproval({
        study_id: studyId,
        experiment_ids: [hyp.id],
        reason: `Rerun experiment: ${hyp.statement}`,
        estimated_cost_seconds: estimatedCost,
      }),
    onMutate: (hyp) => {
      dispatch({
        t: 'rerun',
        studyId,
        hypId: hyp.id,
        feedback: localFeedback({
          study_id: studyId,
          type: 'note',
          scope: 'experiment',
          target_id: hyp.id,
          content: `Requested rerun: ${hyp.statement}`,
        }),
      })
    },
    onSuccess: () => toast.push('ok', 'Rerun requested — pending approval'),
    onError: (err) => toast.push('err', describeError(err)),
  })

  const banColumn = useMutation({
    mutationFn: (column: string) =>
      api.recordFeedback({
        study_id: studyId,
        type: 'ban_feature',
        scope: 'study',
        target_id: column,
        content: `Ban feature ${column} — unavailable at prediction time`,
      }),
    onMutate: (column) => {
      dispatch({
        t: 'ban',
        studyId,
        column,
        feedback: localFeedback({
          study_id: studyId,
          type: 'ban_feature',
          scope: 'study',
          target_id: column,
          content: `Banned feature ${column} (post-outcome / leakage)`,
        }),
      })
    },
    onSuccess: (_d, column) => toast.push('ok', `Feature banned — ${column}`),
    onError: (err) => toast.push('err', describeError(err)),
  })

  const sendFeedback = useMutation({
    // Steering does two things: (1) record the note in the ledger with its parsed
    // constraints (the human's judgment, durable evidence), and (2) inject the same
    // text as a user.message into the live Managed Agents session so it steers the
    // agent's next step. A 503 (no runtime wired) is tolerated — the note still lands.
    mutationFn: async (text: string) => {
      const parsed = parseConstraints(text)
      const feedback = await api.recordFeedback({
        study_id: studyId,
        type: 'note',
        scope: 'study',
        content: text,
        ...(parsed ? { parsed_constraints: parsed } : {}),
      })
      let injected = false
      try {
        await api.suggestChange(studyId, text)
        injected = true
      } catch (err) {
        // Runtime not connected (503) / conflict (409) / unreachable (0) — keep the
        // recorded note; surface as info, not an error. Re-throw anything unexpected.
        if (err instanceof HttpError && (err.status === 503 || err.status === 409 || err.status === 0)) {
          injected = false
        } else {
          throw err
        }
      }
      return { feedback, injected }
    },
    onMutate: (text) => {
      const parsed = parseConstraints(text)
      dispatch({
        t: 'feedback',
        studyId,
        feedback: localFeedback({
          study_id: studyId,
          type: 'note',
          scope: 'study',
          content: text,
          ...(parsed ? { parsed_constraints: parsed } : {}),
        }),
      })
    },
    onSuccess: (res) =>
      toast.push(
        'ok',
        res.injected ? 'Judgment recorded & injected into the session' : 'Judgment recorded',
      ),
    onError: (err) => toast.push('err', describeError(err)),
  })

  const generateReport = useMutation({
    mutationFn: () => api.writeReport({ study_id: studyId, report_type: 'model_card' }),
    onSuccess: (report) => {
      dispatch({ t: 'report', studyId, report })
      // Seed + refetch the report query so the rendered card appears immediately
      // and survives reload (it reads the stored artifact, not just the overlay).
      qc.setQueryData(qk.report(studyId), report)
      qc.invalidateQueries({ queryKey: qk.report(studyId) })
      toast.push('ok', 'Model card generated')
    },
    onError: (err) => toast.push('err', describeError(err)),
  })

  const checkDone = useMutation({
    mutationFn: () => api.gradeStudy({ study_id: studyId }),
    onSuccess: (grade) => {
      dispatch({ t: 'grade', studyId, grade })
      toast.push(
        grade.verdict === 'done' ? 'ok' : 'info',
        grade.verdict === 'done' ? 'Study graded: DONE' : 'Study graded: not done yet',
      )
    },
    onError: (err) => toast.push('err', describeError(err)),
  })

  return { approve, deny, rerun, banColumn, sendFeedback, generateReport, checkDone, refresh }
}

export type StudyActions = ReturnType<typeof useStudyActions>
