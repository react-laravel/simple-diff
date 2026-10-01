// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useCommands } from './useCommands'
import { useAppStore } from '../stores/app-store'
import { useCompareStore } from '../stores/compare-store'
import { useLogStore } from '../stores/log-store'
import { useSSHStore } from '../stores/ssh-store'
import { EMPTY_TREE_SELECTION, useUIStore } from '../stores/ui-store'
import type { Command } from '../components/ui'
import type { CompareHistoryEntry, SourceConfig } from '../../../shared/types'

const LEFT_SOURCE: SourceConfig = { type: 'local', path: '/var/left' }
const RIGHT_SOURCE: SourceConfig = { type: 'local', path: '/var/right' }

const HISTORY_ENTRY: CompareHistoryEntry = {
  id: 'history-1',
  timestamp: 1_700_000_000_000,
  leftLabel: 'left',
  rightLabel: 'right',
  leftSource: LEFT_SOURCE,
  rightSource: RIGHT_SOURCE,
  stats: { total: 3, equal: 1, different: 1, leftOnly: 1, rightOnly: 0 },
}

let latest: Command[] = []

function Host({ enabled = true }: { enabled?: boolean }) {
  latest = useCommands({ enabled })
  return null
}

function byId(id: string): Command {
  const command = latest.find((item) => item.id === id)
  if (!command) throw new Error(`missing command: ${id}\n${latest.map((c) => c.id).join('\n')}`)
  return command
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
    listHistory: vi.fn(async () => ({ success: true, data: [HISTORY_ENTRY] })),
    listSSHConfigs: vi.fn(async () => ({ success: true, data: [] })),
    prepareSync: vi.fn(async () => ({ success: true, data: { planId: 'checked-plan', files: 4, directories: 2, overwrites: 3 } })),
    startSync: vi.fn(async () => ({ success: true, data: null })),
    pauseSync: vi.fn(async () => ({ success: true, data: null })),
    ...overrides,
  } as unknown as Window['api']

  window.api = api
  return api
}

beforeEach(() => {
  latest = []
  installApiMock()
  useAppStore.setState({
    page: 'compare',
    diffTabs: [],
    activeDiffTabId: null,
    compareTabs: [],
    activeCompareTabId: null,
  })
  useCompareStore.setState({
    leftPath: LEFT_SOURCE.path,
    rightPath: RIGHT_SOURCE.path,
    leftSource: LEFT_SOURCE,
    rightSource: RIGHT_SOURCE,
    strategies: ['size'],
    scanning: false,
    comparing: false,
    paused: false,
    done: false,
    entries: [],
    dirtyPaths: new Set(),
    expandedDirs: new Set(),
    viewMode: 'split',
    hideDot: false,
    syncTask: null,
    activeCompareId: null,
  })
  useLogStore.setState({ logs: [], visible: false })
  useSSHStore.setState({ configs: [], loading: false, loadConfigs: async () => undefined })
  useUIStore.setState({ overlay: null, filterPopoverOpen: false, treeSelection: EMPTY_TREE_SELECTION })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useCommands — 非损失性', () => {
  it('§2.3 里每个被降级的目的地都注册了一条命令', () => {
    render(<Host />)

    for (const id of [
      'settings-open',
      'settings-ssh',
      'settings-history',
      'settings-sync',
      'settings-strategy-doc',
      'settings-shortcuts',
    ]) {
      expect(byId(id).group).toBe(id === 'settings-ssh' || id === 'settings-history' ? 'navigate' : 'settings')
    }
  })

  it('工具栏 ⋯ 里的每一项都有同名命令', () => {
    render(<Host />)

    for (const id of [
      'action-edit-sources',
      'action-recompare-dirty',
      'action-expand-all',
      'action-toggle-view-mode',
      'action-toggle-hide-dot',
      'action-swap-sources',
      'action-copy-path-pair',
      'settings-strategy-doc',
    ]) {
      expect(byId(id)).toBeTruthy()
    }
  })

  it('同步菜单的五个动作都能从命令面板走一遍', () => {
    render(<Host />)

    for (const id of ['action-sync-right', 'action-sync-left', 'action-sync-pause', 'action-sync-resume', 'action-sync-clear']) {
      expect(byId(id).group).toBe('action')
    }
  })

  it('能力位关闭时对应命令消失', () => {
    installApiMock()
    window.api = {
      ...window.api,
      runtime: { ...window.api.runtime, supportsSftp: false, supportsSync: false, supportsHistory: false },
    } as unknown as Window['api']

    render(<Host />)

    const ids = latest.map((command) => command.id)
    expect(ids).not.toContain('settings-ssh')
    expect(ids).not.toContain('settings-sync')
    expect(ids).not.toContain('action-sync-right')
    expect(ids).toContain('settings-open')
  })
})

describe('useCommands — 分组与可用性', () => {
  it('只用 导航 · 操作 · 打开 · 设置 四个组', () => {
    render(<Host />)

    const groups = new Set(latest.map((command) => command.group))
    for (const group of groups) {
      expect(['navigate', 'action', 'open', 'settings']).toContain(group)
    }
  })

  it('不可用的命令带 disabledReason，不会变成死行', () => {
    render(<Host />)

    const pause = byId('action-pause-compare')
    expect(pause.disabled).toBe(true)
    expect(pause.disabledReason).toBe('当前没有正在跑的对比')

    const resume = byId('action-resume-compare')
    expect(resume.disabled).toBe(true)
    expect(resume.disabledReason).toBeTruthy()
  })

  it('对比跑起来后暂停可用、重启标题变成「重启对比」', () => {
    act(() => {
      useCompareStore.setState({ scanning: true, comparing: true, done: false })
    })
    render(<Host />)

    expect(byId('action-pause-compare').disabled).toBe(false)
    expect(byId('action-restart-compare').title).toBe('重启对比')
  })

  it('文本模式下对比相关命令带「先切到目录对比」而不是消失', () => {
    useAppStore.setState({ page: 'text' })
    render(<Host />)

    expect(byId('action-restart-compare').disabledReason).toBe('先切到目录对比')
    expect(byId('action-expand-all').disabled).toBe(true)
    // 导航命令本身当然还在。
    expect(byId('nav-compare').disabled).toBeFalsy()
  })

  it('保存命令只有在那一侧真的脏了才可用', () => {
    render(<Host />)
    expect(byId('action-save-left').disabledReason).toBe('先打开一个文件 Diff')

    cleanup()
    useAppStore.setState({
      diffTabs: [{
        id: 'src/app.ts',
        sessionId: 's1',
        relativePath: 'src/app.ts',
        fileName: 'app.ts',
        hasLeftFile: true,
        hasRightFile: true,
        leftSource: LEFT_SOURCE,
        rightSource: RIGHT_SOURCE,
        leftFullPath: '/var/left/src/app.ts',
        rightFullPath: '/var/right/src/app.ts',
        leftContent: 'changed',
        rightContent: 'same',
        originalLeftContent: 'original',
        originalRightContent: 'same',
        diffResult: null,
        loadError: null,
        loading: false,
      }],
      activeDiffTabId: 'src/app.ts',
    })
    render(<Host />)

    expect(byId('action-save-left').disabled).toBe(false)
    expect(byId('action-save-right').disabled).toBe(true)
  })
})

describe('useCommands — 打开组', () => {
  it('对比标签、文件 Diff 标签、最近对比都能直接打开', async () => {
    useAppStore.setState({
      compareTabs: [{
        id: 'tab-1',
        title: '本地:left ↔ 本地:right',
        snapshot: useCompareStore.getState().createTabSnapshot(),
        diffTabs: [],
        activeDiffTabId: null,
      }],
      activeCompareTabId: 'tab-1',
    })
    render(<Host />)

    expect(byId('open-compare-tab-tab-1').group).toBe('open')
    await waitFor(() => expect(byId('open-history-history-1').recentAt).toBe(HISTORY_ENTRY.timestamp))
  })

  it('面板没打开时不建注册表，也不去拉历史', () => {
    const api = installApiMock()
    render(<Host enabled={false} />)

    expect(latest).toEqual([])
    expect(api.listHistory).not.toHaveBeenCalled()
  })
})

describe('useCommands — 命令确实做事', () => {
  it('交换左右走的是工具栏那一个实现：结果作废，不偷偷重跑', () => {
    render(<Host />)

    act(() => void byId('action-swap-sources').perform())

    const state = useCompareStore.getState()
    expect(state.leftPath).toBe(RIGHT_SOURCE.path)
    expect(state.rightPath).toBe(LEFT_SOURCE.path)
    expect(window.api.runCompare).not.toHaveBeenCalled()
  })

  it('切换视图 / 隐藏点文件写的是同一份会话偏好', () => {
    render(<Host />)

    act(() => void byId('action-toggle-view-mode').perform())
    expect(useCompareStore.getState().viewMode).toBe('merged')

    act(() => void byId('action-toggle-hide-dot').perform())
    expect(useCompareStore.getState().hideDot).toBe(true)
  })

  it('会话过滤命令推开的是工具栏那个弹层', () => {
    render(<Host />)

    act(() => void byId('action-session-filter').perform())

    expect(useUIStore.getState().filterPopoverOpen).toBe(true)
  })

  it('对比策略说明落在共享的叠加层槽位上', () => {
    render(<Host />)

    act(() => void byId('settings-strategy-doc').perform())

    expect(useUIStore.getState().overlay).toBe('strategy-doc')
  })

  it('切换主题在三态之间循环，不会把 system 抹掉', async () => {
    const { useSettingsStore } = await import('../stores/settings-store')
    useSettingsStore.setState({ theme: 'system' })
    render(<Host />)

    act(() => void byId('action-cycle-theme').perform())
    expect(useSettingsStore.getState().theme).toBe('light')

    act(() => void byId('action-cycle-theme').perform())
    expect(useSettingsStore.getState().theme).toBe('dark')

    act(() => void byId('action-cycle-theme').perform())
    expect(useSettingsStore.getState().theme).toBe('system')
  })
})
