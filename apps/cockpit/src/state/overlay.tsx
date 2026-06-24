/**
 * Optimistic overlay. Writes hit the real POST routes, but the *visible* delta
 * (a card flipping to approved, a column going banned, a feedback chip landing
 * in the ledger) is held here and merged on top of the server StudyDetail. That
 * makes optimistic UI stable even against a static mock that always returns the
 * same payload, and additive against a real Worker until the server catches up.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react'
import type { Feedback, GradeResult, HypothesisStatus, Report, StudyDetail } from '../api/types'

export type StudyOverlay = {
  hypStatus: Record<string, HypothesisStatus>
  banned: string[]
  reruns: string[]
  feedback: Feedback[]
  report?: Report
  grade?: GradeResult
}

const EMPTY: StudyOverlay = { hypStatus: {}, banned: [], reruns: [], feedback: [] }

type OverlayState = Record<string, StudyOverlay>

export type OverlayAction =
  | { t: 'hyp'; studyId: string; hypId: string; status: HypothesisStatus; feedback?: Feedback }
  | { t: 'ban'; studyId: string; column: string; feedback?: Feedback }
  | { t: 'rerun'; studyId: string; hypId: string; feedback?: Feedback }
  | { t: 'feedback'; studyId: string; feedback: Feedback }
  | { t: 'report'; studyId: string; report: Report }
  | { t: 'grade'; studyId: string; grade: GradeResult }
  | { t: 'revert'; studyId: string; undo: UndoContext }

/**
 * The minimal description of an optimistic mutation, returned by a mutation's
 * `onMutate` and dispatched back as `{ t: 'revert' }` from `onError` so a failed
 * write (e.g. a 401 when the operator hasn't unlocked) doesn't leave a fake
 * "approved" / "banned" delta on screen. Each kind names exactly what to undo;
 * any optimistic feedback chip is matched by its synthetic local id.
 */
export type UndoContext =
  | { kind: 'hyp'; hypId: string; prevStatus?: HypothesisStatus; feedbackId?: string }
  | { kind: 'ban'; column: string; added: boolean; feedbackId?: string }
  | { kind: 'rerun'; hypId: string; added: boolean; feedbackId?: string }
  | { kind: 'feedback'; feedbackId?: string }

function overlayFor(state: OverlayState, id: string): StudyOverlay {
  return state[id] ?? EMPTY
}

function dropFeedback(list: Feedback[], id: string | undefined): Feedback[] {
  return id ? list.filter((f) => f.id !== id) : list
}

function reducer(state: OverlayState, action: OverlayAction): OverlayState {
  const cur = overlayFor(state, action.studyId)
  const next: StudyOverlay = {
    hypStatus: { ...cur.hypStatus },
    banned: [...cur.banned],
    reruns: [...cur.reruns],
    feedback: [...cur.feedback],
    report: cur.report,
    grade: cur.grade,
  }
  switch (action.t) {
    case 'hyp':
      next.hypStatus[action.hypId] = action.status
      if (action.feedback) next.feedback.push(action.feedback)
      break
    case 'ban':
      if (!next.banned.includes(action.column)) next.banned.push(action.column)
      if (action.feedback) next.feedback.push(action.feedback)
      break
    case 'rerun':
      if (!next.reruns.includes(action.hypId)) next.reruns.push(action.hypId)
      if (action.feedback) next.feedback.push(action.feedback)
      break
    case 'feedback':
      next.feedback.push(action.feedback)
      break
    case 'report':
      next.report = action.report
      break
    case 'grade':
      next.grade = action.grade
      break
    case 'revert': {
      const u = action.undo
      if (u.kind === 'hyp') {
        if (u.prevStatus) next.hypStatus[u.hypId] = u.prevStatus
        else delete next.hypStatus[u.hypId]
        next.feedback = dropFeedback(next.feedback, u.feedbackId)
      } else if (u.kind === 'ban') {
        if (u.added) next.banned = next.banned.filter((c) => c !== u.column)
        next.feedback = dropFeedback(next.feedback, u.feedbackId)
      } else if (u.kind === 'rerun') {
        if (u.added) next.reruns = next.reruns.filter((h) => h !== u.hypId)
        next.feedback = dropFeedback(next.feedback, u.feedbackId)
      } else {
        next.feedback = dropFeedback(next.feedback, u.feedbackId)
      }
      break
    }
  }
  return { ...state, [action.studyId]: next }
}

type OverlayContextValue = {
  get: (studyId: string) => StudyOverlay
  dispatch: (action: OverlayAction) => void
}

const OverlayContext = createContext<OverlayContextValue | null>(null)

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {})
  const get = useCallback((studyId: string) => overlayFor(state, studyId), [state])
  const value = useMemo<OverlayContextValue>(() => ({ get, dispatch }), [get])
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
}

export function useOverlay(studyId: string): {
  overlay: StudyOverlay
  dispatch: (action: OverlayAction) => void
} {
  const ctx = useContext(OverlayContext)
  if (!ctx) throw new Error('useOverlay must be used within an OverlayProvider')
  return { overlay: ctx.get(studyId), dispatch: ctx.dispatch }
}

let localSeq = 0
/** Stamp a synthetic id on a locally-created feedback entry (no Date/random). */
export function localFeedback(input: Feedback): Feedback {
  return { ...input, id: input.id ?? `local-${(localSeq += 1)}` }
}

function signature(f: Feedback): string {
  return `${f.type}|${f.scope ?? ''}|${f.target_id ?? ''}|${f.content}`
}

/** Merge the overlay onto a server StudyDetail. Local feedback shows newest-first
 *  at the top; a server-persisted copy of the same note is de-duplicated. */
export function mergeStudyDetail(detail: StudyDetail, overlay: StudyOverlay): StudyDetail {
  const localSignatures = new Set(overlay.feedback.map(signature))
  const serverFeedback = (detail.feedback ?? []).filter((f) => !localSignatures.has(signature(f)))
  const localNewestFirst = [...overlay.feedback].reverse()
  return {
    ...detail,
    hypotheses: (detail.hypotheses ?? []).map((h) =>
      overlay.hypStatus[h.id] ? { ...h, status: overlay.hypStatus[h.id] } : h,
    ),
    feedback: [...localNewestFirst, ...serverFeedback],
  }
}
