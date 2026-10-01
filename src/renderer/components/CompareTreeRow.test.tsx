// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CompareEntry } from '../../../shared/types'
import CompareTreeRow, { type CompareTreeRowProps } from './CompareTreeRow'

const entry: CompareEntry = {
  relativePath: 'report.txt', name: 'report.txt', isDirectory: false, state: 'left_only', reasons: [],
  left: { path: 'report.txt', name: 'report.txt', isDirectory: false, size: 1, mtime: 1 },
}
function props(): CompareTreeRowProps {
  return {
    node: { relativePath: entry.relativePath, name: entry.name, isDirectory: false, entry, depth: 0 },
    side: 'left', index: 0, setSize: 1, expanded: false, loading: false, dirty: false, selected: false, focused: true,
    onSelect: vi.fn(), onToggle: vi.fn(), onActivate: vi.fn(), buildActions: () => [],
  }
}
afterEach(() => cleanup())

describe('CompareTreeRow safe editing and accessible placeholders', () => {
  it('announces a missing file in each split tree with its filename and side', () => {
    render(<CompareTreeRow {...props()} side="right" />)
    const row = screen.getByRole('treeitem', { name: 'report.txt，右侧不存在，仅在左侧' })
    expect(row.getAttribute('aria-hidden')).toBeNull()
    expect(row.getAttribute('aria-posinset')).toBe('1')
    expect(row.tabIndex).toBe(0)
  })

  it('requires Enter or the confirmation button to rename and does not submit on blur', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    const activate = vi.fn()
    render(<CompareTreeRow {...props()} onActivate={activate} renaming renameValue="renamed.txt" onRenameSubmit={submit} onRenameCancel={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: '重命名 report.txt' })
    fireEvent.blur(input)
    expect(submit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '确认重命名 report.txt' }))
    expect(submit).toHaveBeenCalledTimes(2)
    screen.getByRole('button', { name: '确认重命名 report.txt' }).focus()
    await user.keyboard('{Enter}')
    expect(submit).toHaveBeenCalledTimes(3)
    expect(activate).not.toHaveBeenCalled()
  })

  it('cancels on Escape or the cancel button without saving', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()
    const cancel = vi.fn()
    render(<CompareTreeRow {...props()} renaming renameValue="renamed.txt" onRenameSubmit={submit} onRenameCancel={cancel} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    await user.click(screen.getByRole('button', { name: '取消重命名 report.txt' }))
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(submit).not.toHaveBeenCalled()
  })

  it('identifies symbolic links and a type mismatch without offering directory expansion', () => {
    const rowProps = props()
    render(<CompareTreeRow {...rowProps} side="merged" node={{ ...rowProps.node, entry: {
      ...entry, state: 'different', left: { ...entry.left!, isSymlink: true }, right: { ...entry.left!, isDirectory: true },
      reasons: [{ type: 'type', leftType: 'symlink', rightType: 'directory' }],
    } }} />)
    const row = screen.getByRole('treeitem', { name: /左侧符号链接.*类型不同：左侧符号链接，右侧目录/ })
    expect(row.getAttribute('aria-expanded')).toBeNull()
    expect(screen.getByText('（链接）')).toBeTruthy()
  })
})
