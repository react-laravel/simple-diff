import type {
  CompareEntry,
  StartSyncRequest,
  SyncDirection,
  SyncPlanPreview,
  SyncTaskItemSnapshot,
  SyncTaskSnapshot,
} from '@shared/types'
import { mockLog, syncEmitter } from './mock-bus'
import { MOCK_LEFT_SOURCE, MOCK_RIGHT_SOURCE, MOCK_SYNC_FAILURE_PATH } from './mock-fixtures'
import { createMockCompareEntries } from './mock-tree'

/** 浏览器预览模式的同步任务状态机：逐项推进，覆盖完成 / 暂停 / 失败三种收尾。 */

const SYNC_TICK_MS = 1000
const plans = new Map<string, { request: StartSyncRequest; items: readonly SyncTaskItemSnapshot[] }>()
let resumePlan: { planId: string; taskId: string; updatedAt: number } | null = null

function preview(planId: string, items: readonly SyncTaskItemSnapshot[], direction: SyncDirection): SyncPlanPreview {
  const known = new Map(createMockCompareEntries().map((entry) => [entry.relativePath, entry]))
  return {
    planId,
    files: items.filter((item) => item.kind === 'file').length,
    directories: items.filter((item) => item.kind === 'directory').length,
    overwrites: items.filter((item) => item.kind === 'file' && (direction === 'left_to_right' ? known.get(item.relativePath)?.right : known.get(item.relativePath)?.left)).length,
  }
}

export function prepareMockSync(request: StartSyncRequest): SyncPlanPreview {
  const roots = request.entries.filter((entry) => (entry.state === 'different' && !entry.isDirectory)
    || entry.state === (request.direction === 'left_to_right' ? 'left_only' : 'right_only'))
  const known = createMockCompareEntries()
  const expanded = new Map<string, CompareEntry>()
  for (const entry of roots) {
    expanded.set(entry.relativePath, entry)
    if (entry.isDirectory) {
      for (const child of known) if (child.relativePath.startsWith(`${entry.relativePath}/`)) expanded.set(child.relativePath, child)
    }
  }
  const existing = new Set(syncTask?.status === 'running' && syncTask.direction === request.direction
    && JSON.stringify(syncTask.leftSource) === JSON.stringify(request.leftSource) && JSON.stringify(syncTask.rightSource) === JSON.stringify(request.rightSource)
    ? syncTask.items?.map((item) => item.relativePath) : [])
  const items = Array.from(expanded.values()).filter((entry) => !existing.has(entry.relativePath))
    .map((entry): SyncTaskItemSnapshot => ({ relativePath: entry.relativePath, kind: entry.isDirectory ? 'directory' : 'file', status: 'pending' }))
  const planId = `mock-plan-${crypto.randomUUID()}`
  plans.set(planId, { request, items })
  return preview(planId, items, request.direction)
}

export function prepareMockSyncResume(): SyncPlanPreview {
  if (!syncTask || (syncTask.status !== 'paused' && syncTask.status !== 'failed')) throw new Error('没有可继续的同步任务')
  const planId = `mock-resume-${crypto.randomUUID()}`
  resumePlan = { planId, taskId: syncTask.id, updatedAt: syncTask.updatedAt }
  return preview(planId, syncTask.items?.filter((item) => item.status !== 'completed') ?? [], syncTask.direction)
}

export function resumeMockSync(planId?: string): SyncTaskSnapshot | null {
  const plan = resumePlan
  resumePlan = null
  if (!syncTask || !plan || plan.planId !== planId || plan.taskId !== syncTask.id || plan.updatedAt !== syncTask.updatedAt) throw new Error('请先检查剩余同步范围并重新确认')
  return setMockSyncStatus('running')
}

function buildSyncItems(
  entries: readonly CompareEntry[],
  direction: SyncDirection,
): readonly SyncTaskItemSnapshot[] {
  const wanted = direction === 'left_to_right'
    ? new Set(['different', 'left_only'])
    : new Set(['different', 'right_only'])

  const candidates = entries.filter((entry) => wanted.has(entry.state))
  const source = candidates.length > 0
    ? candidates
    : createMockCompareEntries().filter((entry) => wanted.has(entry.state))

  return source
    .map((entry): SyncTaskItemSnapshot => ({
      relativePath: entry.relativePath,
      kind: entry.isDirectory ? 'directory' : 'file',
      status: 'pending',
    }))
    // 会失败的条目排在最后，前面的进度先正常推进
    .sort((left, right) =>
      Number(left.relativePath === MOCK_SYNC_FAILURE_PATH) - Number(right.relativePath === MOCK_SYNC_FAILURE_PATH))
}

/** 启动时就存在一个推进到一半的任务：状态栏与同步面板在预览里立刻有内容。 */
function createInitialSyncTask(): SyncTaskSnapshot {
  const items = buildSyncItems([], 'right_to_left').slice(0, 24).map((item, index): SyncTaskItemSnapshot => ({
    ...item,
    status: index < 9 ? 'completed' : index === 9 ? 'running' : 'pending',
  }))

  return {
    id: 'mock-sync-task',
    leftSource: MOCK_LEFT_SOURCE,
    rightSource: MOCK_RIGHT_SOURCE,
    direction: 'right_to_left',
    status: 'running',
    totalItems: items.length,
    completedItems: 9,
    currentPath: items[9]?.relativePath ?? null,
    lastCompletedPath: items[8]?.relativePath ?? null,
    lastError: null,
    createdAt: Date.now() - 30_000,
    updatedAt: Date.now(),
    items,
  }
}

let syncTask: SyncTaskSnapshot | null = createInitialSyncTask()
let syncTimer: ReturnType<typeof setTimeout> | null = null

export function getMockSyncTask(): SyncTaskSnapshot | null {
  return syncTask
}

function stopSyncTimer(): void {
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
}

export function scheduleMockSyncTick(): void {
  stopSyncTimer()
  if (!syncTask || syncTask.status !== 'running') return
  syncTimer = setTimeout(() => {
    syncTimer = null
    advanceSync()
  }, SYNC_TICK_MS)
}

function advanceSync(): void {
  const task = syncTask
  if (!task || task.status !== 'running') return

  const items = [...(task.items ?? [])]
  const nextIndex = items.findIndex((item) => item.status !== 'completed')
  const updatedAt = Date.now()

  if (nextIndex < 0) {
    syncTask = { ...task, status: 'completed', currentPath: null, updatedAt }
    syncEmitter.emit(syncTask)
    mockLog({ level: 'info', scope: 'sync', message: '[mock] 同步任务已完成' })
    return
  }

  const current = items[nextIndex]
  if (current.relativePath === MOCK_SYNC_FAILURE_PATH) {
    syncTask = {
      ...task,
      items,
      status: 'failed',
      currentPath: current.relativePath,
      lastError: `写入失败：${current.relativePath}（权限不足，示例错误）`,
      updatedAt,
    }
    syncEmitter.emit(syncTask)
    mockLog({ level: 'error', scope: 'sync', message: `[mock] 同步失败 path=${current.relativePath}` })
    return
  }

  items[nextIndex] = { ...current, status: 'completed' }
  const following = items[nextIndex + 1]
  if (following) items[nextIndex + 1] = { ...following, status: 'running' }
  const completedItems = items.filter((item) => item.status === 'completed').length

  syncTask = {
    ...task,
    items,
    completedItems,
    currentPath: following?.relativePath ?? null,
    lastCompletedPath: current.relativePath,
    status: completedItems >= task.totalItems ? 'completed' : 'running',
    updatedAt,
  }
  syncEmitter.emit(syncTask)
  scheduleMockSyncTick()
}

export function startMockSync(request: StartSyncRequest): SyncTaskSnapshot {
  const plan = request.planId ? plans.get(request.planId) : undefined
  if (request.planId) plans.delete(request.planId)
  const { planId: _planId, ...unconfirmedRequest } = request
  if (!plan || JSON.stringify(plan.request) !== JSON.stringify(unconfirmedRequest)) throw new Error('请先检查同步范围并确认覆盖数量')
  const items = plan.items
  const now = Date.now()

  if (syncTask?.status === 'running' && syncTask.direction === request.direction
    && JSON.stringify(syncTask.leftSource) === JSON.stringify(request.leftSource)
    && JSON.stringify(syncTask.rightSource) === JSON.stringify(request.rightSource)) {
    const allItems = [...(syncTask.items ?? []), ...items]
    syncTask = { ...syncTask, totalItems: allItems.length, items: allItems, updatedAt: now }
    syncEmitter.emit(syncTask)
    scheduleMockSyncTick()
    return syncTask
  }

  syncTask = {
    id: `mock-sync-${now.toString(36)}`,
    leftSource: request.leftSource,
    rightSource: request.rightSource,
    direction: request.direction,
    status: items.length === 0 ? 'completed' : 'running',
    totalItems: items.length,
    completedItems: 0,
    currentPath: items[0]?.relativePath ?? null,
    lastCompletedPath: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    items: items.map((item, index) => index === 0 ? { ...item, status: 'running' } : item),
  }

  mockLog({ level: 'info', scope: 'sync', message: `[mock] 开始同步 ${items.length} 项` })
  syncEmitter.emit(syncTask)
  scheduleMockSyncTick()
  return syncTask
}

export function setMockSyncStatus(status: SyncTaskSnapshot['status']): SyncTaskSnapshot | null {
  if (!syncTask) return null
  syncTask = { ...syncTask, status, updatedAt: Date.now() }
  syncEmitter.emit(syncTask)
  scheduleMockSyncTick()
  return syncTask
}

export function clearMockSync(): void {
  stopSyncTimer()
  syncTask = null
  syncEmitter.emit(null)
}
