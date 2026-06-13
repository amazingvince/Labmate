/** Cockpit home — the study registry (GET /api/studies) with a status filter. */
import { useState } from 'react'
import { useStudies } from '../api/hooks'
import type { Study } from '../api/types'
import { hrefFor } from '../lib/router'
import { EmptyState, ErrorState, SkeletonRows } from './primitives'

const FILTERS: { key: Study['status'] | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'done', label: 'Done' },
  { key: 'stopped', label: 'Stopped' },
]

function statusChip(status: Study['status']) {
  const cls = status === 'done' ? 'chip--green' : status === 'stopped' ? 'chip--danger' : 'chip--cyan'
  return <span className={`chip ${cls}`}>{status}</span>
}

export function StudyList() {
  const [filter, setFilter] = useState<Study['status'] | 'all'>('all')
  const query = useStudies(filter === 'all' ? undefined : filter)
  const studies = query.data?.studies ?? []

  return (
    <div className="app" style={{ gridTemplateRows: 'var(--strip-h) 1fr' }}>
      <div className="strip">
        <span className="strip__brand">
          LABMATE <b>▸</b> MISSION&nbsp;CONTROL
        </span>
        <span className="strip__obj">Study registry — the agent&apos;s evidence ledgers</span>
        <span className="lamp lamp--idle">
          <span className="lamp__dot" aria-hidden="true">
            ●
          </span>
          {studies.length} studies
        </span>
      </div>

      <div className="listview">
        <div className="listview__head">
          <div>
            <h1 className="listview__title">Studies</h1>
            <div className="listview__sub">
              hypothesis → experiment → evidence → decision
            </div>
          </div>
          <div className="filterow">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`filterchip ${filter === f.key ? 'is-active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {query.isLoading ? (
          <SkeletonRows rows={6} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : studies.length === 0 ? (
          <EmptyState label="No studies — create one via the MCP create_study tool" />
        ) : (
          <div className="studygrid">
            {studies.map((s, i) => (
              <a className="studycard" key={s.id || i} href={hrefFor({ name: 'study', id: s.id })}>
                <div className="studycard__top">
                  <span className="studycard__id">{s.id}</span>
                  {statusChip(s.status)}
                </div>
                <p className="studycard__brief">{s.brief}</p>
                <div className="studycard__foot">
                  {s.target && <span className="chip chip--muted">target {s.target}</span>}
                  {s.metric && <span className="chip chip--cyan">{s.metric}</span>}
                  {s.task_type && <span className="chip chip--muted">{s.task_type}</span>}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
