import { reportSyncResult } from './sync-feedback'
import { confirmSync, confirmSyncResume } from './confirm-sync'
import { confirmUnsavedChanges, getAllDiffTabs, isDiffTabDirty } from './unsaved-changes'
import type { SyncDirection, SyncTaskSnapshot } from '../../../shared/types'
import { getRuntimeInfo } from '../runtime/runtime-info'
import { shouldShowSyncTaskInCompare } from './sync-task-visibility'
import { useAppStore, type DiffTab } from '../stores/app-store'
import { useCompareStore } from '../stores/compare-store'
import { useLogStore } from '../stores/log-store'
import { useSettingsStore, type ThemePreference } from '../stores/settings-store'
import { useSSHStore } from '../stores/ssh-store'
import { showToast } from '../stores/toast-store'
import { useUIStore } from '../stores/ui-store'
import { canQueueSyncDirection } from '../hooks/useSelectionSync'
import { rememberSyncDirtyRoots } from '../hooks/useCompare'
import { getSyncRecompareRootsFromEntries } from './sync-dirty'
import { formatComparePairLabel } from './source-label'

/**
 * chunk 9 的动作层：命令面板注册表（`hooks/useCommands.ts`）、全局快捷键
 * （`hooks/useGlobalShortcuts.ts`）、工具栏的 `⋯`（`useCompareOverflowItems`）和
 * 那两个作业 hook（`useCompareJob` / `useCompareSync`）调的是**同一批函数**。
 *
 * 为什么是模块函数而不是一个 hook：全局快捷键层挂在 `AppShell` 上，一旦它订阅
 * compare store，流式扫描期间每来一条 entry 整个壳层（状态栏、日志面板、叠加层宿主）
 * 都会重渲染。这里的每个函数都只在**被调用的那一刻**读 `getState()`，零订阅。
 *
 * DESIGN-SYSTEM §9 规则 1 要求「被降级的功能永远同时出现在命令面板里」。做到不漂移
 * 的唯一办法就是菜单项和命令项调用同一个实现——而不是各写一遍。
 */

// ---- compare job -----------------------------------------------------------

/** 至少要有一个比较依据，否则「不同」无从判断（工具栏按钮同款判断）。 */
export function hasCompareStrategies(): boolean {
  return useCompareStore.getState().strategies.length > 0
}

export function isCompareRunning(): boolean {
  const state = useCompareStore.getState()
  return state.scanning || state.comparing
}

// ---- compare view ----------------------------------------------------------

/**
 * 交换左右数据源。结果随即作废，等用户自己按「首次对比」——从菜单里悄悄重跑一次
 * 可能很贵的作业，正是这次重设计要消灭的那类惊吓。
 */
export async function swapCompareSources(): Promise<void> {
  if (useAppStore.getState().diffTabs.some(isDiffTabDirty) && !await confirmUnsavedChanges()) return
  const state = useCompareStore.getState()
  const previous = {
    type: state.leftSourceType,
    path: state.leftPath,
    configId: state.leftSSHConfigId,
  }

  state.setLeftSourceType(state.rightSourceType)
  state.setLeftPath(state.rightPath)
  state.setLeftSSHConfigId(state.rightSSHConfigId)
  state.setRightSourceType(previous.type)
  state.setRightPath(previous.path)
  state.setRightSSHConfigId(previous.configId)

  state.invalidateCompareResult()
  useUIStore.getState().clearTreeSelection()
  // 已打开的文件差异标签此刻指向的是交换前的两侧，必须一起收掉。
  useAppStore.getState().clearDiffTabs()
}

export async function copyComparePathPair(): Promise<void> {
  const { leftSource, rightSource, leftPath, rightPath } = useCompareStore.getState()
  const configs = useSSHStore.getState().configs
  const label = formatComparePairLabel(leftSource, rightSource, configs) ?? `${leftPath} ↔ ${rightPath}`

  try {
    if (!navigator.clipboard) throw new Error('剪贴板不可用')
    await navigator.clipboard.writeText(label)
    showToast({ tone: 'success', message: '已复制路径对' })
  } catch {
    showToast({ tone: 'error', message: '复制失败', description: '剪贴板不可用' })
  }
}

/**
 * 「复制路径」：diff 标签右键菜单（蓝图 §2.2）和 Diff 路径头上的复制按钮共用。
 * 成功与失败的说法只写一遍，两个入口不会各说各话。
 */
export async function copyPathToClipboard(path: string): Promise<void> {
  if (!path) return

  try {
    if (!navigator.clipboard) throw new Error('剪贴板不可用')
    await navigator.clipboard.writeText(path)
    showToast({ tone: 'success', message: '已复制路径', description: path })
  } catch {
    showToast({ tone: 'error', message: '复制失败', description: '剪贴板不可用' })
  }
}

export function areAllDirsExpanded(): boolean {
  const state = useCompareStore.getState()
  const allDirCount = state.entrySummary.allDirCount
  return allDirCount > 0 && state.expandedDirs.size >= allDirCount
}

export function toggleExpandAllDirs(): void {
  const state = useCompareStore.getState()
  if (areAllDirsExpanded()) state.collapseAll()
  else state.expandAll()
}

export function toggleCompareViewMode(): void {
  const state = useCompareStore.getState()
  state.setViewMode(state.viewMode === 'split' ? 'merged' : 'split')
}

export function toggleHideDotFiles(): void {
  const state = useCompareStore.getState()
  state.setHideDot(!state.hideDot)
}

// ---- sync ------------------------------------------------------------------

export function canStartCompareSync(): boolean {
  const { done, scanning, comparing, entrySummary, compareSessionId } = useCompareStore.getState()
  return Boolean(compareSessionId) && done && !scanning && !comparing && entrySummary.pendingCount === 0 && entrySummary.stats.total > 0
}

/** 队列是全局单例：能否入队要看真实的 `syncTask`，而不是本标签可见的那份。 */
export function canQueueCompareSync(direction: SyncDirection): boolean {
  const { syncTask, leftSource, rightSource } = useCompareStore.getState()
  return canQueueSyncDirection(syncTask, leftSource, rightSource, direction)
}

export async function startCompareSync(direction: SyncDirection): Promise<void> {
  const state = useCompareStore.getState()
  const { leftSource, rightSource, compareSessionId, entries } = state

  if (!leftSource || !rightSource || !compareSessionId) return
  if (!canStartCompareSync() || entries.length === 0) return

  const request = {
    compareId: compareSessionId,
    leftSource,
    rightSource,
    direction,
    entries,
  }
  const prepared = await confirmSync(request)
  if (!prepared) return
  const response = await reportSyncResult(() => window.api.startSync(prepared))

  if (!response.success) return

  const roots = getSyncRecompareRootsFromEntries(entries)
  if (useCompareStore.getState().compareSessionId === compareSessionId) useCompareStore.getState().markDirtyPaths(roots)
  rememberSyncDirtyRoots(response.data?.id, roots)
  useCompareStore.getState().setSyncTask(response.data ?? null)
}

/** 只有当队列里那个任务的数据源和当前标签一致时，它才是「本视图的作业」（F7）。 */
export function getVisibleSyncTask(): SyncTaskSnapshot | null {
  if (!getRuntimeInfo().supportsSync) return null
  const { syncTask, leftSource, rightSource } = useCompareStore.getState()
  return shouldShowSyncTaskInCompare(syncTask, leftSource, rightSource) ? syncTask : null
}

export async function pauseCompareSync(): Promise<void> {
  const response = await reportSyncResult(() => window.api.pauseSync())
  if (response.success) useCompareStore.getState().setSyncTask(response.data ?? null)
}

export async function resumeCompareSync(): Promise<void> {
  const task = useCompareStore.getState().syncTask
  if (!task || (task.status !== 'paused' && task.status !== 'failed')) return
  const planId = await confirmSyncResume(task)
  if (!planId) return
  const response = await reportSyncResult(() => window.api.resumeSync(planId))
  if (response.success) useCompareStore.getState().setSyncTask(response.data ?? null)
}

export async function clearCompareSync(): Promise<void> {
  const response = await reportSyncResult(() => window.api.clearSync())
  if (response.success) useCompareStore.getState().setSyncTask(null)
}

// ---- file diff -------------------------------------------------------------

export function isDiffTabSideDirty(tab: DiffTab, side: 'left' | 'right'): boolean {
  return side === 'left'
    ? tab.leftContent !== tab.originalLeftContent
    : tab.rightContent !== tab.originalRightContent
}

/**
 * 保存文件差异标签的一侧。`FileDiffView` 的保存按钮和 `⌘K` 的「保存左侧/右侧」
 * 走的是这一个实现。
 */
const pendingSaves = new Set<string>()

export async function saveDiffTabSide(tab: DiffTab, side: 'left' | 'right'): Promise<boolean> {
  const source = side === 'left' ? tab.leftSource : tab.rightSource
  const fullPath = side === 'left' ? tab.leftFullPath : tab.rightFullPath
  const content = side === 'left' ? tab.leftContent : tab.rightContent

  if (!source) return false

  const key = `${tab.sessionId}:${side}`
  if (pendingSaves.has(key)) return false
  pendingSaves.add(key)
  useAppStore.getState().updateDiffTabSession(tab.sessionId, side === 'left' ? { savingLeft: true } : { savingRight: true })
  try {
    const result = await window.api.writeText(source, fullPath, content, { content: side === 'left' ? tab.originalLeftContent : tab.originalRightContent, exists: side === 'left' ? tab.hasLeftFile : tab.hasRightFile }).catch((error: unknown) => ({
      success: false, error: error instanceof Error ? error.message : String(error),
    }))
    // 写盘期间标签可能已经被关掉或重开（`sessionId` 会变），此时不能再写回内容。
    if (!getAllDiffTabs().some((current) => current.sessionId === tab.sessionId)) return false

    if (result.success) {
      useAppStore.getState().updateDiffTabSession(tab.sessionId, side === 'left'
        ? { originalLeftContent: content, hasLeftFile: true }
        : { originalRightContent: content, hasRightFile: true })
      showToast({
        tone: 'success',
        message: side === 'left' ? '已保存左侧' : '已保存右侧',
        description: tab.fileName,
      })
      return true
    }

    showToast({ tone: 'error', message: '保存失败', description: result.error ?? '未知错误' })
    return false
  } finally {
    pendingSaves.delete(key)
    useAppStore.getState().updateDiffTabSession(tab.sessionId, side === 'left' ? { savingLeft: false } : { savingRight: false })
  }
}

/**
 * 关闭文件差异标签的**唯一**入口。标签条的 `×`、右键菜单的「关闭其他 / 关闭全部」、
 * `⌘W` 和 `⌘K` 的关闭命令都走这里，所以「有未保存修改就先问一句」不可能被绕过。
 *
 * 干净的标签直接关；脏标签把待办交给 `ui-store`，由 `DiffTabCloseConfirm`
 * （挂在 `OverlayHost` 里）弹一个 `ConfirmDialog`——旧代码这里是 `window.confirm`。
 */
export function requestCloseDiffTabs(ids: readonly string[]): void {
  const { diffTabs } = useAppStore.getState()
  const targets = ids.filter((id) => diffTabs.some((tab) => tab.id === id))
  if (targets.length === 0) return

  const hasUnsaved = targets.some((id) => {
    const tab = diffTabs.find((candidate) => candidate.id === id)
    return tab !== undefined && (isDiffTabSideDirty(tab, 'left') || isDiffTabSideDirty(tab, 'right'))
  })

  if (!hasUnsaved) {
    closeDiffTabs(targets)
    return
  }

  useUIStore.getState().setPendingDiffTabClose(targets)
}

/** 无条件关闭，确认之后由对话框调用。 */
export function closeDiffTabs(ids: readonly string[]): void {
  const closeDiffTab = useAppStore.getState().closeDiffTab
  for (const id of ids) closeDiffTab(id)
}

/** `⌘W`。没有打开的文件差异标签时什么也不做（关闭对比标签是 `⇧⌘W`）。 */
export function requestCloseActiveDiffTab(): void {
  const { activeDiffTabId } = useAppStore.getState()
  if (activeDiffTabId) requestCloseDiffTabs([activeDiffTabId])
}

/** `⌘0`：回到目录树。文件差异标签全部保留，只是不再占着内容区。 */
export function showCompareTree(): void {
  useAppStore.getState().setActiveDiffTab(null)
}

/**
 * `⌘F` 与 `⌘K` 的「会话过滤规则…」共用的动作。
 *
 * 过滤弹层住在 `CompareToolbar` 里，而工具栏在打开文件差异时不渲染——只写
 * `filterPopoverOpen` 的话，在文件差异态按 `⌘F` 表面上毫无反应，等用户自己切回
 * 目录树时才莫名其妙弹出来。所以先回到目录树，再打开弹层：两处入口都不会变成死键。
 */
export function openSessionFilterPopover(): void {
  showCompareTree()
  useUIStore.getState().setFilterPopoverOpen(true)
}

/**
 * `⌥←` / `⌥→` / `⌃⇥`：在「目录树 + 已打开的文件差异标签」之间循环。
 * 目录树是这一圈里的第 0 站，所以 `⌥←`/`⌥→` 一定能回到它。
 */
export function cycleDiffTab(delta: number): void {
  const { diffTabs, activeDiffTabId, setActiveDiffTab } = useAppStore.getState()
  if (diffTabs.length === 0) return

  const stops: readonly (string | null)[] = [null, ...diffTabs.map((tab) => tab.id)]
  const current = stops.indexOf(activeDiffTabId)
  const next = (current + delta + stops.length) % stops.length
  setActiveDiffTab(stops[next])
}

export function getActiveDiffTab(): DiffTab | null {
  const { diffTabs, activeDiffTabId } = useAppStore.getState()
  if (!activeDiffTabId) return null
  return diffTabs.find((tab) => tab.id === activeDiffTabId) ?? null
}

export async function saveActiveDiffTabSide(side: 'left' | 'right'): Promise<void> {
  const tab = getActiveDiffTab()
  if (!tab) return
  await saveDiffTabSide(tab, side)
}

// ---- shell -----------------------------------------------------------------

export function toggleLogPanel(): void {
  useLogStore.getState().toggleVisible()
}

export function clearLogPanel(): void {
  useLogStore.getState().clear()
}

export function setThemePreference(theme: ThemePreference): void {
  useSettingsStore.getState().setTheme(theme)
}

/** `⌘K → 切换主题`：三态循环，`system` 不会像旧顶栏按钮那样被抹掉（F10）。 */
export function cycleThemePreference(): void {
  const order: readonly ThemePreference[] = ['system', 'light', 'dark']
  const current = useSettingsStore.getState().theme
  const next = order[(order.indexOf(current) + 1) % order.length]
  setThemePreference(next)
}
