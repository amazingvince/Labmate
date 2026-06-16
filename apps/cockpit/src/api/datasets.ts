/**
 * Types + client call for the dataset-upload route (`POST /api/datasets`).
 *
 * The OpenAPI generator (packages/api-types) does not cover this route yet, so
 * the shapes here are hand-written to match the Worker's `profileCsv` output in
 * `apps/web/src/profiles.js`. If that profiler changes, mirror it here.
 */
import { API_BASE, HttpError } from './client'
import { getApiToken } from './token'

/** dtype inferred per column by `profileCsv`. */
export type ProfileDtype = 'numeric' | 'categorical' | 'datetime' | 'boolean' | 'text'

/** One profiled column (matches a row of `profile.columns`). */
export type ProfileColumn = {
  name: string
  dtype: ProfileDtype
  /** Fraction missing in [0,1]. */
  missing_fraction: number
  /** Same as `missing_fraction * 100`, pre-rounded by the Worker. */
  missing_pct: number
  cardinality: number
  n_unique: number
  example_values: string[]
  is_candidate_leakage: boolean
  /** Present only when `is_candidate_leakage` is true. */
  leakage_reason?: string
}

/** Suggested split strategy attached to the profile. */
export type ProfileSplit = {
  strategy: 'time_based' | 'random'
  time_col?: string
  ratios: number[]
  seed: number
}

/** The `profile` object returned by `profileCsv`. */
export type DatasetProfile = {
  dataset_id: string
  row_count: number
  target: string | null
  target_definition: string | null
  leakage_candidates: string[]
  safe_features: string[]
  categorical_features: string[]
  datetime_columns: string[]
  split: ProfileSplit
  columns: ProfileColumn[]
  sampled: boolean
}

/** `POST /api/datasets` → 201 body. */
export type UploadDatasetResponse = {
  dataset_id: string
  profile: DatasetProfile
}

export type UploadDatasetOpts = {
  /** Optional R2-safe dataset id; the server assigns one when omitted. */
  datasetId?: string
  /** Optional target column — lets the profiler flag near-perfect separators. */
  target?: string
}

/**
 * Upload a CSV (raw `text/csv` body) and get back its server-side profile.
 * Token-gated write: a missing token surfaces as a 401 via `HttpError`, which
 * the caller turns into an "Unlock" prompt (same pattern as other writes).
 */
export async function uploadDataset(
  csv: string,
  opts: UploadDatasetOpts = {},
): Promise<UploadDatasetResponse> {
  const qs = new URLSearchParams()
  if (opts.datasetId) qs.set('dataset_id', opts.datasetId)
  if (opts.target) qs.set('target', opts.target)
  const query = qs.toString()

  const headers = new Headers({ 'content-type': 'text/csv' })
  const token = getApiToken()
  if (token) headers.set('authorization', `Bearer ${token}`)

  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/datasets${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers,
      body: csv,
    })
  } catch (err) {
    throw new HttpError(0, `Could not reach the API at ${API_BASE}`, (err as Error)?.message)
  }

  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }

  if (!res.ok) {
    const body = (data ?? {}) as Partial<{ error: string; detail: string }>
    throw new HttpError(res.status, body.error || `${res.status} ${res.statusText}`, body.detail)
  }
  return data as UploadDatasetResponse
}
