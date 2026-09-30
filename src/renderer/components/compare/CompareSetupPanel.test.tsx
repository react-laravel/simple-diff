// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useAppStore } from '../../stores/app-store'
import { useCompareStore } from '../../stores/compare-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useSSHStore } from '../../stores/ssh-store'
import { useUIStore } from '../../stores/ui-store'
import { diffFixture } from '../../test-utils/diff-fixture'
import UnsavedChangesDialog from '../overlays/UnsavedChangesDialog'
import CompareSetupDialog from './CompareSetupDialog'
import CompareSetupPanel from './CompareSetupPanel'

const { runCompare, rerunActiveSessionIfRunning } = vi.hoisted(() => ({
  runCompare: vi.fn<(...args: unknown[]) => Promise<void>>(),
  rerunActiveSessionIfRunning: vi.fn(),
}))
vi.mock('../../hooks/useCompare', () => ({
  useCompareActions: () => ({ runCompare, rerunActiveSessionIfRunning }),
}))

beforeEach(() => {
  runCompare.mockReset().mockResolvedValue(undefined)
  rerunActiveSessionIfRunning.mockReset().mockResolvedValue(false)
  useCompareStore.setState({ ...useCompareStore.getInitialState(), leftPath: '/left', rightPath: '/right' })
  useAppStore.setState(useAppStore.getInitialState())
  useUIStore.setState(useUIStore.getInitialState())
  useSettingsStore.setState({ globalPathFilters: [] })
  useSSHStore.setState({ configs: [], loading: false, loadConfigs: async () => undefined })
  window.api = { selectFolder: vi.fn().mockResolvedValue({ success: true, data: '/picked' }) } as unknown as Window['api']
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function pressEnter(target: Element | Window = document.body, init: KeyboardEventInit = {}) {
  await act(async () => { fireEvent.keyDown(target, { key: 'Enter', ...init }) })
}

const ignoredKeys: [string, KeyboardEventInit][] = [
  ['IME composition', { isComposing: true }],
  ['WebKit IME confirmation', { keyCode: 229 }],
  ['held Enter', { repeat: true }],
  ['Shift+Enter', { shiftKey: true }],
  ['Ctrl+Enter', { ctrlKey: true }],
  ['Command+Enter', { metaKey: true }],
  ['Alt+Enter', { altKey: true }],
  ['another key', { key: ' ' }],
]

describe('setup Enter shortcut', () => {
  it('starts once with complete inputs and no focused control', async () => {
    render(<CompareSetupPanel />)
    expect(document.activeElement).toBe(document.body)
    await pressEnter()
    expect(runCompare).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('starts from non-interactive panel content', async () => {
    render(<CompareSetupPanel />)
    await pressEnter(screen.getByText('按 Enter 直接开始'))
    expect(runCompare).toHaveBeenCalledTimes(1)
  })

  it.each(['左侧路径', '右侧路径'])('still starts exactly once from %s', async (label) => {
    render(<CompareSetupPanel />)
    await pressEnter(screen.getByRole('textbox', { name: label }))
    expect(runCompare).toHaveBeenCalledTimes(1)
  })

  it.each(ignoredKeys)('does not submit on %s from the page or paths', async (_, init) => {
    render(<CompareSetupPanel />)
    await pressEnter(document.body, init)
    await pressEnter(screen.getByRole('textbox', { name: '左侧路径' }), init)
    await pressEnter(screen.getByRole('textbox', { name: '右侧路径' }), init)
    expect(runCompare).not.toHaveBeenCalled()
  })

  it('leaves an already handled Enter alone', () => {
    render(<CompareSetupPanel />)
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    event.preventDefault()
    fireEvent(document.body, event)
    expect(runCompare).not.toHaveBeenCalled()
  })

  it.each([
    { leftPath: '' }, { rightPath: '' }, { strategies: [] }, { scanning: true }, { comparing: true },
  ])('matches the button disabled state: %j', async (state) => {
    useCompareStore.setState(state)
    render(<CompareSetupPanel />)
    expect((screen.getByRole('button', { name: '开始对比' }) as HTMLButtonElement).disabled).toBe(true)
    await pressEnter()
    await pressEnter(screen.getByRole('textbox', { name: '右侧路径' }))
    expect(runCompare).not.toHaveBeenCalled()
  })

  it('reads the current store even before React rerenders', async () => {
    render(<CompareSetupPanel />)
    await act(async () => {
      useCompareStore.setState({ scanning: true })
      fireEvent.keyDown(document.body, { key: 'Enter' })
    })
    expect(runCompare).not.toHaveBeenCalled()
  })

  it('does not duplicate an in-flight start; a finished attempt can be retried', async () => {
    let finish!: () => void
    runCompare.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<CompareSetupPanel />)
    await pressEnter()
    await pressEnter()
    await pressEnter(screen.getByRole('textbox', { name: '右侧路径' }))
    fireEvent.click(screen.getByRole('button', { name: '开始对比' }))
    expect(runCompare).toHaveBeenCalledTimes(1)
    await act(async () => { finish() })
    await pressEnter()
    expect(runCompare).toHaveBeenCalledTimes(2)
  })

  it('keeps focused buttons working normally, including the primary action', async () => {
    const user = userEvent.setup()
    render(<CompareSetupPanel />)
    screen.getByRole('button', { name: '交换左右' }).focus()
    await user.keyboard('{Enter}')
    expect(useCompareStore.getState().leftPath).toBe('/right')
    expect(runCompare).not.toHaveBeenCalled()
    screen.getAllByRole('button', { name: '浏览...' })[0].focus()
    await user.keyboard('{Enter}')
    expect(window.api.selectFolder).toHaveBeenCalledTimes(1)
    expect(runCompare).not.toHaveBeenCalled()
    screen.getByRole('button', { name: '开始对比' }).focus()
    await user.keyboard('{Enter}')
    expect(runCompare).toHaveBeenCalledTimes(1)
  })

  it('does not treat repeated or composing Enter on the start button as clicks', async () => {
    render(<CompareSetupPanel />)
    for (const [, init] of ignoredKeys.filter(([, init]) => init.key === undefined)) {
      const allowed = fireEvent.keyDown(screen.getByRole('button', { name: '开始对比' }), { key: 'Enter', ...init })
      expect(allowed).toBe(false)
    }
    expect(runCompare).not.toHaveBeenCalled()
  })

  it('does not hijack inputs, editable descendants, selects, links or controls elsewhere', async () => {
    render(<><CompareSetupPanel /><input aria-label="Other input" /><textarea aria-label="Other editor" />
      <select aria-label="Other select"><option>A</option></select>
      <div contentEditable suppressContentEditableWarning><span>Editable child</span></div>
      <a href="#other">Other link</a><div tabIndex={0}>Other control</div></>)
    for (const target of [screen.getByLabelText('Other input'), screen.getByLabelText('Other editor'),
      screen.getByLabelText('Other select'), screen.getByText('Editable child'), screen.getByText('Other link'),
      screen.getByText('Other control')]) await pressEnter(target)
    expect(runCompare).not.toHaveBeenCalled()
  })

  it('retains multiline filter editing and blocks starts behind the popover', async () => {
    const user = userEvent.setup()
    render(<CompareSetupPanel />)
    await user.click(screen.getByRole('button', { name: '编辑过滤…' }))
    const filter = screen.getByRole('textbox', { name: '排除目录或路径' })
    await user.clear(filter)
    await user.type(filter, 'node_modules{Enter}dist')
    expect((filter as HTMLTextAreaElement).value).toBe('node_modules\ndist')
    await pressEnter()
    expect(runCompare).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await user.click(screen.getByText('按 Enter 直接开始'))
    await user.keyboard('{Enter}')
    expect(runCompare).toHaveBeenCalledTimes(1)
  })

  it('does not start behind a local strategy dialog and resumes after dismissal', async () => {
    const user = userEvent.setup()
    render(<CompareSetupPanel />)
    await user.click(screen.getByRole('button', { name: '策略说明…' }))
    await pressEnter()
    await pressEnter(screen.getByText('文件大小', { selector: 'div' }))
    expect(runCompare).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await pressEnter()
    expect(runCompare).toHaveBeenCalledTimes(1)
  })

  it.each(['settings', 'history', 'ssh', 'palette', 'sync', 'compare-setup'] as const)(
    'does not run the background page behind the %s overlay', async (overlay) => {
      render(<CompareSetupPanel />)
      act(() => useUIStore.getState().openOverlay(overlay))
      await pressEnter()
      expect(runCompare).not.toHaveBeenCalled()
    },
  )

  it('removes the listener when leaving setup', async () => {
    const view = render(<CompareSetupPanel />)
    view.unmount()
    await pressEnter()
    expect(runCompare).not.toHaveBeenCalled()
  })
})

describe('edit-source Enter shortcut', () => {
  it('only submits the foreground dialog when a setup page is also mounted', async () => {
    useUIStore.setState({ overlay: 'compare-setup' })
    const onOpenChange = vi.fn()
    render(<><CompareSetupPanel /><CompareSetupDialog open onOpenChange={onOpenChange} /></>)
    await pressEnter()
    expect(runCompare).toHaveBeenCalledExactlyOnceWith({ reuseActiveSession: true })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps dirty drafts on cancellation and allows a later confirmed retry', async () => {
    const draft = diffFixture({ rightContent: 'edited' })
    useAppStore.setState({ activeCompareTabId: 'a', diffTabs: [draft] })
    useUIStore.setState({ overlay: 'compare-setup' })
    const onSubmitted = vi.fn()
    render(<><CompareSetupPanel variant="dialog" onSubmitted={onSubmitted} /><UnsavedChangesDialog /></>)
    await pressEnter(screen.getByRole('textbox', { name: '右侧路径' }))
    await pressEnter()
    await pressEnter(screen.getByRole('textbox', { name: '右侧路径' }))
    expect(runCompare).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    expect(useAppStore.getState().diffTabs).toEqual([draft])
    expect(onSubmitted).not.toHaveBeenCalled()
    await pressEnter(screen.getByRole('textbox', { name: '右侧路径' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '放弃修改并继续' })) })
    expect(runCompare).toHaveBeenCalledExactlyOnceWith({ reuseActiveSession: true })
    expect(onSubmitted).toHaveBeenCalledTimes(1)
  })

  it.each(['unmount', 'navigate'] as const)('does not resume a pending confirmation after %s', async (action) => {
    const draft = diffFixture({ rightContent: 'edited' })
    useAppStore.setState({ activeCompareTabId: 'a', diffTabs: [draft] })
    const onSubmitted = vi.fn()
    const view = render(<CompareSetupPanel variant="dialog" onSubmitted={onSubmitted} />)
    await pressEnter()
    const pending = useUIStore.getState().pendingUnsavedChanges!
    if (action === 'unmount') view.unmount()
    else act(() => useAppStore.setState({ activeCompareTabId: 'b' }))
    await act(async () => {
      useUIStore.setState({ pendingUnsavedChanges: null })
      pending.resolve(true)
    })
    expect(runCompare).not.toHaveBeenCalled()
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(useAppStore.getState().diffTabs).toEqual([draft])
  })
})
