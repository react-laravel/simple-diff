import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  EyeOff,
  FolderOpen,
  Pencil,
  SquareSplitHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { createExactPathFilter } from '@shared/path-filter'
import type { SourceConfig } from '../../../shared/types'
import type { CompareRowSide } from '../components/CompareTreeRow'
import { ConfirmDialog, type MenuItem } from '../components/ui'
import { getRuntimeInfo } from '../runtime/runtime-info'
import { useCompareStore } from '../stores/compare-store'
import { useUIStore } from '../stores/ui-store'
import { collectSyncEntriesForSelection } from '../utils/compare-selection'
import type { TreeNode } from '../utils/tree-utils'
import { canQueueSyncDirection, useSelectionSync } from './useSelectionSync'

interface FileOpTarget {
  readonly side: 'left' | 'right'
  readonly label: '左侧' | '右侧'
  readonly source: SourceConfig
}

export interface UseCompareRowActionsOptions {
  /** 会话过滤只有一条写入路径；不传就直接写 store。 */
  readonly onExtensionFilterChange?: (filter: readonly string[]) => void | Promise<void>
  /** 打开文件差异标签（双击 / Enter 的同一个入口）。 */
  readonly onOpenNode: (node: TreeNode) => void
}

export interface CompareRowActions {
  /** 每一侧返回一个稳定的构造器，行组件可以按引用 `memo`。 */
  readonly buildActionsFor: (side: CompareRowSide) => (node: TreeNode) => MenuItem[]
  readonly renamingPath: string | null
  readonly renameValue: string
  readonly setRenameValue: (value: string) => void
  readonly submitRename: (node: TreeNode) => void
  readonly cancelRename: () => void
  /** 挂在树容器里的确认对话框（替代 `window.confirm`）。 */
  readonly dialogs: React.ReactNode
}

function parentRelativePath(relativePath: string): string {
  const segments = relativePath.split('/')
  return segments.length > 1 ? segments.slice(0, -1).join('/') : ''
}

/**
 * chunk 7 第 5 条：分栏树和合并树共用同一个右键 / `⋯` 动作构造器。
 *
 * 以前 `SplitTree` 给五项、`CompareTree` 给两项，同一行在两个视图里能做的事不一样，
 * 而且删除走的是 `window.confirm`（§7.5 明令禁止）。现在两边拿到的是同一份动作，
 * 合并视图里两侧都可操作时收成 `左侧 / 右侧` 子菜单。
 */
export function useCompareRowActions({
  onExtensionFilterChange,
  onOpenNode,
}: UseCompareRowActionsOptions): CompareRowActions {
  const runtime = getRuntimeInfo()
  const supportsSync = runtime.supportsSync
  const isDesktopRuntime = runtime.mode === 'tauri' || runtime.mode === 'electron'

  const {
    entries,
    extensionFilter,
    setExtensionFilter,
    leftSource,
    rightSource,
    syncTask,
    refreshDir,
  } = useCompareStore(useShallow((state) => ({
    entries: state.entries,
    extensionFilter: state.extensionFilter,
    setExtensionFilter: state.setExtensionFilter,
    leftSource: state.leftSource,
    rightSource: state.rightSource,
    syncTask: state.syncTask,
    refreshDir: state.refreshDir,
  })))
  const selectedPaths = useUIStore((state) => state.treeSelection.selectedPaths)
  const { copySelection } = useSelectionSync()

  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState<{
    readonly node: TreeNode
    readonly target: FileOpTarget
  } | null>(null)

  const applyExtensionFilter = useCallback((next: readonly string[]) => {
    if (onExtensionFilterChange) {
      void onExtensionFilterChange(next)
      return
    }
    setExtensionFilter(next)
  }, [onExtensionFilterChange, setExtensionFilter])

  const cancelRename = useCallback(() => setRenamingPath(null), [])

  const submitRename = useCallback((node: TreeNode) => {
    const trimmed = renameValue.trim()
    setRenamingPath(null)
    if (!trimmed || trimmed === node.name) return

    // 重命名总是落在存在该文件的那一侧；两侧都在时按左侧（与旧的分栏行为一致）。
    const source = node.entry?.left && leftSource?.type === 'local'
      ? leftSource
      : node.entry?.right && rightSource?.type === 'local'
        ? rightSource
        : null
    if (!source) return

    void (async () => {
      const result = await window.api.renameFile(source, node.relativePath, trimmed)
      if (result.success) {
        await refreshDir(parentRelativePath(node.relativePath))
      }
    })()
  }, [leftSource, refreshDir, renameValue, rightSource])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    const { node, target } = pendingDelete
    const result = await window.api.deleteFile(target.source, node.relativePath, node.isDirectory)
    if (result.success) {
      await refreshDir(parentRelativePath(node.relativePath))
    }
  }, [pendingDelete, refreshDir])

  const fileOpTargets = useCallback((node: TreeNode, side: CompareRowSide): FileOpTarget[] => {
    if (!isDesktopRuntime || !node.entry) return []
    const candidates: FileOpTarget[] = []
    if (side !== 'right' && node.entry.left && leftSource?.type === 'local') {
      candidates.push({ side: 'left', label: '左侧', source: leftSource })
    }
    if (side !== 'left' && node.entry.right && rightSource?.type === 'local') {
      candidates.push({ side: 'right', label: '右侧', source: rightSource })
    }
    return candidates
  }, [isDesktopRuntime, leftSource, rightSource])

  const buildActionsFor = useCallback((side: CompareRowSide) => (node: TreeNode): MenuItem[] => {
    const entry = node.entry
    if (!entry) return []
    if (side !== 'merged' && !(side === 'left' ? entry.left : entry.right)) return []

    const items: MenuItem[] = []

    if (!node.isDirectory) {
      items.push({
        id: 'open',
        label: '打开差异',
        icon: SquareSplitHorizontal,
        disabled: Boolean(entry.left?.isSymlink || entry.right?.isSymlink),
        onSelect: () => onOpenNode(node),
      })
    }

    const effectiveSelection = selectedPaths.has(node.relativePath)
      ? selectedPaths
      : new Set([node.relativePath])
    const selectedSuffix = effectiveSelection.size > 1 ? ` (${effectiveSelection.size})` : ''
    const directions = side === 'left'
      ? (['left_to_right'] as const)
      : side === 'right'
        ? (['right_to_left'] as const)
        : (['left_to_right', 'right_to_left'] as const)

    if (supportsSync) {
      for (const direction of directions) {
        const syncEntries = collectSyncEntriesForSelection(entries, effectiveSelection, direction)
        if (syncEntries.length === 0) continue
        const toRight = direction === 'left_to_right'
        const canCopy = canQueueSyncDirection(syncTask, leftSource, rightSource, direction)
        items.push({
          id: `copy-${direction}`,
          label: effectiveSelection.size > 1
            ? `${toRight ? '复制所选到右边' : '复制所选到左边'}${selectedSuffix}`
            : toRight ? '复制到右边' : '复制到左边',
          icon: toRight ? ArrowRightToLine : ArrowLeftToLine,
          disabled: !canCopy,
          onSelect: () => {
            if (!canCopy) return
            void copySelection(effectiveSelection, direction)
          },
        })
      }
    }

    const targets = fileOpTargets(node, side)
    const fanOut = (
      id: string,
      label: string,
      icon: LucideIcon,
      run: (target: FileOpTarget) => void,
      danger?: boolean,
    ): void => {
      if (targets.length === 0) return
      if (targets.length === 1) {
        items.push({ id, label, icon, danger, onSelect: () => run(targets[0]) })
        return
      }
      items.push({
        kind: 'submenu',
        id,
        label,
        icon,
        items: targets.map((target) => ({
          id: `${id}-${target.side}`,
          label: target.label,
          danger,
          onSelect: () => run(target),
        })),
      })
    }

    fanOut('reveal', '在 Finder 中显示', FolderOpen, (target) => {
      void window.api.showInFolder(target.source, node.relativePath)
    })
    fanOut('rename', '重命名', Pencil, () => {
      setRenamingPath(node.relativePath)
      setRenameValue(node.name)
    })

    items.push({
      id: 'ignore',
      label: `${node.isDirectory ? '忽略目录' : '忽略文件'}：『${node.name}』`,
      icon: EyeOff,
      onSelect: () => {
        const rule = createExactPathFilter(node.relativePath)
        if (extensionFilter.includes(rule)) return
        applyExtensionFilter([...extensionFilter, rule])
      },
    })

    fanOut('delete', '删除', Trash2, (target) => setPendingDelete({ node, target }), true)

    return items
  }, [
    applyExtensionFilter,
    copySelection,
    entries,
    extensionFilter,
    fileOpTargets,
    leftSource,
    onOpenNode,
    rightSource,
    selectedPaths,
    supportsSync,
    syncTask,
  ])

  const buildersBySide = useMemo(() => ({
    left: buildActionsFor('left'),
    right: buildActionsFor('right'),
    merged: buildActionsFor('merged'),
  }), [buildActionsFor])

  const dialogs = (
    <ConfirmDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => {
        if (!open) setPendingDelete(null)
      }}
      tone="danger"
      title={pendingDelete?.node.isDirectory ? '删除目录' : '删除文件'}
      body={`将从${pendingDelete?.target.label ?? ''}删除：`}
      subject={pendingDelete?.node.relativePath}
      consequence="文件会被直接删除，此操作不可撤销。"
      confirmLabel="删除"
      onConfirm={confirmDelete}
    />
  )

  return {
    buildActionsFor: (side) => buildersBySide[side],
    renamingPath,
    renameValue,
    setRenameValue,
    submitRename,
    cancelRename,
    dialogs,
  }
}
