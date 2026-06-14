/**
 * Operator write-token store. The deployed cockpit ships WITHOUT a baked-in
 * token (the public bundle must stay credential-free), so writes are authorized
 * by a token the operator pastes once — it lives in this browser's localStorage
 * only, never in the bundle. Reads stay public. Falls back to a build-time
 * VITE_API_TOKEN when present (local dev convenience).
 */
import { useSyncExternalStore } from 'react'

const KEY = 'labmate-api-token'
const listeners = new Set<() => void>()

function envToken(): string {
  return (import.meta.env.VITE_API_TOKEN as string | undefined)?.trim() ?? ''
}

/** Current bearer token: the operator's localStorage value, else the env fallback. */
export function getApiToken(): string {
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(KEY)
    if (v && v.trim()) return v.trim()
  }
  return envToken()
}

export function hasApiToken(): boolean {
  return Boolean(getApiToken())
}

/** True when the active token came from the operator (localStorage), not the env. */
export function tokenIsOperatorSet(): boolean {
  return typeof localStorage !== 'undefined' && Boolean(localStorage.getItem(KEY)?.trim())
}

/** Persist (or clear, when blank) the operator token for this browser. */
export function setApiToken(token: string): void {
  const v = token.trim()
  if (typeof localStorage !== 'undefined') {
    if (v) localStorage.setItem(KEY, v)
    else localStorage.removeItem(KEY)
  }
  listeners.forEach((l) => l())
}

export function clearApiToken(): void {
  setApiToken('')
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Reactive: re-renders when the token is set/cleared. Returns whether one exists. */
export function useHasApiToken(): boolean {
  return useSyncExternalStore(subscribe, hasApiToken, () => false)
}
