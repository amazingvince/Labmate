/** The recommendation + model card and the definition-of-done rubric. */
import type { Critique, GradeResult, Report, Study, StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { RecommendationPanel } from '@/components/study/RecommendationPanel'
import { ReadinessRubric } from '@/components/study/ReadinessRubric'

export function ReportTab({
  study,
  detail,
  banned,
  report,
  grade,
  recommendation,
  flag,
  actions,
}: {
  study: Study
  detail: StudyDetail
  banned: Set<string>
  report?: Report
  grade?: GradeResult
  recommendation?: string
  flag?: Critique
  actions: StudyActions
}) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <RecommendationPanel
        study={study}
        recommendation={recommendation}
        flag={flag}
        actions={actions}
        report={report}
      />
      <ReadinessRubric detail={detail} banned={banned} report={report} grade={grade} />
    </div>
  )
}
