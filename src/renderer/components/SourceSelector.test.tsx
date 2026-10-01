// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SourceSelector from './SourceSelector'
import { useSSHStore } from '../stores/ssh-store'
import type { DirectoryDragDropEvent } from '../../../shared/app-api'

let nativeDropHandler: ((event: DirectoryDragDropEvent) => void) | undefined

function installApiMock() {
  nativeDropHandler = undefined
  const api = {
    listSSHConfigs: vi.fn(async () => ({
      success: true,
      data: [
        {
          id: 'dogeow',
          label: 'DogeOW',
          host: '47.99.220.36',
          port: 22,
          username: 'ecs-user',
          authType: 'privateKey',
          defaultPath: '/',
        },
      ],
    })),
    browseSSH: vi.fn(async (configId: string, dirPath: string) => {
      if (configId !== 'dogeow') {
        return { success: false, error: 'SSH 配置未找到' }
      }

      if (dirPath === '/') {
        return {
          success: true,
          data: { path: '/', rootPath: '/', entries: [
            { name: 'var', path: 'var', isDirectory: true, size: 0, mtime: 1 },
            { name: 'tmp', path: 'tmp', isDirectory: true, size: 0, mtime: 1 },
          ] },
        }
      }

      if (dirPath === '/var') {
        return {
          success: true,
          data: { path: '/var', rootPath: '/', entries: [
            { name: 'www', path: 'www', isDirectory: true, size: 0, mtime: 1 },
          ] },
        }
      }

      return { success: true, data: { path: dirPath, rootPath: '/', entries: [] } }
    }),
    selectFolder: vi.fn(async () => ({ success: true, data: '/tmp' })),
    getPathForFile: vi.fn(() => '/tmp'),
    onDirectoryDragDrop: vi.fn((callback) => {
      nativeDropHandler = callback
      return () => {
        nativeDropHandler = undefined
      }
    }),
  } as unknown as Window['api']

  window.api = api
  return api
}

describe('SourceSelector sftp browsing', () => {
  beforeEach(() => {
    installApiMock()
    useSSHStore.setState({ configs: [], loading: false })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSSHStore.setState({ configs: [], loading: false })
  })

  it('lets users browse remote directories and select the current directory', async () => {
    const user = userEvent.setup()
    const handlePathChange = vi.fn()

    render(
      <SourceSelector
        label="左侧"
        sourceType="sftp"
        path="/"
        sshConfigId="dogeow"
        onSourceTypeChange={vi.fn()}
        onPathChange={handlePathChange}
        onSSHConfigIdChange={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(window.api.listSSHConfigs).toHaveBeenCalledTimes(1)
    })

    await user.click(screen.getByRole('button', { name: '浏览...' }))

    // chunk 8：手写模态框换成共享 `Dialog`，可访问名字来自它的标题。
    expect(await screen.findByRole('dialog', { name: '浏览远程目录' })).toBeTruthy()

    await waitFor(() => {
      expect(window.api.browseSSH).toHaveBeenCalledWith('dogeow', '/')
    })

    await user.click(await screen.findByRole('button', { name: 'var/进入' }))

    await waitFor(() => {
      expect(window.api.browseSSH).toHaveBeenLastCalledWith('dogeow', '/var')
    })

    await user.click(screen.getByRole('button', { name: '选择当前目录' }))

    expect(handlePathChange).toHaveBeenLastCalledWith('/var')
  })

  it('applies a native directory drop when the cursor is over the selector', async () => {
    const handlePathChange = vi.fn()
    const handleSourceTypeChange = vi.fn()
    const handleSSHConfigIdChange = vi.fn()

    const { container } = render(
      <SourceSelector
        label="左侧"
        sourceType="sftp"
        path="/"
        sshConfigId="dogeow"
        onSourceTypeChange={handleSourceTypeChange}
        onPathChange={handlePathChange}
        onSSHConfigIdChange={handleSSHConfigIdChange}
      />,
    )

    await waitFor(() => {
      expect(nativeDropHandler).toBeTypeOf('function')
    })

    const target = container.querySelector('[data-folder-drop]')
    expect(target).toBeTruthy()
    vi.spyOn(target as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 240,
      bottom: 40,
      width: 240,
      height: 40,
      toJSON() {},
    })

    nativeDropHandler?.({ type: 'drop', x: 20, y: 16, paths: ['/Users/sam/src'] })

    expect(handleSourceTypeChange).toHaveBeenCalledWith('local')
    expect(handleSSHConfigIdChange).toHaveBeenCalledWith('')
    expect(handlePathChange).toHaveBeenCalledWith('/Users/sam/src')
  })

  it('ignores native drops that miss the selector', async () => {
    const handlePathChange = vi.fn()

    const { container } = render(
      <SourceSelector
        label="左侧"
        sourceType="local"
        path=""
        sshConfigId=""
        onSourceTypeChange={vi.fn()}
        onPathChange={handlePathChange}
        onSSHConfigIdChange={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(nativeDropHandler).toBeTypeOf('function')
    })

    const target = container.querySelector('[data-folder-drop]')
    vi.spyOn(target as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 240,
      bottom: 40,
      width: 240,
      height: 40,
      toJSON() {},
    })

    nativeDropHandler?.({ type: 'drop', x: 400, y: 400, paths: ['/Users/sam/src'] })

    expect(handlePathChange).not.toHaveBeenCalled()
  })
})
