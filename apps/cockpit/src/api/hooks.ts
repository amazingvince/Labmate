/**
 * TanStack Query hooks. Reads are cached + polled live while a run is active;
 * writes hit the real POST routes and push their optimistic delta into the
 * overlay (see state/overlay.tsx) plus a toast.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, HttpError } from './client'
import type { Hypothesis, Study, StudyDetail } from './types'
import { isActiveStatus, parseConstraints } from '../lib/derive'
import { hasApiToken } from './token'
import { localFeedback, useOverlay, type UndoContext } from '../state/overlay'
import { useToast } from '../components/Toast'

export const qk = {
  studies: (status?: string) => ['studies', status ?? 'all'] as const,
  study: (id: string) => ['study', id] as const,
  report: (id: string) => ['report', id] as const,
}

/** A run is live (queued/running) — drives the read poll + report refetch. */
export function hasActiveRun(detail: StudyDetail | undefined): boolean {
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
 *  when no report has been generated yet. While a run is active the report can
 *  appear/refresh out of band (the agent writes it), so poll lightly — reading
 *  the study cache to decide whether anything is in flight. */
export function useReport(id: string | undefined) {
  const qc = useQueryClient()
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
    refetchInterval: () => {
      const study = id ? qc.getQueryData<StudyDetail>(qk.study(id)) : undefined
      return hasActiveRun(study) ? 8000 : false
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
  // LockedError (and any other Error) — surface its message verbatim.
  return err instanceof Error ? err.message : 'Unknown error'
}

/**
 * Error surfaced before a write even leaves the browser: no operator token, so
 * the POST would 401. We short-circuit and never paint an optimistic delta.
 */
const NO_TOKEN_MSG = 'Locked — click Unlock and paste the internal token to enable writes'
class LockedError extends Error {
  constructor() {
    super(NO_TOKEN_MSG)
    this.name = 'LockedError'
  }
}

/** All write actions for one study, with optimistic overlay + rollback + toasts. */
export function useStudyActions(studyId: string, opts?: { budgetSeconds?: number }) {
  const qc = useQueryClient()
  const { dispatch } = useOverlay(studyId)
  const toast = useToast()
  const estimatedCost = opts?.budgetSeconds ?? 600

  const refresh = () => qc.invalidateQueries({ queryKey: qk.study(studyId) })

  /** Snapshot a hypothesis's current overlay/server status so a revert restores it. */
  const prevHypStatus = (hypId: string) => {
    const detail = qc.getQueryData<StudyDetail>(qk.study(studyId))
    return detail?.hypotheses?.find((h) => h.id === hypId)?.status
  }

  const approve = useMutation({
    mutationFn: async (hyp: Hypothesis) => {
      if (!hasApiToken()) throw new LockedError()
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
    // Gate the optimistic delta on having a token: don't flash "approved" for a
    // write that will 401. Return a typed undo context so onError can roll back.
    onMutate: (hyp): UndoContext | undefined => {
      if (!hasApiToken()) return undefined
      const fb = localFeedback({
        study_id: studyId,
        type: 'approval',
        scope: 'hypothesis',
        target_id: hyp.id,
        content: `Approved experiment: ${hyp.statement}`,
      })
      const prevStatus = prevHypStatus(hyp.id)
      dispatch({ t: 'hyp', studyId, hypId: hyp.id, status: 'approved', feedback: fb })
      return { kind: 'hyp', hypId: hyp.id, prevStatus, feedbackId: fb.id }
    },
    onSuccess: () => toast.push('ok', 'Approval recorded — experiment cleared to run'),
    onError: (err, _hyp, undo) => {
      if (undo) dispatch({ t: 'revert', studyId, undo })
      toast.push('err', describeError(err))
    },
  })

  const deny = useMutation({
    mutationFn: (hyp: Hypothesis) => {
      if (!hasApiToken()) throw new LockedError()
      return api.recordFeedback({
        study_id: studyId,
        type: 'note',
        scope: 'hypothesis',
        target_id: hyp.id,
        content: `Denied experiment: ${hyp.statement}`,
      })
    },
    onMutate: (hyp): UndoContext | undefined => {
      if (!hasApiToken()) return undefined
      const fb = localFeedback({
        study_id: studyId,
        type: 'note',
        scope: 'hypothesis',
        target_id: hyp.id,
        content: `Denied experiment: ${hyp.statement}`,
      })
      const prevStatus = prevHypStatus(hyp.id)
      dispatch({ t: 'hyp', studyId, hypId: hyp.id, status: 'rejected', feedback: fb })
      return { kind: 'hyp', hypId: hyp.id, prevStatus, feedbackId: fb.id }
    },
    onSuccess: () => toast.push('info', 'Experiment denied'),
    onError: (err, _hyp, undo) => {
      if (undo) dispatch({ t: 'revert', studyId, undo })
      toast.push('err', describeError(err))
    },
  })

  const rerun = useMutation({
    mutationFn: (hyp: Hypothesis) => {
      if (!hasApiToken()) throw new LockedError()
      return api.requestApproval({
        study_id: studyId,
        experiment_ids: [hyp.id],
        reason: `Rerun experiment: ${hyp.statement}`,
        estimated_cost_seconds: estimatedCost,
      })
    },
    onMutate: (hyp): UndoContext | undefined => {
      if (!hasApiToken()) return undefined
      const fb = localFeedback({
        study_id: studyId,
        type: 'note',
        scope: 'experiment',
        target_id: hyp.id,
        content: `Requested rerun: ${hyp.statement}`,
      })
      // Reruns live only in the overlay (never the server constraints), so a
      // revert always removes the optimistic flag we just added.
      dispatch({ t: 'rerun', studyId, hypId: hyp.id, feedback: fb })
      return { kind: 'rerun', hypId: hyp.id, added: true, feedbackId: fb.id }
    },
    onSuccess: () => toast.push('ok', 'Rerun requested — pending approval'),
    onError: (err, _hyp, undo) => {
      if (undo) dispatch({ t: 'revert', studyId, undo })
      toast.push('err', describeError(err))
    },
  })

  const banColumn = useMutation({
    mutationFn: (column: string) => {
      if (!hasApiToken()) throw new LockedError()
      return api.recordFeedback({
        study_id: studyId,
        type: 'ban_feature',
        scope: 'study',
        target_id: column,
        content: `Ban feature ${column} — unavailable at prediction time`,
      })
    },
    onMutate: (column): UndoContext | undefined => {
      if (!hasApiToken()) return undefined
      const detail = qc.getQueryData<StudyDetail>(qk.study(studyId))
      const already = (detail?.study?.constraints?.banned_columns ?? []).includes(column)
      const fb = localFeedback({
        study_id: studyId,
        type: 'ban_feature',
        scope: 'study',
        target_id: column,
        content: `Banned feature ${column} (post-outcome / leakage)`,
      })
      dispatch({ t: 'ban', studyId, column, feedback: fb })
      return { kind: 'ban', column, added: !already, feedbackId: fb.id }
    },
    onSuccess: (_d, column) => toast.push('ok', `Feature banned — ${column}`),
    onError: (err, _c, undo) => {
      if (undo) dispatch({ t: 'revert', studyId, undo })
      toast.push('err', describeError(err))
    },
  })

  const sendFeedback = useMutation({
    // Steering does two things: (1) record the note in the ledger with its parsed
    // constraints (the human's judgment, durable evidence), and (2) inject the same
    // text as a user.message into the live Managed Agents session so it steers the
    // agent's next step. A 503 (no runtime wired) is tolerated — the note still lands.
    mutationFn: async (text: string) => {
      if (!hasApiToken()) throw new LockedError()
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
        const res = await api.suggestChange(studyId, text)
        // Only claim "injected" when the runtime actually echoes an accepted
        // status — a 200 with no/declined status means the note landed but the
        // session didn't take it, so we must not overstate the effect.
        injected = res?.status === 'injected' || res?.status === 'accepted' || res?.status === 'ok'
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
    onMutate: (text): UndoContext | undefined => {
      if (!hasApiToken()) return undefined
      const parsed = parseConstraints(text)
      const fb = localFeedback({
        study_id: studyId,
        type: 'note',
        scope: 'study',
        content: text,
        ...(parsed ? { parsed_constraints: parsed } : {}),
      })
      dispatch({ t: 'feedback', studyId, feedback: fb })
      return { kind: 'feedback', feedbackId: fb.id }
    },
    onSuccess: (res) =>
      toast.push(
        'ok',
        res.injected ? 'Judgment recorded & injected into the session' : 'Judgment recorded',
      ),
    onError: (err, _text, undo) => {
      if (undo) dispatch({ t: 'revert', studyId, undo })
      toast.push('err', describeError(err))
    },
  })

  const generateReport = useMutation({
    mutationFn: () => {
      if (!hasApiToken()) throw new LockedError()
      return api.writeReport({ study_id: studyId, report_type: 'model_card' })
    },
    onSuccess: (report) => {
      dispatch({ t: 'report', studyId, report })
      // Seed + refetch the report query so the rendered card appears immediately
      // and survives reload (it reads the stored artifact, not just the overlay).
      qc.setQueryData(qk.report(studyId), report)
      qc.invalidateQueries({ queryKey: qk.report(studyId) })
      // A fresh report can flip the study's best/promoted reconciliation + status,
      // so refresh the study record too.
      qc.invalidateQueries({ queryKey: qk.study(studyId) })
      toast.push('ok', 'Model card generated')
    },
    onError: (err) => toast.push('err', describeError(err)),
  })

  const checkDone = useMutation({
    mutationFn: () => {
      if (!hasApiToken()) throw new LockedError()
      return api.gradeStudy({ study_id: studyId })
    },
    onSuccess: (grade) => {
      dispatch({ t: 'grade', studyId, grade })
      // Grading can move the study to done — refetch so the status badge + the
      // persisted grade verdict (not just the overlay copy) update everywhere.
      qc.invalidateQueries({ queryKey: qk.study(studyId) })
      qc.invalidateQueries({ queryKey: qk.report(studyId) })
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
