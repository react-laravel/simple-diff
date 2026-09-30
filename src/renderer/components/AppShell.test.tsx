// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppShell from './AppShell'
import { useAppStore } from '../stores/app-store'
import { useCompareStore } from '../stores/compare-store'
import { useLogStore } from '../stores/log-store'
import { useSettingsStore } from '../stores/settings-store'
import { EMPTY_TREE_SELECTION, useUIStore } from '../stores/ui-store'

function installApiMock() {
  window.api = {
    runtime: {
      mode: 'tauri',
      supportsSftp: true,
      supportsHistory: true,
      supportsSync: true,
      supportsNativeFolderSelection: true,
      supportsDirectoryDragDrop: true,
      supportsWriteBack: true,
    },
    onLog: vi.fn(() => () => undefined),
    listSSHConfigs: vi.fn(async () => ({ success: true, data: [] })),
    listHistory: vi.fn(async () => ({ success: true, data: [] })),
  } as unknown as Window['api']
}

beforeEach(() => {
  // jsdom 没有实现 scrollIntoView，命令面板的键盘导航会用到。
  Element.prototype.scrollIntoView = vi.fn()
  installApiMock()
  useAppStore.setState({ page: 'compare', compareTabs: [], activeCompareTabId: null, diffTabs: [], activeDiffTabId: null })
  useCompareStore.setState({ scanning: false, comparing: false, paused: false, done: false, syncTask: null, entries: [] })
  useLogStore.setState({ logs: [], visible: false })
  useUIStore.setState({ overlay: null, treeSelection: EMPTY_TREE_SELECTION })
  useSettingsStore.setState({ theme: 'system' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AppShell 顶栏', () => {
  it('直接暴露目录、文本、SSH 管理和历史四个页签', () => {
    render(<AppShell>内容</AppShell>)

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['目录对比', '文本对比', 'SSH 管理', '对比历史'])
  })

  it('切到文本对比只改 page，不销毁对比会话', async () => {
    useCompareStore.setState({ entries: [], done: true })
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.click(screen.getByRole('tab', { name: '文本对比' }))

    expect(useAppStore.getState().page).toBe('text')
    expect(useCompareStore.getState().done).toBe(true)
  })

  it('从文本模式切回目录对比不会强开日志面板', async () => {
    useAppStore.setState({ page: 'text' })
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.click(screen.getByRole('tab', { name: '目录对比' }))

    expect(useAppStore.getState().page).toBe('compare')
    expect(useLogStore.getState().visible).toBe(false)
  })
})

describe('AppShell 应用菜单', () => {
  it('承载了被降级的四个目的地加快捷键与主题', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.click(screen.getByRole('button', { name: '应用菜单' }))

    for (const label of [/设置/, /对比历史/, /SSH 连接管理/, /同步任务/, /快捷键/, /日志面板/]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy()
    }
  })

  it('能力位关闭时对应菜单项消失', async () => {
    installApiMock()
    window.api = {
      ...window.api,
      runtime: { ...window.api.runtime, supportsSftp: false, supportsSync: false },
    } as unknown as Window['api']

    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)
    await user.click(screen.getByRole('button', { name: '应用菜单' }))

    expect(screen.queryByRole('menuitem', { name: /SSH 连接管理/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /同步任务/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /对比历史/ })).toBeTruthy()
  })

  it('主题子菜单保留三态，system 不会被抹掉', async () => {
    useSettingsStore.setState({ theme: 'dark' })
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.click(screen.getByRole('button', { name: '应用菜单' }))
    await user.click(screen.getByRole('menuitem', { name: '主题' }))

    const followSystem = await screen.findByRole('menuitemcheckbox', { name: '跟随系统' })
    expect(screen.getByRole('menuitemcheckbox', { name: '深色' }).getAttribute('aria-checked')).toBe('true')

    await user.click(followSystem)
    expect(useSettingsStore.getState().theme).toBe('system')
  })

  it('主题偏好写到 <html data-theme> 上', () => {
    useSettingsStore.setState({ theme: 'light' })
    render(<AppShell>内容</AppShell>)

    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('AppShell 快捷键', () => {
  it('⌘K 打开命令面板（打开而非切换），Esc 关闭', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('{Meta>}k{/Meta}')
    expect(useUIStore.getState().overlay).toBe('palette')

    await user.keyboard('{Meta>}k{/Meta}')
    expect(useUIStore.getState().overlay).toBe('palette')

    await user.keyboard('{Escape}')
    expect(useUIStore.getState().overlay).toBeNull()
  })

  it('⌘, 打开设置，⌘J 切换日志面板', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('{Meta>},{/Meta}')
    expect(useUIStore.getState().overlay).toBe('settings')

    await user.keyboard('{Meta>}j{/Meta}')
    expect(useLogStore.getState().visible).toBe(true)
  })

  it('? 打开快捷键帮助', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('?')
    expect(useUIStore.getState().overlay).toBe('shortcuts')
  })
})

describe('AppShell 模式切换不销毁对比上下文', () => {
  function seedActiveCompareTab() {
    const snapshot = useCompareStore.getState().createTabSnapshot()
    useAppStore.setState({
      compareTabs: [{
        id: 'compare-tab-1',
        title: 'left ↔ right',
        // 对比完成后写回标签的是不含 entries 的轻量快照。
        snapshot: { ...snapshot, entries: [], leftSource: { type: 'local', path: '/left' } },
        diffTabs: [],
        activeDiffTabId: null,
      }],
      activeCompareTabId: 'compare-tab-1',
    })
  }

  it('离开对比模式时把 live 会话写回它自己的标签', async () => {
    useCompareStore.setState({
      done: true,
      leftPath: '/left',
      rightPath: '/right',
      leftSource: { type: 'local', path: '/left' },
      rightSource: { type: 'local', path: '/right' },
    })
    seedActiveCompareTab()

    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.click(screen.getByRole('tab', { name: '文本对比' }))

    expect(useAppStore.getState().compareTabs[0]?.snapshot.rightSource).toEqual({ type: 'local', path: '/right' })
  })

  it('切回目录对比不会用轻量快照把结果树清空', async () => {
    useCompareStore.setState({
      done: true,
      leftSource: { type: 'local', path: '/left' },
      rightSource: { type: 'local', path: '/right' },
    })
    seedActiveCompareTab()
    useAppStore.setState({ page: 'text' })

    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.click(screen.getByRole('tab', { name: '目录对比' }))

    expect(useAppStore.getState().page).toBe('compare')
    expect(useCompareStore.getState().rightSource).toEqual({ type: 'local', path: '/right' })
  })

  it('setup 态切回目录对比不会被顶成最后一个旧标签', async () => {
    seedActiveCompareTab()
    useAppStore.setState({ page: 'text', activeCompareTabId: null })
    useCompareStore.setState({ leftPath: '/drafting', leftSource: null, rightSource: null, done: false })

    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.click(screen.getByRole('tab', { name: '目录对比' }))

    expect(useAppStore.getState().activeCompareTabId).toBeNull()
    expect(useCompareStore.getState().leftPath).toBe('/drafting')
  })
})

describe('AppShell 命令面板', () => {
  // chunk 9：面板换成共享的 `ui/CommandPalette`，行是 `role="option"`（listbox 语义），
  // 不再是裸 button；分组顺序固定为 导航 · 操作 · 打开 · 设置。
  it('命令打开的叠加层不会被面板自己的关闭动作一起关掉', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('{Meta>}k{/Meta}')
    await user.click(screen.getByRole('option', { name: /^设置/ }))

    expect(useUIStore.getState().overlay).toBe('settings')
  })

  it('编辑数据源在 ⌘K 里有入口', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('{Meta>}k{/Meta}')
    await user.click(screen.getByRole('option', { name: /^编辑数据源/ }))

    expect(useUIStore.getState().overlay).toBe('compare-setup')
  })

  it('按 DESIGN-SYSTEM §9 规则 1 收录了每一个被降级的目的地', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('{Meta>}k{/Meta}')

    for (const label of [/^设置/, /^SSH 连接管理/, /^对比历史/, /^同步任务/, /^对比策略说明/, /^快捷键/]) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy()
    }
  })

  it('分组按 导航 · 操作 · 打开 · 设置 的固定顺序渲染', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('{Meta>}k{/Meta}')
    const groups = screen.getAllByText(/^(导航|操作|打开|设置)$/).map((node) => node.textContent)

    expect(groups).toEqual(['导航', '操作', '设置'])
  })

  it('不可用的命令带原因，而不是变成一行点了没反应的死行', async () => {
    const user = userEvent.setup()
    render(<AppShell>内容</AppShell>)

    await user.keyboard('{Meta>}k{/Meta}')
    const pause = screen.getByRole('option', { name: /^暂停对比/ })
    expect(pause.getAttribute('aria-disabled')).toBe('true')

    await user.click(pause)
    expect(screen.getByText('当前没有正在跑的对比')).toBeTruthy()
    // 叠加层没有被关掉，用户还站在面板里。
    expect(useUIStore.getState().overlay).toBe('palette')
  })
})

describe('AppShell 日志', () => {
  it('折叠时日志面板不渲染任何 chrome', () => {
    useLogStore.setState({ logs: [], visible: false })
    render(<AppShell>内容</AppShell>)

    expect(screen.queryByText('暂无日志')).toBeNull()
    expect(screen.queryByRole('group', { name: '日志范围' })).toBeNull()
  })

  it('展开后才出现范围过滤与清除', () => {
    useLogStore.setState({ logs: [], visible: true })
    render(<AppShell>内容</AppShell>)

    expect(screen.getByRole('group', { name: '日志范围' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '清除' })).toBeTruthy()
  })

  it('后端日志订阅在面板折叠时依然存在', () => {
    render(<AppShell>内容</AppShell>)
    expect(window.api.onLog).toHaveBeenCalledTimes(1)
  })
})
