import { buildVisibleNodeList, prepareCompareEntries, type PrepareCompareEntriesOptions, type VisibleTreeNodes } from '../utils/tree-utils'
import type { CompareEntry } from '@shared/types'
import { decodeVisibleTreeNodes, type CompareTreeResult } from './compare-tree-protocol'

export function computeVisibleTreeNodesAsync(
  entries: readonly CompareEntry[], options: PrepareCompareEntriesOptions,
  expandedDirs: ReadonlySet<string>, signal: AbortSignal,
): Promise<VisibleTreeNodes | null> {
  if (signal.aborted) return Promise.resolve(null)
  if (typeof Worker === 'undefined') {
    return Promise.resolve(buildVisibleNodeList(prepareCompareEntries(entries, options), expandedDirs))
  }
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null
    let finished = false
    const finish = (result: VisibleTreeNodes | null, error?: unknown) => {
      if (finished) return
      finished = true
      worker?.terminate()
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(null)
    signal.addEventListener('abort', abort, { once: true })
    try {
      worker = new Worker(new URL('./compare-tree.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<CompareTreeResult>) => finish(decodeVisibleTreeNodes(entries, event.data))
      worker.onerror = () => finish(null, new Error('目录树计算失败'))
      worker.onmessageerror = () => finish(null, new Error('无法读取目录树结果'))
      worker.postMessage({ entries, options, expandedDirs: [...expandedDirs] })
    } catch (error) { finish(null, error) }
  })
}
