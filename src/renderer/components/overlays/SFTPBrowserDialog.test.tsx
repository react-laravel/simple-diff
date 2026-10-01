// @vitest-environment jsdom

import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IpcResult, SSHBrowseResult } from '../../../../shared/types'
import SFTPBrowserDialog from './SFTPBrowserDialog'

const ROOT = '/var/www'
function result(path = ROOT, entries: SSHBrowseResult['entries'] = []): IpcResult<SSHBrowseResult> {
  return { success: true, data: { path, rootPath: ROOT, entries } }
}
function renderBrowser(onSelect = vi.fn(), initialPath = ROOT) {
  return render(<SFTPBrowserDialog open onOpenChange={vi.fn()} sshConfigId="server" initialPath={initialPath} onSelect={onSelect} sideLabel="左侧" />)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SFTPBrowserDialog navigation safety', () => {
  it('displays and selects only the path returned by the server, including an empty directory', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    window.api = { browseSSH: vi.fn(async () => result('/var/www/canonical')) } as unknown as Window['api']
    renderBrowser(onSelect, 'canonical')
    await waitFor(() => expect((screen.getByRole('button', { name: '选择当前目录' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTitle('/var/www/canonical')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '选择当前目录' }))
    expect(onSelect).toHaveBeenCalledWith('/var/www/canonical')
  })

  it('does not navigate above the configured root or expose symlink targets as folders', async () => {
    window.api = { browseSSH: vi.fn(async () => result(ROOT, [
      { name: 'real', path: `${ROOT}/real`, isDirectory: true, size: 0, mtime: 1 },
      { name: 'outside', path: `${ROOT}/outside`, isDirectory: true, isSymlink: true, size: 0, mtime: 1 },
    ])) } as unknown as Window['api']
    renderBrowser()
    await screen.findByRole('button', { name: 'real/进入' })
    expect((screen.getByRole('button', { name: '上一级' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'outside/进入' })).toBeNull()
  })

  it('disables selection after a failed refresh and clears old entries', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const browseSSH = vi.fn().mockResolvedValueOnce(result(ROOT, [
      { name: 'child', path: `${ROOT}/child`, isDirectory: true, size: 0, mtime: 1 },
    ])).mockResolvedValueOnce({ success: false, error: '权限不足' })
    window.api = { browseSSH } as unknown as Window['api']
    renderBrowser(onSelect)
    await screen.findByRole('button', { name: 'child/进入' })
    await user.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText('无法读取远程目录')
    expect(screen.queryByRole('button', { name: 'child/进入' })).toBeNull()
    expect((screen.getByRole('button', { name: '选择当前目录' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '选择当前目录' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('ignores responses from an earlier opening', async () => {
    let resolveOld!: (value: IpcResult<SSHBrowseResult>) => void
    const browseSSH = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve })).mockResolvedValueOnce(result(`${ROOT}/new`))
    window.api = { browseSSH } as unknown as Window['api']
    const props = { onOpenChange: vi.fn(), sshConfigId: 'server', initialPath: ROOT, onSelect: vi.fn(), sideLabel: '左侧' }
    const view = render(<SFTPBrowserDialog {...props} open />)
    view.rerender(<SFTPBrowserDialog {...props} open={false} />)
    view.rerender(<SFTPBrowserDialog {...props} initialPath={`${ROOT}/new`} open />)
    await screen.findByTitle(`${ROOT}/new`)
    await act(async () => { resolveOld(result(`${ROOT}/old`)) })
    expect(screen.queryByTitle(`${ROOT}/old`)).toBeNull()
    expect(screen.getByTitle(`${ROOT}/new`)).toBeTruthy()
  })

  it('loads under React StrictMode after effect cleanup', async () => {
    window.api = { browseSSH: vi.fn(async () => result()) } as unknown as Window['api']
    render(<StrictMode><SFTPBrowserDialog open onOpenChange={vi.fn()} sshConfigId="server" initialPath={ROOT} onSelect={vi.fn()} sideLabel="左侧" /></StrictMode>)
    await waitFor(() => expect((screen.getByRole('button', { name: '选择当前目录' }) as HTMLButtonElement).disabled).toBe(false))
  })
})
