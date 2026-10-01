import type { CompareEntry, CompareState } from '@shared/types'
import type { PrepareCompareEntriesOptions, TreeNode, VisibleTreeNodes } from '../utils/tree-utils'
import { buildVisibleNodeList, prepareCompareEntries } from '../utils/tree-utils'

export const TREE_STATES: readonly CompareState[] = ['equal', 'different', 'left_only', 'right_only', 'pending', 'comparing']

export interface CompareTreeRequest {
  readonly entries: readonly CompareEntry[]
  readonly options: PrepareCompareEntriesOptions
  readonly expandedDirs: readonly string[]
}

export interface CompareTreeResult {
  readonly indexes: Int32Array
  readonly states: Uint8Array
  /** Visible indexes sorted lexically for logarithmic selection membership checks. */
  readonly paths: Int32Array
}

export function prepareVisibleTreeProjection({ entries, options, expandedDirs }: CompareTreeRequest): CompareTreeResult {
  const prepared = prepareCompareEntries(entries, options)
  const visible = buildVisibleNodeList(prepared, new Set(expandedDirs))
  const byPath = new Map(entries.map((entry, index) => [entry.relativePath, index]))
  const indexes = new Int32Array(visible.length)
  const states = new Uint8Array(visible.length)
  for (let index = 0; index < visible.length; index++) {
    const node = visible.get(index)!
    indexes[index] = byPath.get(node.relativePath)!
    states[index] = TREE_STATES.indexOf(node.entry!.state)
  }
  const paths = Int32Array.from(indexes).sort((a, b) => {
    const left = entries[a].relativePath
    const right = entries[b].relativePath
    return left === right ? 0 : left < right ? -1 : 1
  })
  return { indexes, states, paths }
}

export function decodeVisibleTreeNodes(entries: readonly CompareEntry[], result: CompareTreeResult): VisibleTreeNodes {
  const get = (index: number): TreeNode | undefined => {
    if (index < 0 || index >= result.indexes.length) return undefined
    const original = entries[result.indexes[index]]
    const state = TREE_STATES[result.states[index]]
    const entry = state === original.state ? original : { ...original, state }
    return {
      name: entry.name, relativePath: entry.relativePath, isDirectory: entry.isDirectory,
      entry, depth: entry.relativePath.split('/').length - 1,
    }
  }
  const slice = (start = 0, end = result.indexes.length): readonly TreeNode[] => {
    const length = result.indexes.length
    const from = Math.max(0, Math.min(length, start < 0 ? length + start : start))
    const to = Math.max(0, Math.min(length, end < 0 ? length + end : end))
    const nodes: TreeNode[] = []
    for (let index = from; index < to; index++) nodes.push(get(index)!)
    return nodes
  }
  return {
    length: result.indexes.length, get, slice,
    toArray: () => slice(),
    toPathArray: () => Array.from(result.indexes, index => entries[index].relativePath),
    hasPath: path => {
      let lo = 0
      let hi = result.paths.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        const candidate = entries[result.paths[mid]].relativePath
        if (candidate === path) return true
        if (candidate < path) lo = mid + 1
        else hi = mid - 1
      }
      return false
    },
  }
}
