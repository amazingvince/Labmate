/** The data contract alongside the evidence timeline. */
import type { StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useReport } from '@/api/hooks'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataContractCard } from '@/components/study/DataContractCard'
import { EvidenceTimeline } from '@/components/study/EvidenceTimeline'

export function LedgerTab({
  detail,
  banned,
  actions,
  metricKey,
}: {
  detail: StudyDetail
  banned: Set<string>
  actions: StudyActions
  metricKey?: string
}) {
  // Pull the report so a promote decision in the timeline can flag when the
  // promoted run isn't the report's best.
  const report = useReport(detail.study?.id).data ?? undefined
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <DataContractCard dataset={detail.dataset_version} banned={banned} actions={actions} />
      <Card>
        <CardHeader>
          <CardTitle>Evidence ledger</CardTitle>
          <CardDescription>hypothesis → experiment → evidence → decision</CardDescription>
        </CardHeader>
        <CardContent>
          <EvidenceTimeline detail={detail} report={report} metricKey={metricKey} />
        </CardContent>
      </Card>
    </div>
  )
}
