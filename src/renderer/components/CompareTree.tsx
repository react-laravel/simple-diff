import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CompareEntry, CompareFilter } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'
import { useCompareNodeInteractions } from '../hooks/useCompareNodeInteractions'
import { useCompareRowActions } from '../hooks/useCompareRowActions'
import { useTreeKeyboardNav } from '../hooks/useTreeKeyboardNav'
import { useVisibleCompareNodes } from '../hooks/useVisibleCompareNodes'
import { useCompareStore } from '../stores/compare-store'
import CompareTreeEmpty from './CompareTreeEmpty'
import CompareTreeRow, { META_GAP, SIZE_COLUMN, STATUS_COLUMN, TIME_COLUMN } from './CompareTreeRow'
import { TREE_OVERSCAN_ROWS, TREE_ROW_HEIGHT } from './tree-row-utils'
import { type TreeNode } from '../utils/tree-utils'
import { resolveCompareSelection } from '../utils/compare-selection'
import { useUIStore } from '../stores/ui-store'
import { cn } from '../lib/utils'

interface CompareTreeProps {
  readonly entries: readonly CompareEntry[]
  readonly filter: CompareFilter
  readonly onDoubleClickFile: (entry: CompareEntry) => void
  readonly emptyStateMessage?: string
  readonly onExtensionFilterChange?: (filter: readonly string[]) => void | Promise<void>
}

/**
 * 合并视图的结果树。
 *
 * chunk 6：工具栏从这里搬走了，只剩结果本身。
 * chunk 7：行从手写的 6 列 `<tr>` 换成共享 `TreeRow`（经 `CompareTreeRow`），于是
 * 三件事一起到位——每行左侧的 `DiffGutter` 符号（DESIGN-SYSTEM §1.5，绿/红在深色下
 * 的色盲分离度只有 ΔE 5.6，符号才是信号）、完整的 `treeitem` ARIA 与方向键导航、
 * 以及和分栏视图共享的同一份行动作（右键菜单与常驻 `⋯`）。
 */
export default function CompareTree({
  entries,
  filter,
  onDoubleClickFile,
  emptyStateMessage = '无匹配项',
  onExtensionFilterChange,
}: CompareTreeProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeInteractions = useCompareNodeInteractions(onDoubleClickFile)
  const { dirtyDisplayPaths, scanning } = useCompareStore(useShallow((state) => ({
    dirtyDisplayPaths: state.dirtyDisplayPaths,
    scanning: state.scanning,
  })))
  // 选择态提到 `ui-store`，与分栏视图和状态栏共用（设计蓝图 §4.1）。
  const selection = useUIStore((state) => state.treeSelection)
  const setSelection = useUIStore((state) => state.setTreeSelection)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const visibleNodes = useVisibleCompareNodes({ entries, filter })

  const renderedWindow = useMemo(() => {
    if (visibleNodes.length === 0) {
      return { startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 }
    }

    const safeViewportHeight = Math.max(viewportHeight, TREE_ROW_HEIGHT)
    const visibleCount = Math.ceil(safeViewportHeight / TREE_ROW_HEIGHT)
    const windowSize = visibleCount + TREE_OVERSCAN_ROWS * 2
    const rawStartIndex = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN_ROWS)
    const startIndex = Math.min(rawStartIndex, Math.max(0, visibleNodes.length - windowSize))
    const endIndex = Math.min(visibleNodes.length, startIndex + windowSize)

    return {
      startIndex,
      endIndex,
      topSpacerHeight: startIndex * TREE_ROW_HEIGHT,
      bottomSpacerHeight: Math.max(0, (visibleNodes.length - endIndex) * TREE_ROW_HEIGHT),
    }
  }, [scrollTop, viewportHeight, visibleNodes.length])

  const renderedNodes = useMemo(
    () => visibleNodes.slice(renderedWindow.startIndex, renderedWindow.endIndex),
    [renderedWindow.endIndex, renderedWindow.startIndex, visibleNodes],
  )

  useEffect(() => {
    setSelection((current) => {
      const nextSelectedPaths = new Set(Array.from(current.selectedPaths).filter((path) => visibleNodes.hasPath(path)))
      const nextAnchorPath = current.anchorPath && visibleNodes.hasPath(current.anchorPath) ? current.anchorPath : null

      if (nextSelectedPaths.size === current.selectedPaths.size && nextAnchorPath === current.anchorPath) {
        return current
      }

      return { selectedPaths: nextSelectedPaths, anchorPath: nextAnchorPath }
    })
  }, [visibleNodes])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return

    const update = () => {
      setViewportHeight(element.clientHeight)
      setScrollTop(element.scrollTop)
    }

    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const handleSelectNode = useCallback((event: React.MouseEvent, node: TreeNode) => {
    setSelection((current) => resolveCompareSelection(current, {
      orderedPaths: event.shiftKey ? visibleNodes.toPathArray() : [],
      clickedPath: node.relativePath,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    }))
  }, [visibleNodes])

  const rowActions = useCompareRowActions({
    onExtensionFilterChange,
    onOpenNode: nodeInteractions.openNode,
  })
  const buildActions = rowActions.buildActionsFor('merged')

  const keyboard = useTreeKeyboardNav({
    nodes: visibleNodes,
    viewportRef,
    rowHeight: TREE_ROW_HEIGHT,
    renderedRange: renderedWindow,
    isExpanded: nodeInteractions.isExpanded,
    onToggle: nodeInteractions.toggleNode,
  })
  // 焦点还没落到树里时，第一行是那唯一的 Tab 停靠点（roving tabIndex）。
  const focusedIndex = keyboard.focusedIndex < 0 ? 0 : keyboard.focusedIndex

  return (
    <div className="compare-merged-table flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex h-row-tree shrink-0 items-center gap-1.5 border-b border-border bg-surface-2 pr-1 pl-2 text-2xs font-medium tracking-wider text-fg-muted uppercase">
        <span className="min-w-0 flex-1 truncate">名称</span>
        <span className={cn('flex items-center', META_GAP)}>
          <span className={cn('shrink-0 text-right', SIZE_COLUMN)}>左大小</span>
          <span className={cn('shrink-0 text-right', TIME_COLUMN)}>左修改时间</span>
          <span className={cn('shrink-0 text-center', STATUS_COLUMN)}>状态</span>
          <span className={cn('shrink-0 text-right', SIZE_COLUMN)}>右大小</span>
          <span className={cn('shrink-0 text-right', TIME_COLUMN)}>右修改时间</span>
        </span>
      </div>

      <div
        ref={viewportRef}
        aria-busy={scanning || undefined}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {visibleNodes.length === 0 ? (
          <CompareTreeEmpty message={emptyStateMessage} onExtensionFilterChange={onExtensionFilterChange} />
        ) : (
          <div role="tree" aria-label="对比结果" aria-multiselectable onKeyDown={keyboard.onKeyDown}>
            {renderedWindow.topSpacerHeight > 0 && (
              <div aria-hidden="true" style={{ height: `${renderedWindow.topSpacerHeight}px` }} />
            )}
            {renderedNodes.map((node, offset) => {
              const index = renderedWindow.startIndex + offset
              return (
                <CompareTreeRow
                  key={node.relativePath}
                  node={node}
                  side="merged"
                  index={index}
                  setSize={visibleNodes.length}
                  expanded={nodeInteractions.isExpanded(node)}
                  loading={nodeInteractions.isLoading(node)}
                  dirty={dirtyDisplayPaths.has('') || dirtyDisplayPaths.has(node.relativePath)}
                  selected={selection.selectedPaths.has(node.relativePath)}
                  focused={index === focusedIndex}
                  onSelect={(event) => {
                    keyboard.setFocusedIndex(index)
                    handleSelectNode(event, node)
                  }}
                  onToggle={() => nodeInteractions.toggleNode(node)}
                  onActivate={() => nodeInteractions.activateNode(node)}
                  buildActions={buildActions}
                  renaming={rowActions.renamingPath === node.relativePath}
                  renameValue={rowActions.renameValue}
                  onRenameChange={rowActions.setRenameValue}
                  onRenameSubmit={() => rowActions.submitRename(node)}
                  onRenameCancel={rowActions.cancelRename}
                />
              )
            })}
            {renderedWindow.bottomSpacerHeight > 0 && (
              <div aria-hidden="true" style={{ height: `${renderedWindow.bottomSpacerHeight}px` }} />
            )}
          </div>
        )}
      </div>

      {rowActions.dialogs}
    </div>
  )
}
