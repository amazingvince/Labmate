/** Dependency-free hash router. Routes: the study registry, and a study with a
 *  selected tab (#/study/<id>/<tab>). Bare #/study/<id> resolves to the default
 *  tab, so older links keep working. */
import { useSyncExternalStore } from 'react'

export const STUDY_TABS = ['overview', 'live', 'experiments', 'ledger', 'report'] as const
export type StudyTab = (typeof STUDY_TABS)[number]
export const DEFAULT_TAB: StudyTab = 'overview'

export const STUDY_TAB_LABELS: Record<StudyTab, string> = {
  overview: 'Overview',
  live: 'Live',
  experiments: 'Experiments',
  ledger: 'Ledger',
  report: 'Report',
}

export type Route =
  | { name: 'list' }
  | { name: 'new' }
  | { name: 'study'; id: string; tab: StudyTab }

function parse(hash: string): Route {
  const cleaned = hash.replace(/^#\/?/, '')
  const [seg, id, tabSeg] = cleaned.split('/')
  if (seg === 'new') return { name: 'new' }
  if (seg === 'study' && id) {
    const tab = (STUDY_TABS as readonly string[]).includes(tabSeg)
      ? (tabSeg as StudyTab)
      : DEFAULT_TAB
    return { name: 'study', id: decodeURIComponent(id), tab }
  }
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
  if (route.name === 'new') return '#/new'
  if (route.name !== 'study') return '#/'
  const id = encodeURIComponent(route.id)
  // Keep the default-tab URL bare so old links stay canonical.
  return route.tab === DEFAULT_TAB ? `#/study/${id}` : `#/study/${id}/${route.tab}`
}

/** Convenience for tab/cross links within a study. */
export function studyHref(id: string, tab: StudyTab = DEFAULT_TAB): string {
  return hrefFor({ name: 'study', id, tab })
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route)
}
