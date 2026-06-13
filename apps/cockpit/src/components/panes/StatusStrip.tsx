/** Persistent top readout: brand, study id, objective, target/metric chips, a
 *  budget gauge, and the global status lamp. The lamp flips red on a flag. */
import type { Critique, Run, Study } from '../../api/types'
import { CRITIQUE_LABEL, isActiveStatus } from '../../lib/derive'

type LampTone = 'flag' | 'running' | 'queued' | 'idle'

function lamp(flag: Critique | undefined, runs: Run[]): { tone: LampTone; glyph: string; label: string } {
  if (flag) return { tone: 'flag', glyph: '✕', label: `FLAG · ${CRITIQUE_LABEL[flag.kind]}` }
  if (runs.some((r) => r.status === 'running')) return { tone: 'running', glyph: '◉', label: 'RUNNING' }
  if (runs.some((r) => r.status === 'queued')) return { tone: 'queued', glyph: '◌', label: 'QUEUED' }
  return { tone: 'idle', glyph: '●', label: 'IDLE' }
}

export function StatusStrip({
  study,
  runs,
  flag,
}: {
  study?: Study
  runs: Run[]
  flag?: Critique
}) {
  const l = lamp(flag, runs)
  const maxTrials = study?.budget?.max_trials
  const budgetSeconds = study?.budget?.budget_seconds
  const trials = runs.length
  const fillPct = maxTrials ? Math.min(100, (trials / maxTrials) * 100) : 0
  const active = runs.some((r) => isActiveStatus(r.status))

  return (
    <div className="strip">
      <a className="strip__brand" href="#/" title="All studies">
        LABMATE <b>▸</b> MISSION&nbsp;CONTROL
      </a>
      {study && <span className="strip__id">{study.id}</span>}
      <span className="strip__obj">{study?.brief ?? 'No study selected'}</span>

      {study && (
        <span className="strip__chips">
          {study.target && <span className="chip chip--muted">target {study.target}</span>}
          {study.metric && <span className="chip chip--cyan">{study.metric}</span>}
        </span>
      )}

      <span className="strip__gauge" title="Trials run against budget">
        <span className="gauge__row">
          <span>trials</span>
          <span className="gauge__track">
            <span className="gauge__fill" style={{ width: `${fillPct}%` }} />
          </span>
          <span className="tnum">
            {trials}/{maxTrials ?? '—'}
          </span>
        </span>
        <span className="gauge__row">
          <span>budget</span>
          <span className="gauge__track">
            <span
              className="gauge__fill"
              style={{ width: active ? '100%' : '0%', background: 'var(--amber-dim)' }}
            />
          </span>
          <span className="tnum">{budgetSeconds ?? '—'}s</span>
        </span>
      </span>

      <span className={`lamp lamp--${l.tone}`}>
        <span className="lamp__dot" aria-hidden="true">
          {l.glyph}
        </span>
        {l.label}
      </span>
    </div>
  )
}
