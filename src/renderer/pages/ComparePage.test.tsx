// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CompareEntry, CompareResult, FileEntry, IpcResult, SourceConfig, SyncTaskSnapshot } from '../../../shared/types'
import AppShell from '../components/AppShell'
import ComparePage from './ComparePage'
import { useAppStore, type CompareTab, type DiffTab } from '../stores/app-store'
import { useCompareStore, type CompareSessionSnapshot } from '../stores/compare-store'
import { useLogStore } from '../stores/log-store'
import { EMPTY_TREE_SELECTION, useUIStore } from '../stores/ui-store'
import { useSettingsStore } from '../stores/settings-store'
import { useSSHStore } from '../stores/ssh-store'

/**
 * chunk 7：目录树行从手写的 `<tr>` 换成共享 `TreeRow`（`role="treeitem"`），
 * 于是这里不能再 `closest('tr')`。行动作也从裸 `<button>` 变成 `role="menuitem"`。
 */
function treeRow(name: string): HTMLElement {
  const row = screen.getAllByText(name)
    .map((element) => element.closest<HTMLElement>('[role="treeitem"]'))
    .find((element): element is HTMLElement => element != null)
  if (!row) throw new Error(`no tree row for "${name}"`)
  return row
}

function createFileEntry(name: string, path: string): FileEntry {
  return {
    name,
    path,
    isDirectory: false,
    size: 1,
    mtime: 1,
  }
}

function createDirectoryEntry(name: string, path: string): FileEntry {
  return {
    name,
    path,
    isDirectory: true,
    size: 0,
    mtime: 1,
  }
}

function createCompareEntry(relativePath: string): CompareEntry {
  return {
    relativePath,
    name: relativePath.split('/').at(-1) ?? relativePath,
    isDirectory: false,
    state: 'different',
    left: createFileEntry('app.ts', `/left/${relativePath}`),
    right: createFileEntry('app.ts', `/right/${relativePath}`),
    reasons: [{ type: 'size', leftSize: 1, rightSize: 2 }],
  }
}

function createCompareDirectory(relativePath: string, state: CompareEntry['state'] = 'equal'): CompareEntry {
  const name = relativePath.split('/').at(-1) ?? relativePath

  return {
    relativePath,
    name,
    isDirectory: true,
    state,
    left: createDirectoryEntry(name, `/left/${relativePath}`),
    right: createDirectoryEntry(name, `/right/${relativePath}`),
    reasons: [],
  }
}

function createLeftOnlyDirectory(relativePath: string): CompareEntry {
  const name = relativePath.split('/').at(-1) ?? relativePath

  return {
    relativePath,
    name,
    isDirectory: true,
    state: 'left_only',
    left: createDirectoryEntry(name, `/left/${relativePath}`),
    reasons: [],
  }
}

function createSyncTask(overrides: Partial<SyncTaskSnapshot> = {}): SyncTaskSnapshot {
  return {
    id: 'sync-task-1',
    leftSource,
    rightSource,
    direction: 'left_to_right',
    status: 'running',
    totalItems: 10,
    completedItems: 3,
    currentPath: 'config',
    lastCompletedPath: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function createDiffTab(overrides: Partial<DiffTab> = {}): DiffTab {
  return {
    id: 'diff-tab-1',
    sessionId: 'compare-tab-1',
    relativePath: 'src/app.ts',
    fileName: 'app.ts',
    hasLeftFile: true,
    hasRightFile: true,
    leftSource,
    rightSource,
    leftFullPath: '/left/src/app.ts',
    rightFullPath: '/right/src/app.ts',
    leftContent: 'alpha',
    rightContent: 'alpha',
    originalLeftContent: 'alpha',
    originalRightContent: 'alpha',
    diffResult: null,
    loadError: null,
    loading: false,
    ...overrides,
  }
}

const leftSource: SourceConfig = { type: 'local', path: '/var/old-left' }
const rightSource: SourceConfig = { type: 'local', path: '/var/old-right' }

function createSnapshot(overrides: Partial<CompareSessionSnapshot> = {}): CompareSessionSnapshot {
  return {
    leftPath: leftSource.path,
    rightPath: rightSource.path,
    leftSourceType: 'local',
    rightSourceType: 'local',
    leftSSHConfigId: '',
    rightSSHConfigId: '',
    strategies: ['size', 'mtime'],
    extensionFilter: ['node_modules'],
    hideDot: true,
    hideDotFilter: 'all',
    entries: [createCompareEntry('src/app.ts')],
    scanning: false,
    comparing: false,
    paused: false,
    done: true,
    error: null,
    duration: 123,
    leftSource,
    rightSource,
    dirtyPaths: [],
    loadingDirs: [],
    filter: 'all',
    expandedDirs: [],
    viewMode: 'split',
    activeCompareId: null,
    ...overrides,
  }
}

function resetStores(compareTabs: readonly CompareTab[] = []): void {
  window.localStorage.clear()

  useAppStore.setState({
    page: 'compare',
    diffTabs: [],
    activeDiffTabId: null,
    compareTabs: [...compareTabs],
    activeCompareTabId: compareTabs[0]?.id ?? null,
  })

  useCompareStore.setState({
    leftPath: leftSource.path,
    rightPath: rightSource.path,
    leftSourceType: 'local',
    rightSourceType: 'local',
    leftSSHConfigId: '',
    rightSSHConfigId: '',
    strategies: ['size', 'mtime'],
    extensionFilter: ['node_modules'],
    hideDot: false,
    hideDotFilter: 'all',
    entries: [createCompareEntry('src/app.ts')],
    scanning: false,
    comparing: false,
    paused: false,
    done: true,
    error: null,
    duration: 123,
    leftSource,
    rightSource,
    loadingDirs: new Set(),
    filter: 'all',
    expandedDirs: new Set(),
    viewMode: 'split',
    activeCompareId: null,
    compareSessionId: 'compare-1',
    syncTask: null,
    compareVersion: 0,
  })

  useLogStore.setState({ logs: [], visible: false })
  useUIStore.setState({ overlay: null, pendingSync: null, treeSelection: EMPTY_TREE_SELECTION })
  useSettingsStore.setState({ globalPathFilters: [] })
  useSSHStore.setState({ configs: [], loading: false, loadConfigs: async () => undefined })
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
    onLog: vi.fn(() => () => undefined),
    readText: vi.fn(async () => ({ success: true, data: 'alpha' })),
    textDiff: vi.fn(async () => ({
      success: true,
      data: {
        leftLines: [{ type: 'equal', content: 'alpha', lineNumber: 1 }],
        rightLines: [{ type: 'equal', content: 'alpha', lineNumber: 1 }],
      },
    })),
    runCompare: vi.fn(async () => ({
      success: true,
      data: {
        entries: [createCompareEntry('src/app.ts')],
        stats: { total: 1, equal: 0, different: 1, leftOnly: 0, rightOnly: 0 },
        duration: 123,
      },
    })),
    cancelCompare: vi.fn(async () => ({ success: true })),
    clearSync: vi.fn(async () => ({ success: true })),
    getSyncStatus: vi.fn(async () => ({ success: true, data: null })),
    onEntryUpdate: vi.fn(() => () => undefined),
    onScanComplete: vi.fn(() => () => undefined),
    onSyncProgress: vi.fn(() => () => undefined),
    pauseSync: vi.fn(async () => ({ success: true, data: null })),
    resumeSync: vi.fn(async () => ({ success: true, data: null })),
    prepareSync: vi.fn(async () => ({ success: true, data: { planId: 'checked-plan', files: 4, directories: 2, overwrites: 3 } })),
    startSync: vi.fn(async () => ({ success: true, data: null })),
    ...overrides,
  } as unknown as Window['api']

  window.api = api
  return api
}

describe('ComparePage renderer interactions', () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    installApiMock()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('does not force the log panel open when clicking the current compare tab', async () => {
    resetStores([
      {
        id: 'compare-tab-1',
        title: '当前对比',
        snapshot: createSnapshot(),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])

    const user = userEvent.setup()
    render(
      <AppShell>
        <ComparePage />
      </AppShell>,
    )

    expect(screen.queryByText('暂无日志')).toBeNull()

    await user.click(screen.getByRole('tab', { name: '当前对比' }))

    // F9：日志面板只由 ⌘J、状态栏的日志 chip 或应用菜单打开。
    expect(screen.queryByText('暂无日志')).toBeNull()
    expect(useLogStore.getState().visible).toBe(false)
  })

  it('marks the active compare tab with the shared TabStrip selection wash', () => {
    resetStores([
      {
        id: 'compare-tab-1',
        title: '当前对比',
        snapshot: createSnapshot(),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])

    render(<ComparePage />)

    // TabStrip 把选中态放在包裹层上（DESIGN-SYSTEM §5 的 `--ds-selected` 冲刷）。
    expect(screen.getByRole('tab', { name: '当前对比' }).parentElement?.className).toContain('bg-selected')
  })

  it('marks 目录树 as the selected stop of the diff tab strip', () => {
    resetStores()
    useAppStore.setState({
      diffTabs: [createDiffTab()],
      activeDiffTabId: null,
    })

    render(<ComparePage />)

    // chunk 7：目录树不再是标签条旁边的一个蓝按钮，而是这条 `TabStrip` 的第 0 站，
    // 所以它的选中态和文件标签完全同款（`--ds-selected` 冲刷，DESIGN-SYSTEM §5）。
    const treeTab = screen.getByRole('tab', { name: '目录树' })
    expect(treeTab.getAttribute('aria-selected')).toBe('true')
    expect(treeTab.parentElement?.className).toContain('bg-selected')
  })

  it('shows 首次对比 after submitting a new source path with Enter', async () => {
    resetStores([
      {
        id: 'compare-tab-1',
        title: '路径测试',
        snapshot: createSnapshot(),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])

    const user = userEvent.setup()
    render(<ComparePage />)

    expect(screen.getByRole('button', { name: '重启对比' })).toBeTruthy()

  const input = screen.getByDisplayValue('/var/old-left') as HTMLInputElement
  expect(input.className).not.toContain('focus:border-accent')
    await user.clear(input)
    await user.type(input, '/var/new-left{enter}')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '首次对比' })).toBeTruthy()
    })

    expect(useCompareStore.getState().leftPath).toBe('/var/new-left')
    expect(useCompareStore.getState().done).toBe(false)
    expect(useCompareStore.getState().entries).toEqual([])
  })

  it('hides zero filter badges before compare starts', () => {
    resetStores()
    useCompareStore.setState({
      entries: [],
      done: false,
      scanning: false,
      comparing: false,
      duration: 0,
      entrySummary: {
        stats: { total: 0, equal: 0, different: 0, leftOnly: 0, rightOnly: 0 },
        pendingCount: 0,
        allDirCount: 0,
      },
    })

    render(<ComparePage />)

    expect(screen.getByRole('button', { name: '全部' }).textContent?.replace(/\s+/g, '')).toBe('全部')
    expect(screen.getByRole('button', { name: '双方' }).textContent?.replace(/\s+/g, '')).toBe('双方')
    expect(screen.getByRole('button', { name: '不同' }).textContent?.replace(/\s+/g, '')).toBe('不同')
  })

  it('hides ignored exact-path entries from both split panes immediately', () => {
    resetStores()
    useCompareStore.setState({
      entries: [
        createCompareDirectory('config'),
        createCompareEntry('config/app.php'),
        createCompareEntry('readme.md'),
      ],
      extensionFilter: ['path:config'],
      expandedDirs: new Set(['config']),
    })

    render(<ComparePage />)

    expect(screen.queryByText('config')).toBeNull()
    expect(screen.queryByText('app.php')).toBeNull()
    expect(screen.getAllByText('readme.md')).toHaveLength(2)
  })

  it('does not restart compare when adding an ignore filter', async () => {
    resetStores()
    const api = installApiMock()
    useCompareStore.setState({
      viewMode: 'merged',
      extensionFilter: ['node_modules'],
      entries: [
        createCompareDirectory('config'),
        createCompareEntry('config/app.php'),
        createCompareEntry('readme.md'),
      ],
      expandedDirs: new Set(['config']),
    })

    render(<ComparePage />)

    fireEvent.contextMenu(treeRow('config'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '忽略目录：『config』' }))

    await waitFor(() => {
      expect(useCompareStore.getState().extensionFilter).toContain('path:config')
    })
    expect(api.runCompare).not.toHaveBeenCalled()
  })

  it('shows a file read error instead of treating a failed side as empty content', async () => {
    const api = installApiMock({
      readText: vi.fn(async (source) => {
        if (source.path === '/var/old-left') {
          return { success: false, error: 'channel closed' }
        }

        return { success: true, data: '<?php echo 1;' }
      }),
    })
    resetStores()

    const user = userEvent.setup()
    render(<ComparePage />)

    await user.dblClick(screen.getAllByText('app.ts')[0])

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('左侧本地文件读取失败')
      expect(screen.getByRole('alert').textContent).toContain('读取过程已中断或超时')
    })
    expect(api.textDiff).not.toHaveBeenCalled()
  })

  it('shows exact path filters in the modal without the path prefix', async () => {
    resetStores()
    useCompareStore.setState({ extensionFilter: ['path:bootstrap', 'node_modules'] })

    const user = userEvent.setup()
    render(<ComparePage />)

    await user.click(screen.getByRole('button', { name: '过滤 (2)' }))

    const modalInput = screen.getAllByRole('textbox').find((element): element is HTMLTextAreaElement => element.tagName === 'TEXTAREA')

    expect(modalInput?.value).toBe('bootstrap\nnode_modules')
  })

  it('shows file and directory names in ignore context menus', async () => {
    resetStores()
    useCompareStore.setState({
      viewMode: 'merged',
      entries: [
        createCompareDirectory('config'),
        createCompareEntry('app.php'),
      ],
    })

    render(<ComparePage />)

    fireEvent.contextMenu(treeRow('config'))
    expect(await screen.findByRole('menuitem', { name: '忽略目录：『config』' })).toBeTruthy()

    fireEvent.contextMenu(treeRow('app.php'))
    expect(await screen.findByRole('menuitem', { name: '忽略文件：『app.php』' })).toBeTruthy()
  })

  it('allows copying the current selection before compare is finished', async () => {
    const api = installApiMock()
    resetStores()
    useCompareStore.setState({
      done: false,
      comparing: true,
      entries: [createLeftOnlyDirectory('config')],
    })

    const user = userEvent.setup()
    // 选择槽位现在住在状态栏里（设计蓝图 §4.1），所以要连壳层一起渲染。
    render(<AppShell><ComparePage /></AppShell>)

    await user.click(treeRow('config'))

    const selectionCopyButton = screen.getByRole('button', { name: '复制所选到右边' }) as HTMLButtonElement
    expect(selectionCopyButton.disabled).toBe(false)

    fireEvent.contextMenu(treeRow('config'))

    const contextCopyButton = await screen.findByRole('menuitem', { name: '复制到右边' }) as HTMLButtonElement
    expect(contextCopyButton.disabled).toBe(false)

    await user.click(contextCopyButton)
    expect(api.startSync).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认并同步' }))
    await user.click(selectionCopyButton)
    await user.click(screen.getByRole('button', { name: '确认并同步' }))

    await waitFor(() => {
      expect(api.startSync).toHaveBeenCalledTimes(2)
    })
  })

  it('allows selection copy again after a completed sync task', async () => {
    const api = installApiMock()
    resetStores()
    useCompareStore.setState({
      entries: [createLeftOnlyDirectory('config')],
      syncTask: createSyncTask({ status: 'completed' }),
    })

    const user = userEvent.setup()
    render(<AppShell><ComparePage /></AppShell>)

    const configRow = treeRow('config')

    expect(configRow).toBeTruthy()
    await user.click(configRow)

    const selectionCopyButton = screen.getByRole('button', { name: '复制所选到右边' }) as HTMLButtonElement
    expect(selectionCopyButton.disabled).toBe(false)

    await user.click(selectionCopyButton)
    await user.click(screen.getByRole('button', { name: '确认并同步' }))

    await waitFor(() => {
      expect(api.startSync).toHaveBeenCalledTimes(1)
    })
  })

  it('combines scanning and comparing into one header status and exposes the paired filter', () => {
    resetStores()
    useCompareStore.setState({ scanning: true, comparing: true, done: false })

    render(<ComparePage />)

    expect(screen.getByText('扫描并对比中…')).toBeTruthy()
    expect(screen.queryByText('扫描中…')).toBeNull()
    expect(screen.queryByText('对比中…')).toBeNull()
    expect(screen.getByRole('button', { name: '双方' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '不同' })).toBeTruthy()
  })

  it('does not show the incomplete compare warning banner', () => {
    resetStores()
    useCompareStore.setState({
      entries: [createCompareDirectory('bootstrap', 'pending')],
      scanning: false,
      comparing: false,
      done: false,
    })

    render(<ComparePage />)

    expect(screen.queryByText('当前结果未完成，需先重新对比后才能执行同步。')).toBeNull()
  })

  it('shows compare errors in the compare page UI', () => {
    resetStores()
    useCompareStore.setState({
      error: '左侧目录不可访问：/Volumes/未命名2/迅雷下载/书籍。可能是硬盘未插入、未挂载，或路径已变更。',
      done: false,
      scanning: false,
      comparing: false,
    })

    render(<ComparePage />)

    expect(screen.getByRole('alert').textContent).toContain('左侧目录不可访问：/Volumes/未命名2/迅雷下载/书籍。可能是硬盘未插入、未挂载，或路径已变更。')
  })

  it('uses the compare tab tooltip for full source paths instead of rendering a separate summary pill', () => {
    resetStores([
      {
        id: 'compare-tab-1',
        title: '本地:old-left ↔ 本地:old-right',
        snapshot: createSnapshot(),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])

    render(<ComparePage />)

    const compareTab = screen.getByRole('tab', { name: '本地:old-left ↔ 本地:old-right' })
    const fullLabel = '/var/old-left ↔ /var/old-right'

    expect(compareTab.getAttribute('title')).toBe(fullLabel)
    expect(screen.queryByText(fullLabel)).toBeNull()
  })

  it('shows dot files by default instead of hiding them', () => {
    resetStores()
    useCompareStore.setState({
      entries: [createCompareEntry('.env')],
      hideDot: false,
    })

    render(<ComparePage />)

    expect(screen.getAllByText('.env')).toHaveLength(2)
  })

  it('pauses an active compare from the toolbar', async () => {
    const api = installApiMock()
    resetStores([
      {
        id: 'compare-tab-1',
        title: '进行中对比',
        snapshot: createSnapshot({
          entries: [createCompareEntry('src/app.ts')],
          scanning: true,
          comparing: true,
          paused: false,
          done: false,
          activeCompareId: 'compare-1',
        }),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])
    useCompareStore.setState({
      entries: [createCompareEntry('src/app.ts')],
      scanning: true,
      comparing: true,
      paused: false,
      done: false,
      activeCompareId: 'compare-1',
    })

    const user = userEvent.setup()
    render(<ComparePage />)

    await user.click(screen.getByRole('button', { name: '暂停对比' }))

    await waitFor(() => {
      expect(api.cancelCompare).toHaveBeenCalledWith('compare-1')
    })

    await waitFor(() => {
      const state = useCompareStore.getState()
      expect(state.paused).toBe(true)
      expect(state.scanning).toBe(false)
      expect(state.comparing).toBe(false)
    })

    expect(screen.getByRole('button', { name: '继续对比' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重启对比' })).toBeTruthy()
  })

  it('continues a paused compare while preserving existing entries', async () => {
    const api = installApiMock({
      runCompare: vi.fn(() => new Promise<IpcResult<CompareResult>>(() => undefined)),
    })
    resetStores([
      {
        id: 'compare-tab-1',
        title: '已暂停对比',
        snapshot: createSnapshot({
          entries: [createCompareEntry('src/app.ts')],
          scanning: false,
          comparing: false,
          paused: true,
          done: false,
          activeCompareId: null,
        }),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])
    useCompareStore.setState({
      entries: [createCompareEntry('src/app.ts')],
      scanning: false,
      comparing: false,
      paused: true,
      done: false,
      activeCompareId: null,
    })

    const user = userEvent.setup()
    render(<ComparePage />)

    await user.click(screen.getByRole('button', { name: '继续对比' }))

    await waitFor(() => {
      expect(api.runCompare).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      const state = useCompareStore.getState()
      expect(state.scanning).toBe(true)
      expect(state.paused).toBe(false)
      expect(state.entries.map((entry) => entry.relativePath)).toEqual(['src/app.ts'])
    })
  })

  it('restarts compare from the toolbar and clears previous entries', async () => {
    const api = installApiMock({
      runCompare: vi.fn(() => new Promise<IpcResult<CompareResult>>(() => undefined)),
    })
    resetStores([
      {
        id: 'compare-tab-1',
        title: '完成对比',
        snapshot: createSnapshot({
          entries: [createCompareEntry('src/app.ts')],
          done: true,
          paused: false,
          activeCompareId: null,
        }),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])
    useCompareStore.setState({
      entries: [createCompareEntry('src/app.ts')],
      scanning: false,
      comparing: false,
      paused: false,
      done: true,
      activeCompareId: null,
    })

    const user = userEvent.setup()
    render(<ComparePage />)

    await user.click(screen.getByRole('button', { name: '重启对比' }))

    await waitFor(() => {
      expect(api.runCompare).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      const state = useCompareStore.getState()
      expect(state.scanning).toBe(true)
      expect(state.entries).toEqual([])
      expect(state.paused).toBe(false)
    })
  })

  it('restarts compare without cloning the full compare snapshot first', async () => {
    const api = installApiMock({
      runCompare: vi.fn(() => new Promise<IpcResult<CompareResult>>(() => undefined)),
    })
    resetStores([
      {
        id: 'compare-tab-1',
        title: '完成对比',
        snapshot: createSnapshot({
          entries: [createCompareEntry('src/app.ts')],
          done: true,
          paused: false,
          activeCompareId: null,
        }),
        diffTabs: [],
        activeDiffTabId: null,
      },
    ])
    useCompareStore.setState({
      entries: [createCompareEntry('src/app.ts')],
      scanning: false,
      comparing: false,
      paused: false,
      done: true,
      activeCompareId: null,
    })

    const originalCreateSnapshot = useCompareStore.getState().createSnapshot
    const forbiddenCreateSnapshot = vi.fn(() => {
      throw new Error('restart compare should not build a full snapshot')
    })
    useCompareStore.setState({ createSnapshot: forbiddenCreateSnapshot })

    const user = userEvent.setup()
    render(<ComparePage />)

    await user.click(screen.getByRole('button', { name: '重启对比' }))

    await waitFor(() => {
      expect(api.runCompare).toHaveBeenCalledTimes(1)
    })
    expect(forbiddenCreateSnapshot).not.toHaveBeenCalled()

    useCompareStore.setState({ createSnapshot: originalCreateSnapshot })
  })
})
