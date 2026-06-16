/**
 * Live agent-activity stream. Subscribes to the public SSE proxy
 * (GET /api/studies/{id}/stream) with EventSource and accumulates events into a
 * capped buffer. The control plane proxies the agent runtime's Managed Agents
 * event stream; each default `data:` frame is a JSON object with a `kind`
 * discriminator. When no runtime is wired the control plane instead emits NAMED
 * events (`info` → runtime_unavailable, `error` → runtime_unreachable), so we
 * listen for both the default `message` channel and those named channels.
 *
 * EventSource cannot send an Authorization header — that's fine: the stream route
 * is public. Reconnects on transport error with a bounded backoff.
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './client'

/** A streamed agent event, normalized to a `kind`-discriminated record. */
export type AgentEvent = {
  /** monotonic local id so React keys stay stable across the capped buffer */
  seq: number
  kind: string
  study_id?: string
  text?: string
  name?: string
  input?: unknown
  result?: unknown
  event?: unknown
  error?: string
  http_status?: number
  retry_status?: string
  detail?: string
  // tolerate any other fields the runtime emits
  [k: string]: unknown
}

export type StreamStatus =
  | 'connecting' // before the first successful open
  | 'connected' // live
  | 'reconnecting' // transport dropped AFTER a successful open; backing off
  | 'runtime_unavailable' // worker says no runtime is wired/reachable
  | 'error' // a terminal server-sent error frame
  | 'ended' // the session reached a terminal event and the stream closed

const MAX_EVENTS = 300
const MAX_BACKOFF_MS = 15_000

export type AgentStream = { events: AgentEvent[]; status: StreamStatus }

function safeParse(data: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(data)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Subscribe to a study's live agent activity.
 * @param studyId   study to stream (no-op when undefined)
 * @param onEvent   optional callback fired for every parsed frame (e.g. to refetch)
 */
export function useAgentStream(
  studyId: string | undefined,
  onEvent?: (evt: AgentEvent) => void,
): AgentStream {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [status, setStatus] = useState<StreamStatus>('connecting')
  // Keep the latest callback without forcing the effect to re-subscribe.
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!studyId) return
    // Reset buffer when switching studies.
    setEvents([])
    setStatus('connecting')

    const seq = { n: 0 }
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    let closed = false
    // Latched once the worker tells us no runtime is wired/reachable; stops reconnecting.
    let unavailable = false
    // Latched once the study reaches a terminal event; a normal stream end after this
    // is not an error and must not reconnect (which would replay the buffer + re-refetch).
    let finished = false
    // True once the EventSource has opened at least once — distinguishes a first
    // connection ("Connecting…") from a dropped one ("Reconnecting").
    let hasConnected = false
    const TERMINAL = new Set(['study.done', 'session.ended', 'loop.finished'])

    const push = (raw: Record<string, unknown> | undefined, fallbackKind: string) => {
      if (!raw) return
      const evt: AgentEvent = {
        seq: (seq.n += 1),
        kind: typeof raw.kind === 'string' ? raw.kind : fallbackKind,
        ...raw,
      }
      setEvents((prev) => {
        const next = prev.length >= MAX_EVENTS ? prev.slice(prev.length - MAX_EVENTS + 1) : prev
        return [...next, evt]
      })
      onEventRef.current?.(evt)
    }

    const connect = () => {
      if (closed) return
      es = new EventSource(api.streamUrl(studyId))

      es.onopen = () => {
        attempts = 0
        hasConnected = true
        setStatus((s) => (s === 'runtime_unavailable' ? s : 'connected'))
      }

      // Mark "runtime not connected": stop reconnecting and show a clean state.
      const latchUnavailable = (raw: Record<string, unknown> | undefined, fallbackKind: string) => {
        unavailable = true
        closed = true
        setStatus('runtime_unavailable')
        push(raw, fallbackKind)
        es?.close()
      }

      // Latch a terminal server-sent error frame: render the error, stop
      // reconnecting (the body has already closed; hammering a down runtime is
      // pointless). Used for ANY named `error` frame that carries a body, not
      // just runtime_unreachable.
      const latchError = (raw: Record<string, unknown> | undefined, fallbackKind: string) => {
        unavailable = true
        closed = true
        setStatus('error')
        push(raw, fallbackKind)
        es?.close()
      }

      // Default channel: the proxied runtime frames (kind on the payload).
      es.onmessage = (ev) => {
        const raw = safeParse(ev.data)
        // Defensive: the worker emits runtime_unavailable as a named `info` event,
        // but latch fully here too in case a future control-plane sends it inline.
        if (raw?.kind === 'runtime_unavailable') {
          latchUnavailable(raw, 'runtime_unavailable')
          return
        }
        if (!unavailable) setStatus('connected')
        push(raw, 'agent.activity')
        if (typeof raw?.kind === 'string' && TERMINAL.has(raw.kind)) finished = true
      }

      // Named channel `info`: the worker's "no runtime wired" signal — render a
      // clean disconnected state rather than erroring, and don't reconnect-loop.
      es.addEventListener('info', (ev) => {
        const raw = safeParse((ev as MessageEvent).data)
        if (raw?.kind === 'runtime_unavailable') latchUnavailable(raw, 'runtime_unavailable')
        else push(raw, 'info')
      })

      // Named channel `error`: a SERVER-sent error frame (has .data) — the worker
      // reached a configured runtime and the fetch threw (runtime_unreachable), or
      // the loop itself errored. Either way it's a single finite frame and the body
      // then closes, so ANY named error frame that carries a body is TERMINAL:
      // latch it and stop reconnecting. runtime_unreachable keeps the dedicated
      // "Offline" framing; everything else shows as a terminal error.
      // Transport errors also dispatch 'error' but carry no .data — let onerror handle those.
      es.addEventListener('error', (ev) => {
        const raw = safeParse((ev as MessageEvent).data)
        if (!raw) return
        if (raw.kind === 'runtime_unreachable') latchUnavailable(raw, 'runtime_unreachable')
        else latchError(raw, 'loop.error')
      })

      // Transport-level error (connection dropped / never opened). Reconnect with
      // bounded backoff — unless the runtime is unavailable, or the study already
      // reached a terminal event (a normal end-of-stream, not a failure).
      es.onerror = () => {
        if (closed || unavailable) return
        es?.close()
        if (finished) {
          closed = true
          setStatus('ended')
          return
        }
        // Before the first successful open this is still an initial connect, so
        // keep "connecting"; once we've connected at least once it's a reconnect.
        setStatus(hasConnected ? 'reconnecting' : 'connecting')
        attempts += 1
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 4))
        retryTimer = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      es?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId])

  return { events, status }
}
