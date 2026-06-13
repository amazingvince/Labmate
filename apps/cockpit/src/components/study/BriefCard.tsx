/** The study brief: objective prose, a key/value table, and derived guardrails. */
import type { ReactNode } from 'react'
import type { Study, StudyDetail } from '@/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { StudyStatusBadge } from '@/components/study/StudyStatusBadge'
import { GuardrailChips } from '@/components/study/GuardrailChips'

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  )
}

export function BriefCard({
  study,
  detail,
  banned,
}: {
  study: Study
  detail: StudyDetail
  banned: Set<string>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Objective</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm leading-relaxed text-foreground/90">{study.brief}</p>

        <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-6 gap-y-2.5 text-sm">
          <Row k="Target">
            <span className="font-mono">{study.target}</span>
          </Row>
          <Row k="Task">{study.task_type ?? '—'}</Row>
          <Row k="Metric">
            <span className="font-mono">{study.metric}</span>
          </Row>
          {study.metric_rationale && (
            <Row k="Why">
              <span className="text-foreground/80">{study.metric_rationale}</span>
            </Row>
          )}
          <Row k="Max trials">
            <span className="font-mono tabular-nums">{study.budget?.max_trials ?? '—'}</span>
          </Row>
          <Row k="Budget">
            <span className="font-mono tabular-nums">
              {study.budget?.budget_seconds ?? '—'}s
            </span>
          </Row>
          <Row k="Status">
            <StudyStatusBadge status={study.status} />
          </Row>
        </dl>

        <Separator />

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Guardrails
          </p>
          <GuardrailChips detail={detail} banned={banned} />
        </div>
      </CardContent>
    </Card>
  )
}
