/** The study cockpit. Owns the data (fetch + 4s poll + optimistic overlay) and
 *  renders the active tab. Keeping the fetch here — not per-tab — means switching
 *  tabs never re-fetches, re-polls, or drops the overlay. */
import { useMemo } from 'react'
import { hasActiveRun, useStudy, useStudyActions } from '@/api/hooks'
import { useAgentStream } from '@/api/useAgentStream'
import { deriveBannedColumns, methodologicalFlag, primaryMetricKey } from '@/lib/derive'
import { mergeStudyDetail, useOverlay } from '@/state/overlay'
import type { StudyTab } from '@/lib/router'
import { AppShell } from '@/components/layout/AppShell'
import { StudyHeader } from '@/components/layout/StudyHeader'
import { ActionBar } from '@/components/layout/ActionBar'
import { ErrorCard } from '@/components/states/ErrorCard'
import { GridSkeleton } from '@/components/states/LoadingSkeletons'
import { OverviewTab } from '@/components/tabs/OverviewTab'
import { ExperimentsTab } from '@/components/tabs/ExperimentsTab'
import { LedgerTab } from '@/components/tabs/LedgerTab'
import { ReportTab } from '@/components/tabs/ReportTab'
import { AgentActivity } from '@/components/study/AgentActivity'

// Streamed events that change durable state — refetch the study record so the
// other tabs (ledger, experiments, report) reflect what the agent just did.
const REFETCH_ON = new Set(['tool.result', 'study.done', 'loop.finished', 'session.ended'])

export function StudyView({ studyId, tab }: { studyId: string; tab: StudyTab }) {
  const query = useStudy(studyId)
  const { overlay } = useOverlay(studyId)

  const detail = useMemo(
    () => (query.data ? mergeStudyDetail(query.data, overlay) : undefined),
    [query.data, overlay],
  )

  const study = detail?.study
  const actions = useStudyActions(studyId, { budgetSeconds: study?.budget?.budget_seconds })

  // Live agent stream — only subscribe while the Live tab is open AND the study
  // is actually live: a run is in flight, or the study is still 'open' (the agent
  // could pick it up). For a done/stopped/idle study, opening the stream would
  // hang forever on "Connecting…", so we don't — AgentActivity shows a calm
  // terminal state instead. When a streamed event mutates durable state, refetch
  // so the other tabs stay current.
  const sessionLive = study?.status === 'open' || hasActiveRun(detail)
  const streamActive = tab === 'live' && sessionLive
  const stream = useAgentStream(streamActive ? studyId : undefined, (evt) => {
    if (REFETCH_ON.has(evt.kind)) actions.refresh()
  })

  const banned = useMemo(() => {
    if (!detail) return new Set<string>()
    const set = deriveBannedColumns(detail)
    overlay.banned.forEach((c) => set.add(c))
    return set
  }, [detail, overlay.banned])

  const flag = detail ? methodologicalFlag(detail) : undefined
  const metricKey = study ? primaryMetricKey(study) : undefined
  const runs = detail?.runs ?? []
  const ready = Boolean(detail && study)

  return (
    <AppShell
      footer={
        ready ? (
          <ActionBar
            studyId={studyId}
            study={study}
            recommendation={detail?.recommendation}
            flag={flag}
            actions={actions}
          />
        ) : undefined
      }
    >
      <StudyHeader studyId={studyId} study={study} runs={runs} flag={flag} tab={tab} />

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === 'live' ? (
          // The live stream is independent of the study fetch — show it even while
          // the record is still being created or if the read errored. When the
          // session isn't live we never opened the stream; flag it idle so the
          // feed reconstructs the last session's transcript from the durable
          // ledger (`detail`) instead of showing a bare "Session ended".
          <AgentActivity
            events={stream.events}
            status={stream.status}
            idle={ready && !streamActive}
            detail={detail}
          />
        ) : query.isError ? (
          <ErrorCard error={query.error} onRetry={() => query.refetch()} />
        ) : !ready || !detail || !study ? (
          <GridSkeleton />
        ) : tab === 'experiments' ? (
          <ExperimentsTab
            detail={detail}
            banned={banned}
            reruns={overlay.reruns}
            actions={actions}
            metricKey={metricKey}
          />
        ) : tab === 'ledger' ? (
          <LedgerTab detail={detail} banned={banned} actions={actions} metricKey={metricKey} />
        ) : tab === 'report' ? (
          <ReportTab
            study={study}
            detail={detail}
            banned={banned}
            report={overlay.report}
            grade={overlay.grade}
            recommendation={detail.recommendation}
            flag={flag}
            actions={actions}
          />
        ) : (
          <OverviewTab
            studyId={studyId}
            study={study}
            detail={detail}
            banned={banned}
            report={overlay.report}
            grade={overlay.grade}
            recommendation={detail.recommendation}
            flag={flag}
            actions={actions}
          />
        )}
      </div>
    </AppShell>
  )
}
