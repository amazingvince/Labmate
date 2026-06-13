/** Live AGENT ACTIVITY feed — the streamed Managed Agents session rendered as a
 *  readable timeline. Surfaces the rich material the agent generates: its
 *  natural-language reasoning, the training script it authors, and the metrics
 *  each run returns. Styled with the shadcn primitives so it sits flush with the
 *  rest of the cockpit. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ClockIcon,
  PenLineIcon,
  PlugZapIcon,
  RotateCwIcon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react'
import type { AgentEvent, StreamStatus } from '@/api/useAgentStream'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { shortId } from '@/lib/derive'

/** Pull readable narration out of an agent.activity event's content blocks. */
function narration(event: unknown): string {
  const ev = event as
    | { content?: unknown; message?: { content?: unknown }; text?: unknown }
    | undefined
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

/** Find the authored training script inside a tool.use input, if any. */
function scriptOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const manifest = (o.manifest ?? {}) as Record<string, unknown>
  const s = o.script ?? manifest.script
  return typeof s === 'string' && s.trim() ? s : undefined
}

/** Compact one-line preview of a tool's input args (excluding the bulky script). */
function argsPreview(input: unknown): string {
  if (input == null) return ''
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'script' || k === 'manifest') continue
    let val: string
    if (v == null) val = '–'
    else if (typeof v === 'object') val = Array.isArray(v) ? `[${v.length}]` : '{…}'
    else val = String(v)
    if (val.length > 32) val = `${val.slice(0, 31)}…`
    parts.push(`${k}=${val}`)
    if (parts.length >= 4) break
  }
  return parts.join('  ')
}

/** Pull a metrics map out of a tool.result payload, if present. */
function metricsOf(result: unknown): Record<string, number> | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  const m = (r.metrics ?? (r.run as Record<string, unknown> | undefined)?.metrics) as unknown
  if (!m || typeof m !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** Read an error + http status out of a tool.result payload, if present. */
function resultError(result: unknown): { error?: string; status?: number } {
  if (!result || typeof result !== 'object') return {}
  const r = result as { error?: unknown; http_status?: unknown; status?: unknown; detail?: unknown }
  const failed = typeof r.status === 'string' && r.status === 'failed'
  const error =
    typeof r.error === 'string'
      ? r.error
      : typeof r.detail === 'string'
        ? r.detail
        : failed
          ? 'failed'
          : undefined
  const httpStatus =
    typeof r.http_status === 'number'
      ? r.http_status
      : typeof r.status === 'number'
        ? r.status
        : undefined
  if (error == null && httpStatus == null) return {}
  return { error: error ?? 'error', status: httpStatus }
}

type Tone = 'muted' | 'human' | 'agent' | 'tool' | 'ok' | 'error'

const TONE_TEXT: Record<Tone, string> = {
  muted: 'text-muted-foreground',
  human: 'text-amber-600 dark:text-amber-400',
  agent: 'text-sky-600 dark:text-sky-400',
  tool: 'text-violet-600 dark:text-violet-400',
  ok: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-destructive',
}

type Node = { tone: Tone; icon: ReactNode; label: string; body: ReactNode } | null

function nodeFor(evt: AgentEvent): Node {
  switch (evt.kind) {
    case 'session.created':
      return { tone: 'muted', icon: <CircleDotIcon />, label: 'Session', body: 'Session created' }
    case 'user.message':
    case 'human.guidance': {
      const isHuman = evt.kind === 'human.guidance'
      return {
        tone: 'human',
        icon: isHuman ? <PenLineIcon /> : <SendIcon />,
        label: isHuman ? 'Human' : 'Kickoff',
        body: evt.text ? <span>{evt.text}</span> : isHuman ? 'Guidance injected' : 'Brief sent',
      }
    }
    case 'agent.activity': {
      const text = narration(evt.event)
      if (!text) return null
      return {
        tone: 'agent',
        icon: <SparklesIcon />,
        label: 'Agent',
        body: <p className="whitespace-pre-wrap leading-relaxed">{text}</p>,
      }
    }
    case 'tool.use': {
      const script = scriptOf(evt.input)
      const preview = argsPreview(evt.input)
      return {
        tone: 'tool',
        icon: <WrenchIcon />,
        label: 'Tool',
        body: (
          <div className="space-y-2">
            <span>
              <b className="font-medium">{evt.name}</b>
              {preview && <span className="text-muted-foreground"> · {preview}</span>}
            </span>
            {script && <ScriptBlock script={script} />}
          </div>
        ),
      }
    }
    case 'tool.result': {
      const { error, status } = resultError(evt.result)
      if (error) {
        return {
          tone: 'error',
          icon: <TriangleAlertIcon />,
          label: 'Rejected',
          body: (
            <span>
              <b className="font-medium">{evt.name}</b> rejected
              {status != null ? ` · ${status}` : ''}
              {error && error !== 'error' ? (
                <span className="text-muted-foreground"> — {error}</span>
              ) : null}
            </span>
          ),
        }
      }
      const metrics = metricsOf(evt.result)
      return {
        tone: 'ok',
        icon: <CheckIcon />,
        label: 'Result',
        body: (
          <div className="space-y-2">
            <span>
              <b className="font-medium">{evt.name}</b> ok
            </span>
            {metrics && <MetricChips metrics={metrics} />}
          </div>
        ),
      }
    }
    case 'nudge':
      return { tone: 'muted', icon: <RotateCwIcon />, label: 'Nudge', body: 'Nudged the next step' }
    case 'approval.needed': {
      const ms = typeof evt.auto_approve_in_ms === 'number' ? evt.auto_approve_in_ms : undefined
      return {
        tone: 'human',
        icon: <ClockIcon />,
        label: 'Approval',
        body: (
          <span>
            Approval requested
            {ms != null ? (
              <span className="text-muted-foreground"> — auto-approving in {Math.round(ms / 1000)}s</span>
            ) : null}
          </span>
        ),
      }
    }
    case 'study.done':
      return { tone: 'ok', icon: <CheckIcon />, label: 'Done', body: 'Study complete' }
    case 'session.ended':
      return { tone: 'muted', icon: <SquareIcon />, label: 'Session', body: 'Session ended' }
    case 'loop.finished':
      return {
        tone: 'muted',
        icon: <SquareIcon />,
        label: 'Loop',
        body: (
          <span>
            Loop finished
            {typeof evt.toolCalls === 'number' ? ` · ${evt.toolCalls} tool calls` : ''}
            {evt.sessionId ? (
              <span className="text-muted-foreground"> {shortId(String(evt.sessionId), 6)}</span>
            ) : null}
          </span>
        ),
      }
    case 'loop.error':
    case 'runtime_unreachable':
      return {
        tone: 'error',
        icon: <TriangleAlertIcon />,
        label: 'Error',
        body: (
          <span>
            {evt.error || evt.detail || 'Runtime error'}
            {evt.retry_status === 'retrying' ? (
              <span className="text-muted-foreground"> — retrying</span>
            ) : null}
          </span>
        ),
      }
    default:
      return null
  }
}

/** Collapsible view of the training script the agent authored for a run. */
function ScriptBlock({ script }: { script: string }) {
  const [open, setOpen] = useState(false)
  const lines = script.split('\n').length
  return (
    <div className="rounded-md border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRightIcon
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        {open ? 'Hide' : 'View'} authored script
        <span className="font-normal text-muted-foreground/70">· {lines} lines</span>
      </button>
      {open && (
        <pre className="max-h-80 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed">
          <code>{script}</code>
        </pre>
      )}
    </div>
  )
}

/** Metric chips for a completed run's result. */
function MetricChips({ metrics }: { metrics: Record<string, number> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(metrics).map(([k, v]) => (
        <Badge key={k} variant="secondary" className="font-mono text-[11px]">
          <span className="text-muted-foreground">{k}</span>
          <span className="ml-1 tabular-nums">{Number.isInteger(v) ? v : v.toFixed(3)}</span>
        </Badge>
      ))}
    </div>
  )
}

function Row({ node }: { node: NonNullable<Node> }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background [&_svg]:size-3.5',
          TONE_TEXT[node.tone],
        )}
        aria-hidden="true"
      >
        {node.icon}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <span className={cn('text-[11px] font-semibold uppercase tracking-wide', TONE_TEXT[node.tone])}>
          {node.label}
        </span>
        <div className="text-sm text-foreground/90">{node.body}</div>
      </div>
    </li>
  )
}

function StatusLamp({ status }: { status: StreamStatus }) {
  const label =
    status === 'connected'
      ? 'Live'
      : status === 'error'
        ? 'Reconnecting'
        : status === 'runtime_unavailable'
          ? 'Offline'
          : 'Connecting'
  const tone =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'error'
        ? 'bg-amber-500'
        : status === 'runtime_unavailable'
          ? 'bg-muted-foreground'
          : 'bg-sky-500'
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      <span
        className={cn('size-2 rounded-full', tone, status === 'connected' && 'animate-pulse')}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

export function AgentActivity({
  events,
  status,
}: {
  events: AgentEvent[]
  status: StreamStatus
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = events.map((evt) => ({ evt, node: nodeFor(evt) })).filter((r) => r.node)

  // Keep the newest activity in view as it streams in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows.length])

  return (
    <Card className="flex h-[70vh] flex-col gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b px-6 py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ActivityIcon className="size-4 text-muted-foreground" />
          Agent activity
        </CardTitle>
        <StatusLamp status={status} />
      </CardHeader>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {status === 'runtime_unavailable' && rows.length === 0 ? (
          <Empty icon={<PlugZapIcon className="size-5" />} label="Runtime not connected" />
        ) : rows.length === 0 ? (
          <Empty
            icon={<ActivityIcon className="size-5 animate-pulse" />}
            label={status === 'connected' ? 'Awaiting agent activity…' : 'Connecting to live stream…'}
          />
        ) : (
          <ol className="relative">
            {rows.map(({ evt, node }) => (
              <Row key={evt.seq} node={node as NonNullable<Node>} />
            ))}
          </ol>
        )}
      </div>
    </Card>
  )
}

function Empty({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      {icon}
      <span className="text-sm">{label}</span>
    </div>
  )
}
