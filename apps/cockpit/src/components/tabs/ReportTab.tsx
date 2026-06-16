/** The recommendation + model card and the definition-of-done rubric. The
 *  rendered model card is fetched from the control plane (the stored artifact),
 *  so it shows the real generated document and survives reload. */
import { DownloadIcon, FileTextIcon } from 'lucide-react'
import type { Critique, GradeResult, Report, Study, StudyDetail } from '@/api/types'
import type { StudyActions } from '@/api/hooks'
import { useReport } from '@/api/hooks'
import { api } from '@/api/client'
import { RecommendationPanel } from '@/components/study/RecommendationPanel'
import { ReadinessRubric } from '@/components/study/ReadinessRubric'
import { ModelCard } from '@/components/study/ModelCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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
  const reportQuery = useReport(study.id)
  const stored = reportQuery.data ?? undefined
  const markdown = stored?.markdown ?? report?.markdown
  const generating = actions.generateReport.isPending

  return (
    <div className="space-y-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <RecommendationPanel
          study={study}
          detail={detail}
          recommendation={recommendation}
          flag={flag}
          actions={actions}
          report={stored ?? report}
        />
        <ReadinessRubric detail={detail} banned={banned} report={stored ?? report} grade={grade} />
      </div>

      {markdown ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileTextIcon className="size-4 text-muted-foreground" />
              Model card
            </CardTitle>
            <a
              href={api.reportMarkdownUrl(study.id)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <DownloadIcon className="size-3.5" />
              Download .md
            </a>
          </CardHeader>
          <CardContent>
            <ModelCard markdown={markdown} />
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-1 py-10 text-center text-sm text-muted-foreground">
            <FileTextIcon className="size-5" />
            {generating
              ? 'Generating the model card…'
              : 'No model card yet — generate one from the recommendation panel.'}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
