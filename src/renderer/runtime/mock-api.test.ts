import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppAPI } from '@shared/app-api'
import type { CompareEntry, SourceConfig } from '@shared/types'
import { createMockApi } from './mock-api'
import {
  MOCK_LEFT_ROOT,
  MOCK_LEFT_SOURCE,
  MOCK_RIGHT_ROOT,
  MOCK_RIGHT_SOURCE,
  MOCK_SYNC_FAILURE_PATH,
} from './mock-fixtures'
import { createMockCompareEntries } from './mock-tree'

const APP_API_MEMBERS: readonly (keyof AppAPI)[] = [
  'runtime', 'listFiles', 'readText', 'writeText', 'runCompare', 'runPartialCompare',
  'cancelCompare', 'startLocalCompareWatch', 'stopLocalCompareWatch', 'prepareSync', 'prepareSyncResume', 'startSync',
  'pauseSync', 'resumeSync', 'getSyncStatus', 'clearSync', 'onScanComplete',
  'onEntryUpdate', 'onCompareLocalDirty', 'onSyncProgress', 'onLog', 'writeLog',
  'textDiff', 'listSSHConfigs', 'saveSSHConfig', 'deleteSSHConfig', 'testSSHConnection',
  'browseSSH', 'listHistory', 'clearHistory', 'deleteHistory', 'showInFolder',
  'renameFile', 'deleteFile', 'selectFolder', 'selectFile', 'onOpenPaths', 'onDirectoryDragDrop', 'getPathForFile',
]

function compareRequest(compareId: string) {
  return {
    compareId,
    left: MOCK_LEFT_SOURCE,
    right: MOCK_RIGHT_SOURCE,
    strategies: ['size', 'mtime'] as const,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('mock-api 契约', () => {
  it('实现 AppAPI 的全部成员', () => {
    const api = createMockApi()
    for (const member of APP_API_MEMBERS) {
      expect(api[member], `缺少成员 ${member}`).toBeDefined()
    }
  })

  it('runtime 声明为 web 模式并保留 sftp / history / sync 能力', () => {
    expect(createMockApi().runtime).toEqual({
      mode: 'web',
      supportsSftp: true,
      supportsHistory: true,
      supportsSync: true,
      supportsNativeFolderSelection: false,
      supportsDirectoryDragDrop: false,
      supportsWriteBack: true,
    })
  })
})

describe('mock 固定数据', () => {
  const entries = createMockCompareEntries()

  it('覆盖全部 7 个筛选桶', () => {
    const states = new Set(entries.map((entry) => entry.state))
    expect(states).toEqual(new Set(['equal', 'different', 'left_only', 'right_only', 'pending']))
    expect(entries.filter((entry) => entry.state !== 'left_only' && entry.state !== 'right_only').length)
      .toBeGreaterThan(0)
    expect(entries.length).toBeGreaterThanOrEqual(100)
  })

  it('至少嵌套三层目录，且单侧条目只带一侧文件信息', () => {
    expect(entries.some((entry) => entry.relativePath.split('/').length >= 3)).toBe(true)

    const leftOnly = entries.find((entry) => entry.state === 'left_only')
    expect(leftOnly?.left).toBeDefined()
    expect(leftOnly?.right).toBeUndefined()

    const rightOnly = entries.find((entry) => entry.state === 'right_only')
    expect(rightOnly?.left).toBeUndefined()
    expect(rightOnly?.right).toBeDefined()
  })

  it('different 条目带有差异原因', () => {
    const different = entries.filter((entry) => entry.state === 'different' && !entry.isDirectory)
    expect(different.length).toBeGreaterThan(0)
    expect(different.every((entry) => entry.reasons.length > 0)).toBe(true)
  })

  it('honors selected strategies and collects reasons in the selected order', () => {
    const changed = createMockCompareEntries(['mtime', 'size', 'hash']).find((entry) => entry.state === 'different' && !entry.isDirectory)
    expect(changed?.reasons.map((reason) => reason.type)).toEqual(['mtime', 'size', 'hash'])
    const sizeOnly = createMockCompareEntries(['size']).find((entry) => entry.relativePath === changed?.relativePath)
    expect(sizeOnly?.reasons.map((reason) => reason.type)).toEqual(['size'])
  })
})

describe('mock 对比流程', () => {
  it('先推送扫描批次，再分四批推送条目更新', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const scans: CompareEntry[][] = []
    const updates: CompareEntry[][] = []
    const unsubscribeScan = api.onScanComplete((_id, list) => scans.push([...list]))
    const unsubscribeEntry = api.onEntryUpdate((_id, list) => updates.push([...list]))

    const pending = api.runCompare(compareRequest('compare-stream'))

    await vi.advanceTimersByTimeAsync(250)
    expect(scans).toHaveLength(1)
    expect(scans[0].some((entry) => entry.state === 'pending')).toBe(true)
    expect(updates).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(4 * 400)
    const result = await pending

    expect(updates).toHaveLength(4)
    expect(updates.flat().every((entry) => entry.state === 'equal' || entry.state === 'different')).toBe(true)
    expect(result.success).toBe(true)
    // 条目通过事件流式送达，结果里不再重复携带
    expect(result.data?.entriesIncluded).toBe(false)
    expect(result.data?.stats.total).toBe(createMockCompareEntries().length)

    unsubscribeScan()
    unsubscribeEntry()
  })

  it('cancelCompare 让进行中的对比返回「对比已取消」', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const pending = api.runCompare(compareRequest('compare-cancel'))

    await vi.advanceTimersByTimeAsync(250)
    await api.cancelCompare('compare-cancel')
    const result = await pending

    expect(result.success).toBe(false)
    expect(result.error).toBe('对比已取消')
  })

  it('runPartialCompare 只返回指定根目录下的条目', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const pending = api.runPartialCompare({
      ...compareRequest('compare-partial'),
      relativeRoots: ['src/components'],
    })

    await vi.advanceTimersByTimeAsync(250)
    const result = await pending

    expect(result.success).toBe(true)
    expect(result.data?.entriesIncluded).toBe(true)
    expect(result.data?.entries.length).toBeGreaterThan(0)
    expect(result.data?.entries.every((entry) => entry.relativePath.startsWith('src/components'))).toBe(true)
  })
})

describe('mock 文件访问', () => {
  it('listFiles 按绝对路径解析出相对目录，并按一侧过滤条目', async () => {
    const api = createMockApi()
    await api.runCompare(compareRequest('compare-sources')).catch(() => undefined)
    await api.cancelCompare('compare-sources')

    const left = await api.listFiles(MOCK_LEFT_SOURCE, `${MOCK_LEFT_ROOT}/src/components`)
    const right = await api.listFiles(MOCK_RIGHT_SOURCE, `${MOCK_RIGHT_ROOT}/src/components`)

    const leftNames = left.data?.map((entry) => entry.name) ?? []
    const rightNames = right.data?.map((entry) => entry.name) ?? []

    expect(leftNames).toContain('Dialog.tsx')
    expect(rightNames).not.toContain('Dialog.tsx')
    expect(rightNames).toContain('Tabs.tsx')
    expect(leftNames).not.toContain('Tabs.tsx')
    // 只返回直接子项
    expect(leftNames.every((name) => !name.includes('/'))).toBe(true)
  })

  it('different 文件两侧内容不同，写回后可读回', async () => {
    const api = createMockApi()
    const path = 'src/App.tsx'

    const left = await api.readText(MOCK_LEFT_SOURCE, `${MOCK_LEFT_ROOT}/${path}`)
    const right = await api.readText(MOCK_RIGHT_SOURCE, `${MOCK_RIGHT_ROOT}/${path}`)
    expect(left.data).not.toBe(right.data)

    await api.writeText(MOCK_LEFT_SOURCE, `${MOCK_LEFT_ROOT}/${path}`, 'edited')
    const reread = await api.readText(MOCK_LEFT_SOURCE, `${MOCK_LEFT_ROOT}/${path}`)
    expect(reread.data).toBe('edited')
  })

  it('textDiff 直接在渲染进程计算', async () => {
    const result = await createMockApi().textDiff('a\nb', 'a\nc')
    expect(result.success).toBe(true)
    expect(result.data?.rightLines.some((line) => line.type === 'add')).toBe(true)
  })
})

describe('mock 同步任务', () => {
  const entries = createMockCompareEntries()

  it('requires one-use confirmation tokens for start and resume', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    await api.clearSync()
    const request = { compareId: 'checked', leftSource: MOCK_LEFT_SOURCE, rightSource: MOCK_RIGHT_SOURCE, direction: 'right_to_left' as const, entries: entries.filter((entry) => entry.state === 'right_only' && !entry.isDirectory).slice(0, 1) }
    expect((await api.startSync(request)).success).toBe(false)
    const plan = await api.prepareSync(request)
    const confirmed = { ...request, planId: plan.data?.planId }
    expect((await api.startSync(confirmed)).success).toBe(true)
    expect((await api.startSync(confirmed)).success).toBe(false)
    await api.pauseSync()
    expect((await api.resumeSync()).success).toBe(false)
    const resumePlan = await api.prepareSyncResume()
    expect((await api.resumeSync(resumePlan.data?.planId)).success).toBe(true)
    expect((await api.resumeSync(resumePlan.data?.planId)).success).toBe(false)
    await api.clearSync()
  })

  it('启动后逐步推进并最终完成', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    await api.clearSync()
    const snapshots: (Parameters<Parameters<AppAPI['onSyncProgress']>[0]>[0])[] = []
    const unsubscribe = api.onSyncProgress((task) => snapshots.push(task))

    const request = {
      compareId: 'compare-sync',
      leftSource: MOCK_LEFT_SOURCE,
      rightSource: MOCK_RIGHT_SOURCE,
      direction: 'right_to_left' as const,
      entries: entries.filter((entry) => entry.state === 'right_only' && !entry.isDirectory).slice(0, 3),
    }
    const plan = await api.prepareSync(request)
    const started = await api.startSync({ ...request, planId: plan.data?.planId })

    expect(started.success).toBe(true)
    expect(started.data?.status).toBe('running')
    expect(started.data?.items?.length).toBe(3)

    await vi.advanceTimersByTimeAsync(5000)
    const final = await api.getSyncStatus()
    expect(final.data?.status).toBe('completed')
    expect(final.data?.completedItems).toBe(3)
    expect(snapshots.length).toBeGreaterThan(0)

    unsubscribe()
  })

  it('暂停后停止推进，恢复后继续', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const request = {
      compareId: 'compare-sync-pause',
      leftSource: MOCK_LEFT_SOURCE,
      rightSource: MOCK_RIGHT_SOURCE,
      direction: 'right_to_left' as const,
      entries: entries.filter((entry) => entry.state === 'right_only'),
    }
    const plan = await api.prepareSync(request)
    await api.startSync({ ...request, planId: plan.data?.planId })

    const paused = await api.pauseSync()
    expect(paused.data?.status).toBe('paused')

    await vi.advanceTimersByTimeAsync(3000)
    expect((await api.getSyncStatus()).data?.completedItems).toBe(0)

    const resumePlan = await api.prepareSyncResume()
    const resumed = await api.resumeSync(resumePlan.data?.planId)
    expect(resumed.data?.status).toBe('running')
    await vi.advanceTimersByTimeAsync(2000)
    expect((await api.getSyncStatus()).data?.completedItems).toBeGreaterThan(0)
  })

  it('同步到右会在锁定文件上失败，覆盖 failed 状态', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const request = {
      compareId: 'compare-sync-fail',
      leftSource: MOCK_LEFT_SOURCE,
      rightSource: MOCK_RIGHT_SOURCE,
      direction: 'left_to_right' as const,
      entries: entries.filter((entry) => entry.relativePath === MOCK_SYNC_FAILURE_PATH),
    }
    const plan = await api.prepareSync(request)
    await api.startSync({ ...request, planId: plan.data?.planId })

    await vi.advanceTimersByTimeAsync(2000)
    const status = await api.getSyncStatus()
    expect(status.data?.status).toBe('failed')
    expect(status.data?.lastError).toContain(MOCK_SYNC_FAILURE_PATH)
  })

  it('clearSync 清空任务并推送 null', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const seen: unknown[] = []
    const unsubscribe = api.onSyncProgress((task) => seen.push(task))

    await api.clearSync()
    expect(seen).toContain(null)
    expect((await api.getSyncStatus()).data).toBeNull()

    unsubscribe()
  })
})

describe('mock SSH / 历史 / 选择器', () => {
  it('testSSHConnection 覆盖成功与失败两条路径', async () => {
    vi.useFakeTimers()
    const api = createMockApi()

    const okPending = api.testSSHConnection('ssh-staging')
    await vi.advanceTimersByTimeAsync(700)
    expect((await okPending).success).toBe(true)

    const failPending = api.testSSHConnection('ssh-prod')
    await vi.advanceTimersByTimeAsync(700)
    const failed = await failPending
    expect(failed.success).toBe(false)
    expect(failed.error).toContain('连接超时')
  })

  it('saveSSHConfig 新增后可在列表中查到，deleteSSHConfig 可移除', async () => {
    const api = createMockApi()
    const saved = await api.saveSSHConfig({
      label: '临时',
      host: '127.0.0.1',
      port: 22,
      username: 'demo',
      authType: 'password',
    })
    expect(saved.success).toBe(true)

    const listed = await api.listSSHConfigs()
    expect(listed.data?.some((config) => config.id === saved.data?.id)).toBe(true)

    await api.deleteSSHConfig(saved.data!.id)
    const after = await api.listSSHConfigs()
    expect(after.data?.some((config) => config.id === saved.data?.id)).toBe(false)
  })

  it('browseSSH 返回远端目录', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const pending = api.browseSSH('ssh-staging', '/srv/www/acme')
    await vi.advanceTimersByTimeAsync(700)
    const result = await pending

    expect(result.data?.path).toBe('/srv/www/acme')
    expect(result.data?.rootPath).toBe('/srv/www/acme')
    expect(result.data?.entries.map((entry) => entry.name)).toContain('src')
    expect(result.data?.entries.every((entry) => entry.isDirectory)).toBe(true)
  })

  it('历史条目可按 id 删除', async () => {
    const api = createMockApi()
    const before = await api.listHistory()
    const target = before.data?.[0]
    expect(target).toBeDefined()

    await api.deleteHistory(target!.id)
    const after = await api.listHistory()
    expect(after.data?.some((entry) => entry.id === target!.id)).toBe(false)
  })

  it('selectFolder 交替返回左右示例根目录，getPathForFile 返回空串', async () => {
    const api = createMockApi()
    const first = await api.selectFolder()
    const second = await api.selectFolder()

    expect(first.data).toBe(MOCK_LEFT_ROOT)
    expect(second.data).toBe(MOCK_RIGHT_ROOT)
    expect(api.getPathForFile({} as File)).toBe('')
  })

  it('onLog 订阅后会补发启动日志', async () => {
    vi.useFakeTimers()
    const api = createMockApi()
    const received: string[] = []
    const unsubscribe = api.onLog((entry) => received.push(entry.message))

    await vi.advanceTimersByTimeAsync(1)
    expect(received.length).toBeGreaterThan(0)
    expect(received.some((message) => message.includes('[mock]'))).toBe(true)

    unsubscribe()
  })
})

describe('mock 未使用的订阅通道', () => {
  it('onCompareLocalDirty / onOpenPaths 返回可调用的退订函数', () => {
    const api = createMockApi()
    const source: SourceConfig = MOCK_LEFT_SOURCE
    expect(source.type).toBe('local')
    expect(() => api.onCompareLocalDirty(() => {})()).not.toThrow()
    expect(() => api.onOpenPaths(() => {})()).not.toThrow()
    expect(() => api.onDirectoryDragDrop(() => {})()).not.toThrow()
  })
})
