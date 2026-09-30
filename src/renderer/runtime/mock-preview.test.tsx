// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { useCompareStore } from '../stores/compare-store'
import { bindCompareEvents, flushBufferedCompareEvents } from '../utils/compare-events'
import { ensureAppApi } from './ensure-app-api'
import { MOCK_LEFT_ROOT, MOCK_LEFT_SOURCE, MOCK_RIGHT_SOURCE } from './mock-fixtures'
import { createMockCompareEntries } from './mock-tree'

/**
 * 浏览器预览的冒烟测试：只要 `window.api` 由 mock 提供，
 * 真实的 App 就应该能挂载（这正是 `npm run dev:ui` 需要成立的前提）。
 */

afterEach(() => {
  cleanup()
})

describe('浏览器预览冒烟', () => {
  it('mock api 就位后 App 可以渲染四个页签与应用菜单', async () => {
    const api = await ensureAppApi()
    expect(api.runtime.mode).toBe('web')

    const user = userEvent.setup()
    render(<App />)

    // 顶层导航从 7 个槽位收敛到 2 个模式（设计蓝图 §2.1）
    expect(screen.getAllByText('目录对比').length).toBeGreaterThan(0)
    expect(screen.getByText('文本对比')).toBeDefined()
    expect(screen.getByRole('tab', { name: 'SSH 管理' })).toBeDefined()
    expect(screen.getByRole('tab', { name: '对比历史' })).toBeDefined()

    // SFTP / 历史 / 同步能力位为 true，对应入口降级到 `⋯` 应用菜单里
    await user.click(screen.getByRole('button', { name: '应用菜单' }))

    expect(await screen.findByRole('menuitem', { name: /SSH 连接管理/ })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /对比历史/ })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /同步任务/ })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /设置/ })).toBeDefined()
  })

  it('mock 的同步任务快照会回填两侧源路径', async () => {
    await ensureAppApi()
    render(<App />)

    expect(await screen.findByDisplayValue(MOCK_LEFT_ROOT)).toBeDefined()
  })

  it('mock 的流式事件会真正填充 compare store', async () => {
    const api = await ensureAppApi()
    const unbind = bindCompareEvents(api)

    useCompareStore.getState().startScanning('preview-compare')
    const result = await api.runCompare({
      compareId: 'preview-compare',
      left: MOCK_LEFT_SOURCE,
      right: MOCK_RIGHT_SOURCE,
      strategies: ['size', 'mtime'],
    })
    flushBufferedCompareEvents('preview-compare')

    const summary = useCompareStore.getState().entrySummary
    expect(result.success).toBe(true)
    expect(summary.stats.total).toBe(createMockCompareEntries().length)
    expect(summary.stats.different).toBeGreaterThan(0)
    expect(summary.stats.leftOnly).toBeGreaterThan(0)
    expect(summary.stats.rightOnly).toBeGreaterThan(0)
    expect(summary.stats.equal).toBeGreaterThan(0)
    // 「待比」桶：固定数据里保留了若干未定型条目
    expect(summary.pendingCount).toBeGreaterThan(0)

    unbind()
  }, 10_000)
})
