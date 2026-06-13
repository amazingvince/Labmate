/** §02 DATA CONTRACT — row count, split strategy, and the column table with
 *  leakage-flagged rows carrying a [BAN] action (demo step 3). */
import type { DatasetVersion } from '../../api/types'
import type { StudyActions } from '../../api/hooks'
import { shortId } from '../../lib/derive'
import { EmptyState, Panel, SkeletonRows } from '../primitives'

function splitLine(ds: DatasetVersion): string | undefined {
  const s = ds.split_strategy
  if (!s) return undefined
  const ratios = s.ratios?.length === 3 ? s.ratios.map((r) => Math.round(r * 100)).join('/') : undefined
  const col = s.time_col ? `(${s.time_col})` : ''
  return `${s.strategy}${col} ${ratios ?? ''} · seed ${s.seed}`.trim()
}

export function DataContractPane({
  dataset,
  banned,
  actions,
  loading = false,
}: {
  dataset?: DatasetVersion
  banned: Set<string>
  actions: StudyActions
  loading?: boolean
}) {
  const body = () => {
    if (loading) return <SkeletonRows rows={6} />
    if (!dataset) {
      return <EmptyState label="No contract — run profile_dataset" />
    }
    const columns = dataset.columns ?? []
    const split = splitLine(dataset)
    const banPending = actions.banColumn.isPending ? actions.banColumn.variables : undefined

    return (
      <>
        <div className="contract__top">
          <span className="readout-xl">{dataset.row_count.toLocaleString()}</span>
          <span className="label">rows</span>
          {dataset.file_hash && (
            <span className="chip chip--muted" title={dataset.file_hash}>
              {shortId(dataset.file_hash, 8)}
            </span>
          )}
        </div>

        {split && <div className="contract__split">{split}</div>}

        {columns.length === 0 ? (
          <EmptyState label="No columns profiled" />
        ) : (
          <table className="coltable">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Missing</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {columns.map((col, i) => {
                const isBanned = banned.has(col.name)
                const leaky = col.is_candidate_leakage || isBanned
                const miss = col.missing_fraction ?? 0
                return (
                  <tr key={`${col.name}-${i}`} className={leaky ? 'is-leaky' : ''}>
                    <td>
                      <span className={`col-name ${isBanned ? 'is-banned' : ''}`}>{col.name}</span>
                      {col.is_candidate_leakage && col.leakage_reason && (
                        <span className="parse-hint" title={col.leakage_reason}>
                          {' '}
                          ⚠
                        </span>
                      )}
                    </td>
                    <td className="label" style={{ color: 'var(--text-sec)' }}>
                      {col.dtype}
                    </td>
                    <td>
                      <span className="tnum">{(miss * 100).toFixed(0)}%</span>
                      <span className="miss-bar">
                        <span className="miss-bar__fill" style={{ width: `${Math.min(100, miss * 100)}%` }} />
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {isBanned ? (
                        <span className="chip chip--danger">banned</span>
                      ) : col.is_candidate_leakage ? (
                        <button
                          type="button"
                          className="ban-btn"
                          disabled={actions.banColumn.isPending && banPending === col.name}
                          onClick={() => actions.banColumn.mutate(col.name)}
                        >
                          {actions.banColumn.isPending && banPending === col.name ? '…' : 'BAN'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </>
    )
  }

  return (
    <Panel num="02" title="DATA CONTRACT" areaClass="area-contract" acquiring={loading} crosshair>
      {body()}
    </Panel>
  )
}
