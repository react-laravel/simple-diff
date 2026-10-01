import { useCallback } from 'react'
import type { CompareEntry } from '../../../shared/types'
import { hasLoadingDescendantDirectory } from '../components/tree-row-utils'
import type { TreeNode } from '../utils/tree-utils'
import { useCompareStore } from '../stores/compare-store'

export interface CompareNodeInteractions {
  readonly isExpanded: (node: TreeNode) => boolean
  readonly isLoading: (node: TreeNode) => boolean
  readonly toggleNode: (node: TreeNode) => void
  readonly openNode: (node: TreeNode) => void
  /**
   * 双击 / `Enter` / `Space` 的统一含义（蓝图 §1.4：「展开目录 / 打开文件 Diff」）。
   * 以前双击目录什么也不发生——两处树都直接接了 `openNode`，而它对目录是 no-op。
   */
  readonly activateNode: (node: TreeNode) => void
}

export function useCompareNodeInteractions(
  onDoubleClickFile: (entry: CompareEntry) => void,
): CompareNodeInteractions {
  const expandedDirs = useCompareStore((state) => state.expandedDirs)
  const loadingDirs = useCompareStore((state) => state.loadingDirs)
  const paused = useCompareStore((state) => state.paused)
  const expandDir = useCompareStore((state) => state.expandDir)

  const isExpanded = useCallback(
    (node: TreeNode) => expandedDirs.has(node.relativePath),
    [expandedDirs],
  )

  const isLoading = useCallback(
    (node: TreeNode) => {
      if (paused || !node.isDirectory || !node.entry) return false

      if (node.entry.state === 'pending' || node.entry.state === 'comparing') {
        return true
      }

      return hasLoadingDescendantDirectory(node.relativePath, loadingDirs)
    },
    [loadingDirs, paused],
  )

  const toggleNode = useCallback(
    (node: TreeNode) => {
      if (node.isDirectory && !node.entry?.left?.isSymlink && !node.entry?.right?.isSymlink) {
        expandDir(node.relativePath)
      }
    },
    [expandDir],
  )

  const openNode = useCallback(
    (node: TreeNode) => {
      if (!node.isDirectory && node.entry && !node.entry.left?.isSymlink && !node.entry.right?.isSymlink) {
        onDoubleClickFile(node.entry)
      }
    },
    [onDoubleClickFile],
  )

  const activateNode = useCallback(
    (node: TreeNode) => {
      if (node.isDirectory) toggleNode(node)
      else openNode(node)
    },
    [openNode, toggleNode],
  )

  return { isExpanded, isLoading, toggleNode, openNode, activateNode }
}
