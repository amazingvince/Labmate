/** §06 CURRENT RECOMMENDATION + the natural-language FEEDBACK BOX (sticky dock). */
import { useState } from 'react'
import type { Critique, Report, Study } from '../../api/types'
import type { StudyActions } from '../../api/hooks'
import { CRITIQUE_LABEL, parseConstraints, shortId } from '../../lib/derive'
import { ParsedChips } from '../primitives'

function splitRecommendation(rec: string | undefined, flag: Critique | undefined): {
  verb: string
  detail: string
} {
  const text = (rec ?? '').trim()
  if (text) {
    const m = text.match(/^(\S+)\s*(.*)$/)
    return { verb: (m?.[1] ?? text).toUpperCase(), detail: m?.[2] ?? '' }
  }
  if (flag) return { verb: 'REVIEW', detail: flag.finding }
  return { verb: 'STANDING BY', detail: '' }
}

function RecommendationDock({
  study,
  recommendation,
  flag,
  actions,
  report,
}: {
  study?: Study
  recommendation?: string
  flag?: Critique
  actions: StudyActions
  report?: Report
}) {
  const { verb, detail } = splitRecommendation(recommendation, flag)
  const disabled = !study || actions.generateReport.isPending

  return (
    <div className={`rec ${flag ? 'is-alert' : ''}`}>
      <div className="rec__verbwrap">
        <div className="rec__kicker">
          {flag ? `⚠ Methodological flag · ${CRITIQUE_LABEL[flag.kind]}` : 'Current recommendation'}
        </div>
        <div className="rec__verb">
          {verb}
          <span className="caret" aria-hidden="true">
            &nbsp;
          </span>
        </div>
        {detail && <div className="rec__detail">{detail}</div>}
      </div>

      {report && (
        <div className="report-out">
          <span className="label">Model card</span>
          <a href={report.uri} target="_blank" rel="noreferrer">
            {report.uri}
          </a>
          {report.compares_best_to_baseline && (
            <span className="chip chip--green">best vs baseline ✓</span>
          )}
          {report.reproducible_command && <code>{report.reproducible_command}</code>}
          {report.provenance?.seed != null && (
            <span className="parse-hint">
              seed {report.provenance.seed}
              {report.provenance.dataset_hash
                ? ` · data ${shortId(report.provenance.dataset_hash, 6)}`
                : ''}
            </span>
          )}
        </div>
      )}

      <div className="rec__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled}
          onClick={() => actions.generateReport.mutate()}
        >
          {actions.generateReport.isPending ? 'Generating…' : 'Generate report'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!study || actions.checkDone.isPending}
          onClick={() => actions.checkDone.mutate()}
        >
          {actions.checkDone.isPending ? 'Grading…' : 'Check done'}
        </button>
      </div>
    </div>
  )
}

function FeedbackBox({ study, actions }: { study?: Study; actions: StudyActions }) {
  const [text, setText] = useState('')
  const preview = parseConstraints(text)
  const pending = actions.sendFeedback.isPending

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || !study) return
    actions.sendFeedback.mutate(trimmed)
    setText('')
  }

  return (
    <div className="feedback">
      <span className="feedback__title">Record your judgment</span>
      <div className="feedback__field">
        <textarea
          value={text}
          placeholder="Recall matters more than precision, but false positives above 20% are not acceptable."
          aria-label="Record your judgment as natural language"
          aria-describedby="feedback-hint"
          disabled={!study || pending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!study || pending || text.trim().length === 0}
          onClick={submit}
        >
          {pending ? '···' : 'Send'}
        </button>
      </div>
      {preview && (
        <div className="feedback__preview">
          <span className="parse-hint">parses to →</span>
          <ParsedChips parsed={preview} />
        </div>
      )}
      <span className="parse-hint" id="feedback-hint">
        Enter to send · Shift+Enter for newline
      </span>
    </div>
  )
}

export function Dock({
  study,
  recommendation,
  flag,
  actions,
  report,
}: {
  study?: Study
  recommendation?: string
  flag?: Critique
  actions: StudyActions
  report?: Report
}) {
  return (
    <div className="dock">
      <RecommendationDock
        study={study}
        recommendation={recommendation}
        flag={flag}
        actions={actions}
        report={report}
      />
      <FeedbackBox study={study} actions={actions} />
    </div>
  )
}
