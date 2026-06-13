/**
 * Typed fetch client around VITE_API_BASE. Reads are public; writes carry the
 * shared internal bearer token (VITE_API_TOKEN). Flipping VITE_API_BASE from the
 * Prism mock to the real Worker is the only change needed to go live.
 */
import type {
  ApprovalRequest,
  Feedback,
  GradeResult,
  Report,
  RequestApprovalResponse,
  Study,
  StudyDetail,
  StudyListResponse,
} from './types'

const RAW_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:4010'
export const API_BASE = RAW_BASE.replace(/\/+$/, '')
const TOKEN = import.meta.env.VITE_API_TOKEN ?? ''

/** Error carrying the spec's { error, detail } body and the HTTP status. */
export class HttpError extends Error {
  readonly status: number
  readonly detail: string | undefined
  constructor(status: number, message: string, detail?: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.detail = detail
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('content-type', 'application/json')
  // Reads are public; sending the bearer anyway is harmless and covers writes.
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`)

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  } catch (err) {
    throw new HttpError(0, `Could not reach the API at ${API_BASE}`, (err as Error)?.message)
  }

  const text = await res.text()
  const data = text ? safeParse(text) : undefined

  if (!res.ok) {
    const body = (data ?? {}) as Partial<{ error: string; detail: string }>
    throw new HttpError(res.status, body.error || `${res.status} ${res.statusText}`, body.detail)
  }
  return data as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export const api = {
  base: API_BASE,
  hasToken: Boolean(TOKEN),

  listStudies(params?: { status?: Study['status']; limit?: number }): Promise<StudyListResponse> {
    const q = new URLSearchParams()
    if (params?.status) q.set('status', params.status)
    if (params?.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    return request<StudyListResponse>(`/api/studies${qs ? `?${qs}` : ''}`)
  },

  getStudy(id: string): Promise<StudyDetail> {
    return request<StudyDetail>(`/api/studies/${encodeURIComponent(id)}`)
  },

  recordFeedback(body: Feedback): Promise<Feedback> {
    return post<Feedback>('/api/feedback', body)
  },

  requestApproval(body: ApprovalRequest): Promise<RequestApprovalResponse> {
    return post<RequestApprovalResponse>('/api/approvals/request', body)
  },

  writeReport(body: { study_id: string; report_type?: 'model_card' | 'summary' }): Promise<Report> {
    return post<Report>('/api/reports', body)
  },

  gradeStudy(body: { study_id: string }): Promise<GradeResult> {
    return post<GradeResult>('/api/grade', body)
  },
}
