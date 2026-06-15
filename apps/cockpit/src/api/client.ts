/**
 * Typed fetch client around VITE_API_BASE. Reads are public; writes carry the
 * operator's internal bearer token (see api/token.ts — pasted by the operator,
 * stored in this browser, never baked into the public bundle). Flipping
 * VITE_API_BASE from the Prism mock to the real Worker is the only change needed
 * to go live.
 */
import { getApiToken, hasApiToken } from './token'
import type {
  ApprovalRequest,
  CreateStudyRequest,
  CreateStudyResponse,
  DatasetVersion,
  Feedback,
  GradeResult,
  ProposeExperimentsResponse,
  Report,
  RequestApprovalResponse,
  Study,
  StudyDetail,
  StudyListResponse,
} from './types'

const RAW_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:4010'
export const API_BASE = RAW_BASE.replace(/\/+$/, '')

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
  // Read fresh each request so unlocking takes effect without a reload.
  const token = getApiToken()
  if (token) headers.set('authorization', `Bearer ${token}`)

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
  get hasToken(): boolean {
    return hasApiToken()
  },

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

  /** Absolute URL of the public agent-activity SSE stream (EventSource can't send headers). */
  streamUrl(studyId: string): string {
    return `${API_BASE}/api/studies/${encodeURIComponent(studyId)}/stream`
  },

  /** Inject a human "suggest changes" message into the live session (token-required write). */
  suggestChange(studyId: string, text: string): Promise<{ status?: string }> {
    return post<{ status?: string }>(`/api/studies/${encodeURIComponent(studyId)}/message`, { text })
  },

  /** Latest rendered model card (markdown + provenance). 404 → no report yet. */
  getReport(studyId: string): Promise<Report> {
    return request<Report>(`/api/studies/${encodeURIComponent(studyId)}/report`)
  },

  /**
   * Direct URL to the raw model-card markdown (downloadable / openable).
   *
   * NOTE: this is consumed as a bare `<a href>` GET — the browser fetches it
   * WITHOUT the operator bearer token (an anchor can't carry an Authorization
   * header). It only works because the report route is PUBLIC (reads are public;
   * the markdown carries no secrets). If that route is ever moved behind auth,
   * this link breaks and must become a token-bearing `fetch` + object URL.
   */
  reportMarkdownUrl(studyId: string): string {
    return `${API_BASE}/api/studies/${encodeURIComponent(studyId)}/report?format=md`
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

  createStudy(body: CreateStudyRequest): Promise<CreateStudyResponse> {
    return post<CreateStudyResponse>('/api/studies', body)
  },

  profileDataset(study_id: string): Promise<DatasetVersion> {
    return post<DatasetVersion>('/api/profile', { study_id })
  },

  proposeExperiments(study_id: string, n = 6): Promise<ProposeExperimentsResponse> {
    return post<ProposeExperimentsResponse>('/api/experiments/propose', { study_id, n })
  },
}
