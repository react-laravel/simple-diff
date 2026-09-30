// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { createMockApi } from '../runtime/mock-api'
import { useAppStore, migratePersistedAppState } from '../stores/app-store'
import { useCompareStore } from '../stores/compare-store'
import { useTextDiffStore } from '../stores/text-diff-store'
import { useSSHStore } from '../stores/ssh-store'
import { useUIStore } from '../stores/ui-store'
import { useLogStore } from '../stores/log-store'
import { diffFixture } from '../test-utils/diff-fixture'

const config = { id: 'dev', label: 'Development', host: 'dev.example.test', port: 22, username: 'dev', authType: 'password' as const }
const history = {
  id: 'recent', timestamp: 1, duration: 1, strategies: ['size' as const],
  leftLabel: '/history-left', rightLabel: '/history-right',
  leftSource: { type: 'local' as const, path: '/history-left' },
  rightSource: { type: 'local' as const, path: '/history-right' },
  stats: { total: 0, equal: 0, different: 0, leftOnly: 0, rightOnly: 0 },
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  window.api = {
    ...createMockApi(),
    getSyncStatus: vi.fn().mockResolvedValue({ success: true, data: null }),
    listSSHConfigs: vi.fn().mockResolvedValue({ success: true, data: [config] }),
    listHistory: vi.fn().mockResolvedValue({ success: true, data: [history] }),
    runCompare: vi.fn().mockResolvedValue({ success: true, data: { entries: [], stats: history.stats, duration: 1 } }),
  }
  useAppStore.setState(useAppStore.getInitialState())
  useCompareStore.setState({ ...useCompareStore.getInitialState(), leftPath: '/left', rightPath: '/right' })
  useTextDiffStore.setState(useTextDiffStore.getInitialState())
  useUIStore.setState(useUIStore.getInitialState())
  useLogStore.setState({ logs: [], visible: false })
  useSSHStore.setState(useSSHStore.getInitialState())
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function selectedTab(name: string) {
  const tab = screen.getByRole('tab', { name })
  for (const item of within(screen.getByRole('tablist', { name: '视图模式' })).getAllByRole('tab')) {
    expect(document.getElementById(item.getAttribute('aria-controls')!)).toBeTruthy()
  }
  expect(tab.getAttribute('aria-selected')).toBe('true')
  expect(tab.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id)
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab.id)
}

describe('management tabs', () => {
  it('shows the existing SSH manager as a real page and keeps edit/cancel functional', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'SSH 管理' }))
    selectedTab('SSH 管理')
    expect(screen.getByRole('heading', { name: 'SSH 连接管理' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('dev@dev.example.test:22')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByDisplayValue('Development')).toBeTruthy()
    expect((screen.getByLabelText('密码') as HTMLInputElement).type).toBe('password')
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('keeps SSH deletion confirmation modal and cancellable inside its page', async () => {
    const user = userEvent.setup()
    const remove = vi.spyOn(window.api, 'deleteSSHConfig')
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'SSH 管理' }))
    await user.click(await screen.findByRole('button', { name: '删除 Development' }))
    expect(screen.getByRole('dialog', { name: '删除这个 SSH 连接？' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    selectedTab('SSH 管理')
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText('dev@dev.example.test:22')).toBeTruthy()
  })

  it('retains the contextual SSH dialog and returns to the directory setup after Escape', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getAllByRole('button', { name: 'SFTP' })[0])
    await user.click(screen.getByRole('button', { name: '管理连接…' }))
    expect(screen.getByRole('dialog', { name: 'SSH 连接管理' })).toBeTruthy()
    selectedTab('目录对比')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    selectedTab('目录对比')
    expect(screen.getByRole('textbox', { name: '左侧路径' })).toBeTruthy()
  })

  it('supports arrow-key navigation and Enter/Space activation without starting comparison', async () => {
    const user = userEvent.setup()
    render(<App />)
    screen.getByRole('tab', { name: '目录对比' }).focus()
    await user.keyboard('{ArrowRight}{Space}{ArrowRight}{Enter}')
    selectedTab('SSH 管理')
    expect(window.api.runCompare).not.toHaveBeenCalled()
    await user.keyboard('{End}{Enter}')
    selectedTab('对比历史')
    await user.keyboard('{Home}{Enter}')
    selectedTab('目录对比')
    expect(window.api.runCompare).not.toHaveBeenCalled()
  })

  it('menu and command-palette entries navigate to the same management tabs', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '应用菜单' }))
    await user.click(screen.getByRole('menuitem', { name: /SSH 连接管理/ }))
    selectedTab('SSH 管理')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.keyboard('{Meta>}k{/Meta}')
    await user.click(screen.getByRole('option', { name: /^对比历史/ }))
    selectedTab('对比历史')
    expect(useUIStore.getState().overlay).toBeNull()
  })

  it('history row Enter opens one new comparison and selects its tab', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: '对比历史' }))
    const table = await screen.findByRole('table', { name: '对比历史列表' })
    within(table).getAllByRole('row')[1].focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(window.api.runCompare).toHaveBeenCalledTimes(1))
    selectedTab('目录对比')
    expect(useCompareStore.getState().leftPath).toBe('/history-left')
    expect(useAppStore.getState().compareTabs).toHaveLength(1)
  })

  it('switching to management and back preserves directory inputs and text drafts', async () => {
    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: '左侧路径' }), { target: { value: '/draft-left' } })
    await user.click(screen.getByRole('tab', { name: 'SSH 管理' }))
    await user.click(screen.getByRole('tab', { name: '目录对比' }))
    expect(screen.getByDisplayValue('/draft-left')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: '文本对比' }))
    act(() => useTextDiffStore.getState().setLeftText('unsaved text'))
    await user.click(screen.getByRole('tab', { name: '对比历史' }))
    await user.click(screen.getByRole('tab', { name: '文本对比' }))
    expect(useTextDiffStore.getState().leftText).toBe('unsaved text')
  })

  it('preserves dirty file drafts and the live comparison when returning from management', async () => {
    const draft = diffFixture({ rightContent: 'edited' })
    useCompareStore.setState({ done: true, leftSource: draft.leftSource, rightSource: draft.rightSource })
    const snapshot = useCompareStore.getState().createTabSnapshot()
    useAppStore.setState({ activeCompareTabId: 'session', diffTabs: [draft], activeDiffTabId: null,
      compareTabs: [{ id: 'session', title: 'Working comparison', snapshot, diffTabs: [draft], activeDiffTabId: null }] })
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('tab', { name: 'SSH 管理' }))
    await user.click(screen.getByRole('tab', { name: '对比历史' }))
    await user.click(screen.getByRole('tab', { name: '目录对比' }))
    expect(useAppStore.getState().activeCompareTabId).toBe('session')
    expect(useAppStore.getState().diffTabs[0].rightContent).toBe('edited')
    expect(useCompareStore.getState().done).toBe(true)
  })

  it.each(['ssh', 'history'] as const)('restores a persisted %s page without forcing directory comparison', async (page) => {
    useAppStore.setState({ page, activeCompareTabId: 'session', compareTabs: [{ id: 'session', title: 'Old comparison',
      snapshot: useCompareStore.getState().createTabSnapshot(), diffTabs: [], activeDiffTabId: null }] })
    render(<App />)
    await waitFor(() => expect(useAppStore.getState().page).toBe(page))
    selectedTab(page === 'ssh' ? 'SSH 管理' : '对比历史')
    expect(migratePersistedAppState({ page }).page).toBe(page)
  })

  it('hides unsupported tabs and safely falls back from a previously saved one', async () => {
    window.api = { ...window.api, runtime: { ...window.api.runtime, supportsSftp: false, supportsHistory: false } }
    useAppStore.setState({ page: 'ssh' })
    render(<App />)
    await waitFor(() => expect(useAppStore.getState().page).toBe('compare'))
    expect(screen.queryByRole('tab', { name: 'SSH 管理' })).toBeNull()
    expect(screen.queryByRole('tab', { name: '对比历史' })).toBeNull()
    selectedTab('目录对比')
  })

  it('Enter from empty setup space starts the real compare action exactly once', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByText('按 Enter 直接开始'))
    await user.keyboard('{Enter}')
    expect(window.api.runCompare).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().compareTabs).toHaveLength(1)
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Enter' }) })
    expect(window.api.runCompare).toHaveBeenCalledTimes(1)
  })
})
