/** The study-detail cockpit: status strip, the etched four-pane grid (brief,
 *  data contract, experiment cards, run table, evidence ledger), and the dock. */
import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { qk, useStudy, useStudyActions } from '../api/hooks'
import { useAgentStream, type AgentEvent } from '../api/useAgentStream'
import {
  deriveBannedColumns,
  methodologicalFlag,
  primaryMetricKey,
  reportFromArtifacts,
} from '../lib/derive'
import { mergeStudyDetail, useOverlay } from '../state/overlay'
import { ErrorState } from './primitives'
import { StatusStrip } from './panes/StatusStrip'
import { BriefPane } from './panes/BriefPane'
import { DataContractPane } from './panes/DataContractPane'
import { ExperimentCards } from './panes/ExperimentCards'
import { RunTable } from './panes/RunTable'
import { EvidenceLedger } from './panes/EvidenceLedger'
import { Dock } from './panes/Dock'

export function StudyDetail({ studyId }: { studyId: string }) {
  const query = useStudy(studyId)
  const { overlay } = useOverlay(studyId)
  const qc = useQueryClient()

  // Live agent activity (SSE). A tool.result or study.done means the ledger / run
  // table likely changed on the server — refetch the study so they update promptly.
  const onAgentEvent = useCallback(
    (evt: AgentEvent) => {
      if (evt.kind === 'tool.result' || evt.kind === 'study.done') {
        qc.invalidateQueries({ queryKey: qk.study(studyId) })
      }
    },
    [qc, studyId],
  )
  const stream = useAgentStream(studyId, onAgentEvent)

  const detail = useMemo(
    () => (query.data ? mergeStudyDetail(query.data, overlay) : undefined),
    [query.data, overlay],
  )

  const study = detail?.study
  const actions = useStudyActions(studyId, { budgetSeconds: study?.budget?.budget_seconds })

  const banned = useMemo(() => {
    if (!detail) return new Set<string>()
    const set = deriveBannedColumns(detail)
    overlay.banned.forEach((c) => set.add(c))
    return set
  }, [detail, overlay.banned])

  const flag = detail ? methodologicalFlag(detail) : undefined
  const metricKey = study ? primaryMetricKey(study) : undefined
  const loading = query.isLoading
  const runs = detail?.runs ?? []
  const computing = runs.some((r) => r.status === 'running')
  // A fresh generate-report overlay wins; otherwise surface a persisted report
  // artifact so a done study shows the model-card link without a manual click.
  const report = useMemo(
    () => overlay.report ?? (detail ? reportFromArtifacts(detail) : undefined),
    [overlay.report, detail],
  )

  return (
    <div className="app">
      {computing && <div className="live-hairline" aria-hidden="true" />}
      <StatusStrip study={study} runs={runs} flag={flag} />

      {query.isError ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: 0 }}>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </div>
      ) : (
        <div className="cockpit">
          <BriefPane
            study={study}
            detail={detail}
            banned={banned}
            report={report}
            grade={overlay.grade}
            loading={loading}
          />
          <DataContractPane
            dataset={detail?.dataset_version}
            banned={banned}
            actions={actions}
            loading={loading}
          />
          <ExperimentCards
            hypotheses={detail?.hypotheses}
            runs={detail?.runs}
            critiques={detail?.critiques}
            banned={banned}
            reruns={overlay.reruns}
            actions={actions}
            metricKey={metricKey}
            loading={loading}
          />
          <RunTable
            runs={detail?.runs}
            hypotheses={detail?.hypotheses}
            critiques={detail?.critiques}
            metricKey={metricKey}
            loading={loading}
          />
          <EvidenceLedger
            detail={detail}
            metricKey={metricKey}
            loading={loading}
            stream={stream}
          />
        </div>
      )}

      <Dock
        study={study}
        recommendation={detail?.recommendation}
        flag={flag}
        actions={actions}
        report={report}
      />
    </div>
  )
}
