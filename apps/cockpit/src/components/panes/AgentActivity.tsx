/** Live AGENT ACTIVITY feed — the streamed Managed Agents session rendered as a
 *  readable timeline inside the §04 evidence-ledger region. Reuses the ledger's
 *  timeline primitives (.tl-entry / .timeline) so it sits flush with the ledger. */
import type { ReactNode } from 'react'
import type { AgentEvent, StreamStatus } from '../../api/useAgentStream'
import { EmptyState, Flatline } from '../primitives'
import { shortId } from '../../lib/derive'

/** Pull readable narration out of an agent.activity event's content blocks. */
function narration(event: unknown): string {
  const ev = event as { content?: unknown; message?: { content?: unknown }; text?: unknown } | undefined
  const blocks = (ev?.content ?? ev?.message?.content) as unknown
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => String((b as { text?: unknown }).text ?? ''))
      .join('')
      .trim()
    if (text) return text
  }
  if (typeof ev?.text === 'string') return ev.text
  return ''
}

/** Compact one-line preview of a tool's input args. */
function argsPreview(input: unknown): string {
  if (input == null) return ''
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    let val: string
    if (v == null) val = '–'
    else if (typeof v === 'object') val = Array.isArray(v) ? `[${v.length}]` : '{…}'
    else val = String(v)
    if (val.length > 28) val = `${val.slice(0, 27)}…`
    parts.push(`${k}=${val}`)
    if (parts.length >= 3) break
  }
  return parts.join(' ')
}

/** Read an error + http status out of a tool.result payload, if present. */
function resultError(result: unknown): { error?: string; status?: number } {
  if (!result || typeof result !== 'object') return {}
  const r = result as { error?: unknown; http_status?: unknown; status?: unknown; detail?: unknown }
  const error =
    typeof r.error === 'string' ? r.error : typeof r.detail === 'string' && r.error ? r.detail : undefined
  const status =
    typeof r.http_status === 'number'
      ? r.http_status
      : typeof r.status === 'number'
        ? r.status
        : undefined
  if (error == null && status == null) return {}
  return { error: error ?? 'error', status }
}

type Node = { color: string; glyph: string; type: string; body: ReactNode } | null

function nodeFor(evt: AgentEvent): Node {
  switch (evt.kind) {
    case 'session.created':
      return { color: 'var(--text-muted)', glyph: '⎈', type: 'SESSION', body: 'Session created' }
    case 'user.message':
    case 'human.guidance': {
      const isHuman = evt.kind === 'human.guidance'
      return {
        color: 'var(--amber)',
        glyph: isHuman ? '✎' : '▸',
        type: isHuman ? 'HUMAN' : 'KICKOFF',
        body: evt.text ? <span>{evt.text}</span> : isHuman ? 'Guidance injected' : 'Brief sent',
      }
    }
    case 'agent.activity': {
      const text = narration(evt.event)
      if (!text) return null
      return { color: 'var(--cyan)', glyph: '◇', type: 'AGENT', body: <span className="agent-narr">{text}</span> }
    }
    case 'tool.use': {
      const input = (evt.input ?? {}) as Record<string, unknown>
      const manifest = (input.manifest ?? {}) as Record<string, unknown>
      const script = typeof manifest.script === 'string' ? manifest.script : null
      return {
        color: 'var(--cyan-dim)',
        glyph: '🔧',
        type: 'TOOL',
        body: (
          <span>
            <b>{evt.name}</b>
            {script ? (
              // The rich bit: the actual training code the agent authored for the sandbox.
              <details className="agent-script">
                <summary className="parse-hint">
                  features={JSON.stringify((manifest.features as unknown[]) ?? [])} · tune_on=
                  {String(manifest.tune_on ?? 'validation')} · {script.split('\n').length} lines — view script
                </summary>
                <pre className="agent-script__code">{script}</pre>
              </details>
            ) : (
              evt.input != null && <span className="parse-hint"> ({argsPreview(evt.input)})</span>
            )}
          </span>
        ),
      }
    }
    case 'tool.result': {
      const { error, status } = resultError(evt.result)
      if (error) {
        return {
          color: 'var(--crit-leakage)',
          glyph: '⚠️',
          type: 'TOOL ✕',
          body: (
            <span>
              <b>{evt.name}</b> rejected{status != null ? ` · ${status}` : ''}
              {error && error !== 'error' ? <span className="parse-hint"> — {error}</span> : null}
            </span>
          ),
        }
      }
      const r = (evt.result ?? {}) as Record<string, unknown>
      const metrics = (r.metrics ?? {}) as Record<string, unknown>
      const mEntries = Object.entries(metrics).filter(([, v]) => typeof v === 'number') as [string, number][]
      return {
        color: 'var(--st-completed)',
        glyph: '✓',
        type: 'TOOL OK',
        body: (
          <span>
            <b>{evt.name}</b>
            {r.id ? <span className="parse-hint"> {shortId(String(r.id), 6)}</span> : ' ok'}
            {mEntries.length ? (
              <span className="agent-metrics">
                {' '}
                {mEntries.map(([k, v]) => `${k}=${v.toFixed(3)}`).join('  ')}
              </span>
            ) : null}
          </span>
        ),
      }
    }
    case 'nudge':
      return { color: 'var(--text-muted)', glyph: '⟲', type: 'NUDGE', body: 'Nudged the next step' }
    case 'approval.needed':
      return { color: 'var(--amber)', glyph: '⏸', type: 'APPROVAL', body: 'Approval requested' }
    case 'study.done':
      return { color: 'var(--st-completed)', glyph: '■', type: 'DONE', body: 'Study complete' }
    case 'session.ended':
      return { color: 'var(--text-muted)', glyph: '◻', type: 'SESSION', body: 'Session ended' }
    case 'loop.finished':
      return {
        color: 'var(--text-muted)',
        glyph: '◻',
        type: 'LOOP',
        body: (
          <span>
            Loop finished
            {typeof evt.toolCalls === 'number' ? ` · ${evt.toolCalls} tool calls` : ''}
            {evt.sessionId ? <span className="parse-hint"> {shortId(String(evt.sessionId), 6)}</span> : null}
          </span>
        ),
      }
    case 'loop.error':
    case 'runtime_unreachable':
      return {
        color: 'var(--st-failed)',
        glyph: '⚠',
        type: 'ERROR',
        body: (
          <span>
            {evt.error || evt.detail || 'Runtime error'}
            {evt.retry_status === 'retrying' ? <span className="parse-hint"> — retrying</span> : null}
          </span>
        ),
      }
    default:
      return null
  }
}

function Row({ node }: { node: NonNullable<Node> }) {
  return (
    <div className="tl-entry tl-entry--enter">
      <span
        className="tl-entry__node"
        style={{ borderColor: node.color, color: node.color }}
        aria-hidden="true"
      >
        {node.glyph}
      </span>
      <div className="tl-entry__head">
        <span className="tl-entry__type" style={{ color: node.color }}>
          {node.type}
        </span>
      </div>
      <div className="tl-entry__body">{node.body}</div>
    </div>
  )
}

export function AgentActivity({
  events,
  status,
}: {
  events: AgentEvent[]
  status: StreamStatus
}) {
  if (status === 'runtime_unavailable') {
    return (
      <div className="agent-feed">
        <EmptyState label="Runtime not connected">
          <Flatline />
        </EmptyState>
      </div>
    )
  }

  const rows = events.map((evt) => ({ evt, node: nodeFor(evt) })).filter((r) => r.node)

  if (rows.length === 0) {
    return (
      <div className="agent-feed">
        <EmptyState label={status === 'connected' ? 'Awaiting agent activity' : 'Connecting to live stream…'}>
          <Flatline />
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="agent-feed">
      <div className="agent-feed__head">
        <span className="agent-feed__title">Agent activity</span>
        <span className={`agent-feed__lamp is-${status}`} aria-live="polite">
          <span className="agent-feed__dot" aria-hidden="true">
            ●
          </span>
          {status === 'connected' ? 'LIVE' : status === 'error' ? 'RECONNECTING' : 'CONNECTING'}
        </span>
      </div>
      <div className="timeline">
        {rows.map(({ evt, node }) => (
          <Row key={evt.seq} node={node as NonNullable<Node>} />
        ))}
      </div>
    </div>
  )
}
