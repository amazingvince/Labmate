/**
 * Types + client call for the dataset-upload route (`POST /api/datasets`).
 *
 * The profile shapes are the canonical ones from `@labmate/api-types`
 * (generated from `apps/api-spec/openapi.yaml`, mirroring `profileCsv` in
 * `apps/web/src/profiles.js`). We re-export them here so callers keep importing
 * from `@/api/datasets`, but there is now a single source of truth — never
 * hand-define these again.
 */
import type { components } from '@labmate/api-types'
import { API_BASE, HttpError } from './client'
import { getApiToken } from './token'

type Schemas = components['schemas']

/** One profiled column (a row of `profile.columns`). */
export type ProfileColumn = Schemas['ProfileColumn']

/** dtype inferred per column by `profileCsv`. */
export type ProfileDtype = ProfileColumn['dtype']

/** Suggested split strategy attached to the profile. Allows the `random` fallback. */
export type ProfileSplit = Schemas['ProfileSplit']

/**
 * The `profile` object returned by `profileCsv`.
 *
 * Note: `categorical_features`, `datetime_columns`, `target_definition` and
 * `sampled` are OPTIONAL in the canonical shape (the Worker omits them on an
 * empty CSV / fresh upload). Read them defensively.
 */
export type DatasetProfile = Schemas['DatasetProfile']

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
