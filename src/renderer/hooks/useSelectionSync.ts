import { confirmSync } from '../utils/confirm-sync'
import { reportSyncResult } from '../utils/sync-feedback'
import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { SourceConfig, SyncDirection, SyncTaskSnapshot } from '../../../shared/types'
import { useCompareStore } from '../stores/compare-store'
import { collectSyncEntriesForSelection } from '../utils/compare-selection'
import { isSameSourceConfig } from '../utils/source-label'
import { getSyncRecompareRootsFromEntries } from '../utils/sync-dirty'
import { rememberSyncDirtyRoots } from './useCompare'

/**
 * 队列里已经有一个跑着的同步任务时，只允许追加同方向、同数据源的条目。
 * 原本在 `SplitTree.tsx` 与 `CompareTree.tsx` 里各写了一份，完全一致。
 */
export function canQueueSyncDirection(
  syncTask: SyncTaskSnapshot | null,
  leftSource: SourceConfig | null,
  rightSource: SourceConfig | null,
  direction: SyncDirection,
): boolean {
  if (!leftSource || !rightSource) {
    return false
  }

  if (syncTask?.currentPath && syncTask.status === 'paused') return false

  if (!syncTask || syncTask.status !== 'running') {
    return true
  }

  return syncTask.direction === direction
    && isSameSourceConfig(syncTask.leftSource, leftSource)
    && isSameSourceConfig(syncTask.rightSource, rightSource)
}

export interface SelectionSync {
  readonly canQueue: (direction: SyncDirection) => boolean
  /** 统计某个方向上实际会被复制的条目数，用于按钮禁用与菜单文案。 */
  readonly countFor: (paths: ReadonlySet<string>, direction: SyncDirection) => number
  readonly copySelection: (paths: ReadonlySet<string>, direction: SyncDirection) => Promise<void>
}

/**
 * “复制所选到另一侧”的唯一实现。此前 `SplitTree`（两处）与 `CompareTree`（一处）
 * 各有一份逐字重复的副本；状态栏的选择槽位需要第四份，于是提取成共享 hook。
 */
export function useSelectionSync(): SelectionSync {
  const { entries, leftSource, rightSource, compareSessionId, syncTask, setSyncTask } = useCompareStore(
    useShallow((state) => ({
      entries: state.entries,
      leftSource: state.leftSource,
      rightSource: state.rightSource,
      compareSessionId: state.compareSessionId,
      syncTask: state.syncTask,
      setSyncTask: state.setSyncTask,
    })),
  )

  const canQueue = useCallback(
    (direction: SyncDirection) => Boolean(compareSessionId) && canQueueSyncDirection(syncTask, leftSource, rightSource, direction),
    [compareSessionId, leftSource, rightSource, syncTask],
  )

  const countFor = useCallback(
    (paths: ReadonlySet<string>, direction: SyncDirection) =>
      collectSyncEntriesForSelection(entries, paths, direction).length,
    [entries],
  )

  const copySelection = useCallback(async (paths: ReadonlySet<string>, direction: SyncDirection) => {
    if (!leftSource || !rightSource) return
    if (!canQueueSyncDirection(syncTask, leftSource, rightSource, direction)) return

    const syncEntries = collectSyncEntriesForSelection(entries, paths, direction)
    if (syncEntries.length === 0) return
    if (!compareSessionId) return

    const request = {
      leftSource,
      rightSource,
      direction,
      compareId: compareSessionId,
      entries: syncEntries,
    }
    const prepared = await confirmSync(request)
    if (!prepared) return
    const response = await reportSyncResult(() => window.api.startSync(prepared))

    if (response.success) {
      if (useCompareStore.getState().compareSessionId === compareSessionId) useCompareStore.getState().markDirtyPaths(Array.from(paths))
      rememberSyncDirtyRoots(response.data?.id, getSyncRecompareRootsFromEntries(syncEntries))
      setSyncTask(response.data ?? null)
    }
  }, [compareSessionId, entries, leftSource, rightSource, setSyncTask, syncTask])

  return { canQueue, countFor, copySelection }
}
