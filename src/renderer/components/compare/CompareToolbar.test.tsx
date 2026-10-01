import SyncConfirmDialog from '../overlays/SyncConfirmDialog'
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CompareToolbar from './CompareToolbar'
import { useAppStore } from '../../stores/app-store'
import { useCompareStore } from '../../stores/compare-store'
import { useSSHStore } from '../../stores/ssh-store'
import { useSettingsStore } from '../../stores/settings-store'
import { EMPTY_TREE_SELECTION, useUIStore } from '../../stores/ui-store'
import type { CompareEntry, SourceConfig, SyncTaskSnapshot } from '../../../../shared/types'

const LEFT_SOURCE: SourceConfig = { type: 'local', path: '/var/left' }
const RIGHT_SOURCE: SourceConfig = { type: 'local', path: '/var/right' }

function createEntry(relativePath: string): CompareEntry {
  return {
    relativePath,
    name: relativePath.split('/').at(-1) ?? relativePath,
    isDirectory: false,
    state: 'different',
    left: { name: 'app.ts', path: `/var/left/${relativePath}`, isDirectory: false, size: 1, mtime: 1 },
    right: { name: 'app.ts', path: `/var/right/${relativePath}`, isDirectory: false, size: 2, mtime: 2 },
    reasons: [{ type: 'size', leftSize: 1, rightSize: 2 }],
  }
}

function createSyncTask(overrides: Partial<SyncTaskSnapshot> = {}): SyncTaskSnapshot {
  return {
    id: 'sync-1',
    leftSource: LEFT_SOURCE,
    rightSource: RIGHT_SOURCE,
    direction: 'left_to_right',
    status: 'running',
    totalItems: 120,
    completedItems: 41,
    currentPath: 'src/util.ts',
    lastCompletedPath: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function installApiMock(overrides: Partial<Window['api']> = {}) {
  const api = {
    runtime: {
      mode: 'tauri' as const,
      supportsSftp: true,
      supportsHistory: true,
      supportsSync: true,
      supportsNativeFolderSelection: true,
      supportsDirectoryDragDrop: true,
      supportsWriteBack: true,
    },
    runCompare: vi.fn(() => new Promise(() => undefined)),
    cancelCompare: vi.fn(async () => ({ success: true })),
    prepareSync: vi.fn(async () => ({ success: true, data: { planId: 'checked-plan', files: 4, directories: 2, overwrites: 3 } })),
    startSync: vi.fn(async () => ({ success: true, data: null })),
    pauseSync: vi.fn(async () => ({ success: true, data: null })),
    resumeSync: vi.fn(async () => ({ success: true, data: null })),
    clearSync: vi.fn(async () => ({ success: true })),
    ...overrides,
  } as unknown as Window['api']

  window.api = api
  return api
}

function resetStores(): void {
  useAppStore.setState({
    page: 'compare',
    diffTabs: [],
    activeDiffTabId: null,
    compareTabs: [
      {
        id: 'tab-1',
        title: '本地:left ↔ 本地:right',
        snapshot: useCompareStore.getState().createTabSnapshot(),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ],
    activeCompareTabId: 'tab-1',
  })

  useCompareStore.setState({
    leftPath: LEFT_SOURCE.path,
    rightPath: RIGHT_SOURCE.path,
    leftSourceType: 'local',
    rightSourceType: 'local',
    leftSSHConfigId: '',
    rightSSHConfigId: '',
    leftSource: LEFT_SOURCE,
    rightSource: RIGHT_SOURCE,
    strategies: ['size', 'mtime'],
    extensionFilter: [],
    entries: [createEntry('src/app.ts')],
    entrySummary: {
      stats: { total: 1, equal: 0, different: 1, leftOnly: 0, rightOnly: 0 },
      pendingCount: 0,
      allDirCount: 0,
    },
    scanning: false,
    comparing: false,
    paused: false,
    done: true,
    error: null,
    duration: 1200,
    dirtyPaths: new Set(),
    expandedDirs: new Set(),
    viewMode: 'split',
    hideDot: false,
    hideDotFilter: 'all',
    compareSessionId: 'compare-1',
    activeCompareId: null,
    syncTask: null,
  })

  useUIStore.setState({ overlay: null, pendingSync: null, treeSelection: EMPTY_TREE_SELECTION })
  useSSHStore.setState({ configs: [], loading: false, loadConfigs: async () => undefined })
  useSettingsStore.setState({ globalPathFilters: [] })
}

async function openOverflow(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '更多操作' }))
}

describe('CompareToolbar', () => {
  beforeEach(() => {
    installApiMock()
    resetStores()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the pair title and the finished-job subtitle instead of a separate status pill', () => {
    render(<CompareToolbar />)

    expect(screen.getByRole('heading', { name: '本地:left ↔ 本地:right' })).toBeTruthy()
    expect(screen.getByText('1 项')).toBeTruthy()
    expect(screen.getByText(/用时/)).toBeTruthy()
  })

  it('shows one combined streaming label and an indeterminate 2px progress line', () => {
    useCompareStore.setState({ scanning: true, comparing: true, done: false })

    render(<CompareToolbar />)

    expect(screen.getByText('扫描并对比中…')).toBeTruthy()
    expect(screen.queryByText('扫描中…')).toBeNull()
    expect(screen.getByRole('progressbar').getAttribute('aria-busy')).toBe('true')
  })

  it('keeps Cancel next to the progress it belongs to while a compare runs', async () => {
    useCompareStore.setState({ scanning: true, comparing: true, done: false, activeCompareId: 'compare-1' })
    const api = installApiMock()

    const user = userEvent.setup()
    render(<CompareToolbar />)

    await user.click(screen.getByRole('button', { name: '暂停对比' }))

    await waitFor(() => expect(api.cancelCompare).toHaveBeenCalledWith('compare-1'))
  })

  // ⌘R / ⌘. / ⌘F 现在归 `hooks/useGlobalShortcuts.ts`（chunk 9）——工具栏在打开文件
  // Diff 时不渲染，键挂在这里会静默失效。断言随之搬到 useGlobalShortcuts.test.tsx。
  // 留在这里的是接线：过滤弹层的开合状态来自 ui-store，所以全局层能推开它。
  it('drives the session filter editor from the shared ui-store flag', async () => {
    render(<CompareToolbar />)

    expect(screen.queryByRole('dialog', { name: '路径过滤规则' })).toBeNull()

    act(() => useUIStore.getState().setFilterPopoverOpen(true))

    expect(await screen.findByRole('dialog', { name: '路径过滤规则' })).toBeTruthy()
  })

  it('labels the session filter chip with its rule count', () => {
    useCompareStore.setState({ extensionFilter: ['node_modules', 'path:dist'] })

    render(<CompareToolbar />)

    expect(screen.getByRole('button', { name: '过滤 (2)' })).toBeTruthy()
  })

  it('keeps a filter chip accessible name stable while its live count changes', () => {
    render(<CompareToolbar />)

    const chip = screen.getByRole('button', { name: '全部' })
    expect(chip.textContent).toContain('1')
  })

  it('moves view mode, hide-dot and expand-all into the overflow menu', async () => {
    const user = userEvent.setup()
    render(<CompareToolbar />)

    await openOverflow(user)
    expect(screen.getByRole('menuitem', { name: '展开全部目录' })).toBeTruthy()

    await user.click(screen.getByRole('menuitem', { name: '视图' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: '合并' }))
    expect(useCompareStore.getState().viewMode).toBe('merged')

    await openOverflow(user)
    await user.click(screen.getByRole('menuitem', { name: '隐藏点文件' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: '仅隐藏文件' }))
    expect(useCompareStore.getState().hideDot).toBe(true)
    expect(useCompareStore.getState().hideDotFilter).toBe('files')
  })

  it('swaps the two sources and invalidates the stale result instead of silently re-running', async () => {
    const user = userEvent.setup()
    render(<CompareToolbar />)

    await openOverflow(user)
    await user.click(screen.getByRole('menuitem', { name: '交换左右' }))

    const state = useCompareStore.getState()
    expect(state.leftPath).toBe(RIGHT_SOURCE.path)
    expect(state.rightPath).toBe(LEFT_SOURCE.path)
    expect(state.done).toBe(false)
    expect(window.api.runCompare).not.toHaveBeenCalled()
  })

  it('opens the source editor overlay from the overflow menu', async () => {
    const user = userEvent.setup()
    render(<CompareToolbar />)

    await openOverflow(user)
    await user.click(screen.getByRole('menuitem', { name: /编辑数据源…/ }))

    expect(useUIStore.getState().overlay).toBe('compare-setup')
  })

  it('disables 重比变更 until something on disk actually changed', async () => {
    const user = userEvent.setup()
    render(<CompareToolbar />)

    await openOverflow(user)
    expect(screen.getByRole('menuitem', { name: '重比变更 (0)' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('queues a sync from the split button and keeps both directions reachable', async () => {
    const api = installApiMock()
    const user = userEvent.setup()
    render(<><CompareToolbar /><SyncConfirmDialog /></>)

    await user.click(screen.getByRole('button', { name: '同步到右' }))
    expect(api.startSync).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认并同步' }))
    await waitFor(() => expect(api.startSync).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '同步选项' }))
    await user.click(screen.getByRole('menuitem', { name: '同步到左' }))
    await user.click(screen.getByRole('button', { name: '确认并同步' }))
    await waitFor(() => expect(api.startSync).toHaveBeenCalledTimes(2))
  })

  it('replaces the inline sync strip with the toolbar progress line for the owning tab', () => {
    useCompareStore.setState({ syncTask: createSyncTask() })

    render(<CompareToolbar />)

    // 旧的行内同步条（进度文本 + 详情/暂停/继续/清除四个按钮）不再占用工具栏。
    expect(screen.queryByText(/同步 41\/120/)).toBeNull()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('34')
    expect(screen.getByRole('button', { name: '暂停同步' })).toBeTruthy()
  })

  it('hides a sync task that belongs to a different source pair', () => {
    useCompareStore.setState({
      syncTask: createSyncTask({ leftSource: { type: 'local', path: '/other' } }),
    })

    render(<CompareToolbar />)

    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('button', { name: '同步到右' })).toBeTruthy()
  })

  it('renders compare errors as an alert with a retry action', async () => {
    useCompareStore.setState({ error: '左侧目录不可访问', done: false })
    const api = installApiMock()

    const user = userEvent.setup()
    render(<CompareToolbar />)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('左侧目录不可访问')

    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(api.runCompare).toHaveBeenCalledTimes(1))
  })

  it('warns inside 比较依据 when no strategy is selected and disables the compare action', async () => {
    useCompareStore.setState({ strategies: [] })

    const user = userEvent.setup()
    render(<CompareToolbar />)

    expect((screen.getByRole('button', { name: '重启对比' }) as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByRole('button', { name: '比较依据 (0)' }))
    expect(screen.getByText('至少选择一个比较依据，否则无法开始对比。')).toBeTruthy()
  })
})
