/** Small shared building blocks: the panel frame, loading/empty/error states,
 *  and the settle-on-lock metric readout. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatMetricValue, guardrailLabel } from '../lib/derive'

/** Render parsed_constraints as mono chips — the NL→constraint translation made
 *  visible (shared by the evidence ledger and the feedback box). */
export function ParsedChips({ parsed }: { parsed?: Record<string, unknown> }) {
  if (!parsed) return null
  const chips: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (value == null) continue
    if (key === 'primary_metric') chips.push(`primary · ${String(value)}`)
    else if (key === 'guardrail' || key === 'guardrails') {
      const list = Array.isArray(value) ? value : [value]
      list.forEach((v) => chips.push(guardrailLabel(String(v))))
    } else chips.push(`${key.replace(/_/g, ' ')} · ${String(value)}`)
  }
  if (chips.length === 0) return null
  return (
    <span className="feedback__chips">
      {chips.map((c) => (
        <span className="chip chip--cyan" key={c}>
          {c}
        </span>
      ))}
    </span>
  )
}

export function Panel({
  num,
  title,
  areaClass,
  acquiring = false,
  meta,
  flush = false,
  crosshair = false,
  children,
}: {
  num: string
  title: string
  areaClass?: string
  acquiring?: boolean
  meta?: ReactNode
  flush?: boolean
  crosshair?: boolean
  children: ReactNode
}) {
  return (
    <section className={`panel ${areaClass ?? ''}`}>
      <header className={`panel__head ${acquiring ? 'panel__head--acquiring' : ''}`}>
        <span className="panel__num">§{num}</span>
        <span className="panel__title" role="heading" aria-level={2}>
          {acquiring ? 'ACQUIRING…' : title}
        </span>
        {meta != null && <span className="panel__meta">{meta}</span>}
      </header>
      <div
        className={`panel__body ${flush ? 'panel__body--flush' : ''} ${crosshair ? 'crosshair' : ''}`}
      >
        {children}
      </div>
    </section>
  )
}

export function EmptyState({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {children}
      <span className="empty__label" role="heading" aria-level={3}>
        {label}
      </span>
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="panel-error" role="alert">
      <span className="panel-error__title" role="heading" aria-level={3}>
        ⚠ Signal lost
      </span>
      <span className="panel-error__detail">{message}</span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skel-stack">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i}>
          <span className="skel" style={{ width: '38%' }} />
          <span className="skel" style={{ width: '24%' }} />
          <span className="skel" style={{ flex: 1 }} />
        </div>
      ))}
    </div>
  )
}

export function Flatline() {
  return (
    <svg className="flatline" viewBox="0 0 200 40" fill="none" aria-hidden="true">
      <path
        d="M0 20 H70 l6 -13 l9 26 l7 -13 H200"
        stroke="var(--cyan-dim)"
        strokeWidth="1.5"
      />
    </svg>
  )
}

function scrambleDigits(): string {
  return `0.${Math.floor(Math.random() * 900 + 100)}`
}

/** Hero metric: scrambles digits while a run is live, then locks with a green flash. */
export function MetricReadout({
  value,
  running = false,
  format = formatMetricValue,
}: {
  value?: number
  running?: boolean
  format?: (n: number) => string
}) {
  const [display, setDisplay] = useState(() => (value != null ? format(value) : '–.–––'))
  const [locking, setLocking] = useState(false)
  const prev = useRef<number | undefined>(value)

  useEffect(() => {
    if (running) {
      setLocking(false)
      const id = window.setInterval(() => setDisplay(scrambleDigits()), 90)
      return () => window.clearInterval(id)
    }
    if (value != null) {
      setDisplay(format(value))
      if (prev.current !== value && Number.isFinite(value)) {
        prev.current = value
        setLocking(true)
        const t = window.setTimeout(() => setLocking(false), 700)
        return () => window.clearTimeout(t)
      }
      return undefined
    }
    setDisplay('–.–––')
    return undefined
  }, [running, value, format])

  return <span className={`metric-hero ${locking ? 'is-locking' : ''}`}>{display}</span>
}
