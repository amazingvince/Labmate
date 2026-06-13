/** Dependency-free hash router. Two routes: study list and study detail. */
import { useSyncExternalStore } from 'react'

export type Route = { name: 'list' } | { name: 'study'; id: string }

function parse(hash: string): Route {
  const cleaned = hash.replace(/^#\/?/, '')
  const [seg, id] = cleaned.split('/')
  if (seg === 'study' && id) return { name: 'study', id: decodeURIComponent(id) }
  return { name: 'list' }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  )
  return parse(hash)
}

export function hrefFor(route: Route): string {
  return route.name === 'study' ? `#/study/${encodeURIComponent(route.id)}` : '#/'
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route)
}
