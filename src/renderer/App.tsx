import { useWindowCloseGuard } from './hooks/useWindowCloseGuard'
import AppShell from './components/AppShell'
import ComparePage from './pages/ComparePage'
import TextComparePage from './pages/TextComparePage'
import { useAppStore } from './stores/app-store'
import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { applyDirtyPathsToSnapshot, sanitizePersistedCompareSessionSnapshot, useCompareStore } from './stores/compare-store'
import { bindCompareEvents } from './utils/compare-events'
import { applyOpenedLocalPaths } from './utils/open-paths'
import { findFolderDropTarget } from './utils/folder-drop'
import { refreshSyncedDirtyRoots, rememberSyncDirtyRoots, useCompareActions } from './hooks/useCompare'
import { shouldShowSyncTaskInCompare } from './utils/sync-task-visibility'
import { getSyncRecompareRootsFromItems } from './utils/sync-dirty'
import type { SyncTaskSnapshot } from '../../shared/types'
import { addRendererLog } from './stores/log-store'
import { applyCompareDefaults } from './utils/compare-defaults'
import { checkForUpdate } from './lib/updater'

const MAX_LIVE_LOCAL_WATCH_ENTRIES = 50_000

export default function App() {
  useWindowCloseGuard()
  const page = useAppStore((s) => s.page)
  const compareTabs = useAppStore((s) => s.compareTabs)
  const activeCompareTabId = useAppStore((s) => s.activeCompareTabId)
  const setPage = useAppStore((s) => s.setPage)
  const replaceDiffTabs = useAppStore((s) => s.replaceDiffTabs)
  const setActiveCompareTab = useAppStore((s) => s.setActiveCompareTab)
  const setSyncTask = useCompareStore((s) => s.setSyncTask)
  const hydrateSourceInputs = useCompareStore((s) => s.hydrateSourceInputs)
  const { liveLeftSource, liveRightSource, scanning, comparing, entryCount } = useCompareStore(useShallow((s) => ({
    liveLeftSource: s.leftSource,
    liveRightSource: s.rightSource,
    scanning: s.scanning,
    comparing: s.comparing,
    entryCount: s.entries.length,
  })))
  const restoredCompareTabsRef = useRef(false)
  const syncProgressTaskRef = useRef<SyncTaskSnapshot | null>(null)
  const { runCompare } = useCompareActions()

  useEffect(() => {
    void checkForUpdate()
  }, [])
  const activeCompareTab = useMemo(
    () => activeCompareTabId ? compareTabs.find((tab) => tab.id === activeCompareTabId) ?? null : null,
    [activeCompareTabId, compareTabs],
  )
  const watchTarget = useMemo(() => {
    if (!activeCompareTabId) {
      return null
    }

    if (page === 'compare') {
      return {
        sessionId: activeCompareTabId,
        leftSource: liveLeftSource,
        rightSource: liveRightSource,
        scanning,
        comparing,
        hasEntries: entryCount > 0,
        entryCount,
      }
    }

    const snapshot = activeCompareTab?.snapshot
    if (!snapshot) {
      return null
    }

    return {
      sessionId: activeCompareTabId,
      leftSource: snapshot.leftSource,
      rightSource: snapshot.rightSource,
      scanning: snapshot.scanning,
      comparing: snapshot.comparing,
      hasEntries: snapshot.entries.length > 0,
      entryCount: snapshot.entries.length,
    }
  }, [activeCompareTab, activeCompareTabId, comparing, entryCount, liveLeftSource, liveRightSource, page, scanning])

  useEffect(() => {
    if (restoredCompareTabsRef.current) return
    restoredCompareTabsRef.current = true

    const appState = useAppStore.getState()
    const targetCompareTab = appState.compareTabs.find((tab) => tab.id === appState.activeCompareTabId)
      ?? appState.compareTabs[appState.compareTabs.length - 1]

    // 全新工作区：没有任何可恢复的会话，此时（也只有此时）设置里的「对比默认值」生效。
    if (!targetCompareTab) {
      applyCompareDefaults()
      return
    }

    useCompareStore.getState().restoreSnapshot(
      sanitizePersistedCompareSessionSnapshot(targetCompareTab.snapshot),
    )
    replaceDiffTabs(targetCompareTab.diffTabs, targetCompareTab.activeDiffTabId)
    setActiveCompareTab(targetCompareTab.id)

    // 模式现在会被持久化：上次停在“文本对比”就留在文本对比，不要把用户拽回来。
    if (appState.page !== 'text') {
      setPage('compare')
    }
  }, [replaceDiffTabs, setActiveCompareTab, setPage])

  useEffect(() => {
    void (async () => {
      const response = await window.api.getSyncStatus()
      if (!response.success || !response.data) return
      syncProgressTaskRef.current = response.data
      setSyncTask(response.data)

      const state = useCompareStore.getState()
      if (!state.leftPath && !state.rightPath && !state.leftSource && !state.rightSource) {
        hydrateSourceInputs(response.data.leftSource, response.data.rightSource)
      }
    })()

    const unsubscribe = window.api.onSyncProgress((task) => {
      const previousTask = syncProgressTaskRef.current
      syncProgressTaskRef.current = task
      setSyncTask(task)

      // 同步任务被清空时后端会推送 null，此时只需清空本地状态
      if (!task) {
        return
      }

      const compareState = useCompareStore.getState()
      if (!shouldShowSyncTaskInCompare(task, compareState.leftSource, compareState.rightSource)) {
        return
      }

      const activeDirtyPaths = [task.currentPath, task.lastCompletedPath].filter((path): path is string => Boolean(path))
      if (activeDirtyPaths.length > 0) {
        compareState.markDirtyPaths(activeDirtyPaths)
      }

      const roots = getSyncRecompareRootsFromItems(task.items)
      if (roots.length > 0) {
        rememberSyncDirtyRoots(task.id, roots)
      }

      const becameCompleted = task.status === 'completed' && (previousTask?.id !== task.id || previousTask.status !== 'completed')
      if (becameCompleted) {
        void refreshSyncedDirtyRoots(task.id)
      }
    })

    return unsubscribe
  }, [hydrateSourceInputs, setSyncTask])

  useEffect(() => {
    return bindCompareEvents(window.api)
  }, [])

  useEffect(() => {
    if (typeof window.api.onCompareLocalDirty !== 'function') return

    return window.api.onCompareLocalDirty((sessionId, paths) => {
      if (paths.length === 0) {
        return
      }

      useAppStore.getState().updateCompareTabSnapshot(sessionId, (snapshot) =>
        applyDirtyPathsToSnapshot(snapshot, paths),
      )

      const appState = useAppStore.getState()
      if (appState.page === 'compare' && appState.activeCompareTabId === sessionId) {
        useCompareStore.getState().markDirtyPaths(paths)
      }
    })
  }, [])

  useEffect(() => {
    if (!watchTarget?.sessionId) {
      return
    }

    if (!watchTarget.leftSource || !watchTarget.rightSource || watchTarget.scanning || watchTarget.comparing || !watchTarget.hasEntries) {
      void window.api.stopLocalCompareWatch(watchTarget.sessionId)
      return
    }

    if (watchTarget.entryCount > MAX_LIVE_LOCAL_WATCH_ENTRIES) {
      addRendererLog(
        'compare-watch',
        'warn',
        `跳过本地实时监听 entries=${watchTarget.entryCount} limit=${MAX_LIVE_LOCAL_WATCH_ENTRIES}`,
      )
      void window.api.stopLocalCompareWatch(watchTarget.sessionId)
      return
    }

    void window.api.startLocalCompareWatch({
      sessionId: watchTarget.sessionId,
      left: watchTarget.leftSource,
      right: watchTarget.rightSource,
    })

    return () => {
      void window.api.stopLocalCompareWatch(watchTarget.sessionId)
    }
  }, [watchTarget])

  useEffect(() => {
    if (typeof window.api.onOpenPaths !== 'function') return
    return window.api.onOpenPaths((paths) => {
      applyOpenedLocalPaths(paths, { setPage, runCompare })
    })
  }, [runCompare, setPage])

  useEffect(() => {
    if (typeof window.api.onDirectoryDragDrop !== 'function') return
    return window.api.onDirectoryDragDrop((event) => {
      if (event.type !== 'drop' || event.paths.length === 0) return
      if (findFolderDropTarget({ x: event.x, y: event.y })) return
      applyOpenedLocalPaths(event.paths, { setPage, runCompare })
    })
  }, [runCompare, setPage])


  return (
    <AppShell>
      {page === 'compare' && <ComparePage />}
      {page === 'text' && <TextComparePage />}
    </AppShell>
  )
}
