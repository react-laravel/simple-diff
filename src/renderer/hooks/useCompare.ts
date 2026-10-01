import { confirmUnsavedChanges, isDiffTabDirty } from '../utils/unsaved-changes'
import { useUIStore } from '../stores/ui-store'
import { useCallback } from 'react'
import { mergePathFilters } from '@shared/path-filter'
import {
  applyCompareErrorToSnapshot,
  applyFinishCompareToSnapshot,
  applyPauseCompareToSnapshot,
  applyPausedCompareErrorToSnapshot,
  createLightweightCompareSessionSnapshot,
  hasCompareSessionContent,
  type CompareSessionSnapshot,
  useCompareStore,
} from '../stores/compare-store'
import { useAppStore, type CompareTab } from '../stores/app-store'
import { useSettingsStore } from '../stores/settings-store'
import { useSSHStore } from '../stores/ssh-store'
import type { CompareResult, SourceConfig } from '../../../shared/types'
import { addRendererLog } from '../stores/log-store'
import { flushBufferedCompareEvents } from '../utils/compare-events'
import { formatCompareTabTitleFromSources } from '../utils/source-label'
import { getDirtyRecompareRoots, minimizeSyncRecompareRoots } from '../utils/sync-dirty'
import { formatRendererMemoryUsage } from '../utils/renderer-memory'

let startSequence = 0

function buildSourceConfig(type: 'local' | 'sftp', path: string, sshConfigId: string): SourceConfig {
  if (type === 'sftp') {
    return { type: 'sftp', configId: sshConfigId, path }
  }
  return { type: 'local', path }
}

function createCompareId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${Date.now()}-${crypto.randomUUID()}`
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createCompareSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

function formatCompareTabTitle(leftSource: SourceConfig, rightSource: SourceConfig): string {
  return formatCompareTabTitleFromSources(leftSource, rightSource, useSSHStore.getState().configs)
}

function createControlSnapshot() {
  return useCompareStore.getState().createLightweightSnapshot()
}

export function formatCompareErrorForUi(rawError: string): string {
  const message = rawError.trim()
  if (!message) {
    return '对比失败'
  }

  const isMissingPathError = /ENOENT|no such file or directory/i.test(message)
  const isListDirError = /无法列出目录|scandir/i.test(message)
  if (!isMissingPathError || !isListDirError) {
    return message
  }

  const side = /\[(left|right)\]/i.exec(message)?.[1]?.toLowerCase()
  const sideLabel = side === 'left' ? '左侧' : side === 'right' ? '右侧' : '所选'
  const path = /scandir\s+['"]([^'"]+)['"]/i.exec(message)?.[1]
  const target = path ?? '目录'

  return `${sideLabel}目录不可访问：${target}。可能是硬盘未插入、未挂载，或路径已变更。`
}

interface RunCompareOptions {
  readonly reuseActiveSession?: boolean
  readonly navigateToCompare?: boolean
  readonly preserveEntries?: boolean
}

const pauseRequestedCompareIds = new Set<string>()
const syncDirtyRootsByTaskId = new Map<string, readonly string[]>()

export function resolveReusableCompareId(
  currentSnapshot: CompareSessionSnapshot,
  activeCompareTab?: CompareTab,
): string | null {
  if (currentSnapshot.activeCompareId && (currentSnapshot.scanning || currentSnapshot.comparing)) {
    return currentSnapshot.activeCompareId
  }

  const activeTabSnapshot = activeCompareTab?.snapshot
  if (activeTabSnapshot?.activeCompareId && (activeTabSnapshot.scanning || activeTabSnapshot.comparing)) {
    return activeTabSnapshot.activeCompareId
  }

  return null
}

export function createRunningCompareTabSnapshot(snapshot: CompareSessionSnapshot): CompareSessionSnapshot {
  if (!snapshot.activeCompareId || (!snapshot.scanning && !snapshot.comparing)) {
    return snapshot
  }

  return createLightweightCompareSessionSnapshot(snapshot)
}

function syncCurrentCompareTabSnapshot(compareTabId: string, options?: { readonly lightweight?: boolean }): void {
  const appStore = useAppStore.getState()
  const compareTab = appStore.compareTabs.find((tab) => tab.id === compareTabId)
  if (!compareTab) {
    return
  }

  const compareState = useCompareStore.getState()
  appStore.saveCompareTab({
    id: compareTabId,
    title: compareTab.title,
    snapshot: options?.lightweight ? compareState.createLightweightSnapshot() : compareState.createTabSnapshot(),
    diffTabs: appStore.diffTabs,
    activeDiffTabId: appStore.activeDiffTabId,
  })
}

type CompareRunOutcome =
  | { readonly kind: 'success'; readonly result: CompareResult }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * 统一写入 runCompare 的终态：活动 store 与后台 tab snapshot 共用一条路径，
 * 避免 success / cancel / error 三套几乎相同的分支漂移。
 *
 * 注：原先 error 分支里有一段 `activeCompareId === compareId` 的 else-if，
 * 与外层 `!==` 条件互斥，永远不可达，已删除。
 */
function settleCompareRun(compareId: string, compareTabId: string, outcome: CompareRunOutcome): void {
  const pauseRequested = pauseRequestedCompareIds.delete(compareId)
  flushBufferedCompareEvents(compareId)

  const isActive = useCompareStore.getState().activeCompareId === compareId

  if (outcome.kind === 'success') {
    addRendererLog(
      'compare',
      'info',
      `compare:run 返回成功 compareId=${compareId} total=${outcome.result.stats.total} duration=${outcome.result.duration}ms`,
    )

    if (isActive) {
      addRendererLog(
        'compare',
        'info',
        `compare:完成前 entries=${useCompareStore.getState().entries.length} ${formatRendererMemoryUsage()}`,
      )
      useCompareStore.getState().finishCompare(compareId, outcome.result)
      addRendererLog(
        'compare',
        'info',
        `compare:完成后 entries=${useCompareStore.getState().entries.length} tabSnapshot=lightweight ${formatRendererMemoryUsage()}`,
      )
      syncCurrentCompareTabSnapshot(compareTabId, { lightweight: true })
      return
    }

    addRendererLog(
      'compare',
      'info',
      `compare:run 成功结果未写入当前活动 store，activeCompareId=${useCompareStore.getState().activeCompareId ?? '-'} compareId=${compareId}`,
    )
    useAppStore.getState().updateCompareTabSnapshot(compareTabId, (snapshot) =>
      applyFinishCompareToSnapshot(snapshot, compareId, outcome.result),
    )
    return
  }

  if (outcome.kind === 'cancelled') {
    addRendererLog('compare', 'warn', `compare:run 被取消 compareId=${compareId}`)

    if (isActive) {
      if (pauseRequested) {
        useCompareStore.getState().pauseCompare(compareId)
      } else {
        useCompareStore.getState().setError(null, compareId)
      }
      syncCurrentCompareTabSnapshot(compareTabId)
      return
    }

    addRendererLog(
      'compare',
      'info',
      `compare:run 取消结果未写入当前活动 store，activeCompareId=${useCompareStore.getState().activeCompareId ?? '-'} compareId=${compareId}`,
    )
    useAppStore.getState().updateCompareTabSnapshot(compareTabId, (snapshot) =>
      pauseRequested
        ? applyPauseCompareToSnapshot(snapshot, compareId)
        : applyCompareErrorToSnapshot(snapshot, compareId, null),
    )
    return
  }

  addRendererLog('compare', 'error', `compare:run 失败 compareId=${compareId} error=${outcome.message}`)

  if (isActive) {
    useCompareStore.getState().setError(outcome.message, compareId)
    syncCurrentCompareTabSnapshot(compareTabId)
    return
  }

  addRendererLog(
    'compare',
    'info',
    `compare:run 失败结果未写入当前活动 store，activeCompareId=${useCompareStore.getState().activeCompareId ?? '-'} compareId=${compareId}`,
  )
  useAppStore.getState().updateCompareTabSnapshot(compareTabId, (snapshot) =>
    pauseRequested
      ? applyPausedCompareErrorToSnapshot(snapshot, compareId, outcome.message)
      : applyCompareErrorToSnapshot(snapshot, compareId, outcome.message),
  )
}

export function rememberSyncDirtyRoots(syncTaskId: string | undefined, roots: readonly string[]): void {
  if (!syncTaskId || roots.length === 0) {
    return
  }

  const previousRoots = syncDirtyRootsByTaskId.get(syncTaskId) ?? []
  syncDirtyRootsByTaskId.set(syncTaskId, minimizeSyncRecompareRoots([...previousRoots, ...roots]))
}

export async function refreshSyncedDirtyRoots(syncTaskId: string | undefined): Promise<boolean> {
  if (!syncTaskId) {
    return false
  }

  const roots = syncDirtyRootsByTaskId.get(syncTaskId)
  if (!roots || roots.length === 0) {
    return false
  }

  syncDirtyRootsByTaskId.delete(syncTaskId)
  return runPartialCompareForRoots(roots)
}

async function runPartialCompareForRoots(relativeRoots: readonly string[]): Promise<boolean> {
  const compareState = useCompareStore.getState()
  const activeCompareTabId = useAppStore.getState().activeCompareTabId
  const globalPathFilters = useSettingsStore.getState().globalPathFilters
  const effectiveRelativeRoots = minimizeSyncRecompareRoots(relativeRoots)

  if (!activeCompareTabId || !compareState.leftSource || !compareState.rightSource) {
    return false
  }

  if (effectiveRelativeRoots.length === 0) {
    return false
  }

  const effectivePathFilters = mergePathFilters(globalPathFilters, compareState.extensionFilter)

  addRendererLog('compare', 'info', `开始局部重比对 roots=${effectiveRelativeRoots.join('、') || '.'}`)
  const response = await window.api.runPartialCompare({
    compareId: compareState.compareSessionId ?? undefined,
    left: compareState.leftSource,
    right: compareState.rightSource,
    strategies: [...compareState.strategies],
    extensionFilter: effectivePathFilters.length > 0 ? effectivePathFilters : undefined,
    relativeRoots: effectiveRelativeRoots,
  })

  if (useAppStore.getState().activeCompareTabId !== activeCompareTabId
    || useCompareStore.getState().compareSessionId !== compareState.compareSessionId) {
    // Keep the original session dirty; its next rescan will use current inputs.
    return false
  }
  if (!response.success || !response.data) {
    const message = formatCompareErrorForUi(response.error ?? '局部重比对失败')
    addRendererLog('compare', 'error', `局部重比对失败 error=${message}`)
    useCompareStore.getState().setError(message)
    return false
  }

  useCompareStore.getState().applyPartialCompareResult(effectiveRelativeRoots, response.data.entries)
  syncCurrentCompareTabSnapshot(activeCompareTabId)
  addRendererLog('compare', 'info', `局部重比对完成 roots=${effectiveRelativeRoots.join('、') || '.'} total=${response.data.stats.total}`)
  return true
}

export function useCompareActions() {
  const runCompare = useCallback(async (options?: RunCompareOptions) => {
    const sequence = ++startSequence
    if (options?.reuseActiveSession && useAppStore.getState().diffTabs.some(isDiffTabDirty)) {
      const sessionId = useAppStore.getState().activeCompareTabId
      if (!await confirmUnsavedChanges() || sessionId !== useAppStore.getState().activeCompareTabId) return
    }
    const compareState = useCompareStore.getState()
    const {
      leftPath: currentLeftPath,
      rightPath: currentRightPath,
      strategies: currentStrategies,
      extensionFilter: currentExtensionFilter,
      leftSourceType: currentLeftSourceType,
      rightSourceType: currentRightSourceType,
      leftSSHConfigId: currentLeftSSHConfigId,
      rightSSHConfigId: currentRightSSHConfigId,
    } = compareState

    if (!currentLeftPath || !currentRightPath) {
      compareState.setError('请选择左右两侧目录')
      return
    }

    const appStore = useAppStore.getState()
    const currentSnapshot = compareState.createLightweightSnapshot()
    const activeCompareTabId = appStore.activeCompareTabId
    const currentCompareTab = activeCompareTabId
      ? appStore.compareTabs.find((tab) => tab.id === activeCompareTabId)
      : undefined
    const reuseActiveSession = options?.reuseActiveSession === true && activeCompareTabId !== null
    const preserveEntries = options?.preserveEntries ?? reuseActiveSession
    const compareIdToCancel = reuseActiveSession
      ? resolveReusableCompareId(currentSnapshot, currentCompareTab)
      : null
    const globalPathFilters = useSettingsStore.getState().globalPathFilters
    const effectivePathFilters = mergePathFilters(globalPathFilters, currentExtensionFilter)
    const currentLeftSource = buildSourceConfig(currentLeftSourceType, currentLeftPath, currentLeftSSHConfigId)
    const currentRightSource = buildSourceConfig(currentRightSourceType, currentRightPath, currentRightSSHConfigId)

    if (!reuseActiveSession && activeCompareTabId && hasCompareSessionContent(currentSnapshot)) {
      appStore.saveCompareTab({
        id: activeCompareTabId,
        title: currentCompareTab?.title ?? formatCompareTabTitle(currentLeftSource, currentRightSource),
        snapshot: compareState.createTabSnapshot(),
        diffTabs: appStore.diffTabs,
        activeDiffTabId: appStore.activeDiffTabId,
      })
    }

    const compareId = createCompareId()
    const compareTabId = reuseActiveSession ? activeCompareTabId : createCompareSessionId()

    const left = currentLeftSource
    const right = currentRightSource

    if (compareIdToCancel) {
      addRendererLog('compare', 'info', `准备取消旧对比 compareId=${compareIdToCancel}`)
      await window.api.cancelCompare(compareIdToCancel)
    }

    if (sequence !== startSequence || useAppStore.getState().activeCompareTabId !== activeCompareTabId) return
    useUIStore.getState().clearTreeSelection()
    appStore.replaceDiffTabs([], null)
    appStore.setActiveCompareTab(compareTabId)

    // Start scanning — navigate immediately
    compareState.startScanning(compareId, { preserveEntries })
    compareState.setSources(left, right)

    addRendererLog(
      'compare',
      'info',
      `发起对比 compareId=${compareId} tabId=${compareTabId} left=${left.type}:${left.path} right=${right.type}:${right.path} strategies=${currentStrategies.join(',')}`,
    )

    appStore.saveCompareTab({
      id: compareTabId,
      title: formatCompareTabTitle(left, right),
      snapshot: createRunningCompareTabSnapshot(useCompareStore.getState().createLightweightSnapshot()),
      diffTabs: [],
      activeDiffTabId: null,
    })

    if (options?.navigateToCompare !== false) {
      useAppStore.getState().setPage('compare')
    }

    try {
      addRendererLog('compare', 'info', `调用主进程 compare:run compareId=${compareId}`)
      const response = await window.api.runCompare({
        compareId,
        left,
        right,
        strategies: [...currentStrategies],
        extensionFilter: effectivePathFilters.length > 0 ? effectivePathFilters : undefined,
      })

      if (response.success && response.data) {
        settleCompareRun(compareId, compareTabId, { kind: 'success', result: response.data })
      } else if (response.error === '对比已取消') {
        settleCompareRun(compareId, compareTabId, { kind: 'cancelled' })
      } else {
        settleCompareRun(compareId, compareTabId, {
          kind: 'error',
          message: formatCompareErrorForUi(response.error ?? '对比失败'),
        })
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '对比失败'
      settleCompareRun(compareId, compareTabId, {
        kind: 'error',
        message: formatCompareErrorForUi(rawMessage),
      })
    }
  }, [])

  const rerunActiveSessionIfRunning = useCallback(async () => {
    const appStore = useAppStore.getState()
    const activeCompareTab = appStore.activeCompareTabId
      ? appStore.compareTabs.find((tab) => tab.id === appStore.activeCompareTabId)
      : undefined

    if (!activeCompareTab) {
      return false
    }

    const currentSnapshot = createControlSnapshot()
    if (!resolveReusableCompareId(currentSnapshot, activeCompareTab)) {
      return false
    }

    await runCompare({ reuseActiveSession: true, navigateToCompare: false })
    return true
  }, [runCompare])

  const pauseCompare = useCallback(async () => {
    const compareState = useCompareStore.getState()
    const appStore = useAppStore.getState()
    const activeCompareTab = appStore.activeCompareTabId
      ? appStore.compareTabs.find((tab) => tab.id === appStore.activeCompareTabId)
      : undefined
    const compareId = resolveReusableCompareId(compareState.createLightweightSnapshot(), activeCompareTab)

    if (!compareId) {
      return false
    }

    pauseRequestedCompareIds.add(compareId)
    addRendererLog('compare', 'info', `准备暂停对比 compareId=${compareId}`)
    const response = await window.api.cancelCompare(compareId)
    if (!response.success && response.error !== '对比已取消') {
      pauseRequestedCompareIds.delete(compareId)
      addRendererLog('compare', 'error', `暂停对比失败 compareId=${compareId} error=${response.error ?? '未知错误'}`)
      return false
    }

    useCompareStore.getState().pauseCompare(compareId)
    useAppStore.getState().updateCompareTabSnapshotByCompareId(compareId, (snapshot) =>
      applyPauseCompareToSnapshot(snapshot, compareId),
    )
    return true
  }, [])

  const resumeCompare = useCallback(async () => {
    const hasActiveCompareTab = useAppStore.getState().activeCompareTabId !== null
    await runCompare({
      reuseActiveSession: hasActiveCompareTab,
      navigateToCompare: false,
      preserveEntries: true,
    })
  }, [runCompare])

  const restartCompare = useCallback(async () => {
    const hasActiveCompareTab = useAppStore.getState().activeCompareTabId !== null
    await runCompare({
      reuseActiveSession: hasActiveCompareTab,
      navigateToCompare: false,
      preserveEntries: false,
    })
  }, [runCompare])

  const recompareDirtyPaths = useCallback(async () => {
    const compareState = useCompareStore.getState()
    const relativeRoots = getDirtyRecompareRoots(compareState.dirtyPaths)
    return runPartialCompareForRoots(relativeRoots)
  }, [])

  return {
    runCompare,
    rerunActiveSessionIfRunning,
    pauseCompare,
    resumeCompare,
    restartCompare,
    recompareDirtyPaths,
  }
}
