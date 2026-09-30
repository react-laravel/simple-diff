// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'
import type { LogEntry } from '@shared/types'
import { tauriApi } from './tauri-api'

const webviewDragDrop = vi.hoisted(() => {
  const state: { handler?: (event: { payload: unknown }) => void } = {}
  return {
    state,
    getCurrentWebview: vi.fn(() => ({
      onDragDropEvent: vi.fn((handler: (event: { payload: unknown }) => void) => {
        state.handler = handler
        return Promise.resolve(() => {})
      }),
    })),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: webviewDragDrop.getCurrentWebview,
}))

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('tauri-api subscribe', () => {
  it('listen 完成后取消订阅会调用 unlisten', async () => {
    const unlisten = vi.fn<UnlistenFn>()
    vi.mocked(listen).mockResolvedValueOnce(unlisten)

    const dispose = tauriApi.onLog(() => {})
    await flush()
    dispose()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('清理发生在 listen 完成之前时，注册完成后立即注销（不泄漏监听器）', async () => {
    const unlisten = vi.fn<UnlistenFn>()
    let resolveListen!: (fn: UnlistenFn) => void
    vi.mocked(listen).mockReturnValueOnce(
      new Promise<UnlistenFn>((resolve) => {
        resolveListen = resolve
      }),
    )

    const dispose = tauriApi.onLog(() => {})
    dispose()
    expect(unlisten).not.toHaveBeenCalled()

    resolveListen(unlisten)
    await flush()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('将事件负载转发给回调', async () => {
    let handler: EventCallback<LogEntry> | undefined
    vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
      handler = callback as EventCallback<LogEntry>
      return vi.fn<UnlistenFn>()
    })

    const received: LogEntry[] = []
    tauriApi.onLog((entry) => received.push(entry))
    await flush()

    const entry: LogEntry = {
      timestamp: 1,
      level: 'info',
      scope: 'compare',
      message: 'hello',
    }
    handler?.({ event: 'app:log', id: 1, payload: entry })

    expect(received).toEqual([entry])
  })
})

describe('tauri-api open paths and native drop', () => {
  it('onOpenPaths 会取出启动时缓存的路径', async () => {
    vi.mocked(listen).mockResolvedValueOnce(vi.fn<UnlistenFn>())
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, data: ['/left', '/right'] })
    const received: Array<readonly string[]> = []
    const dispose = tauriApi.onOpenPaths((paths) => {
      received.push(paths)
    })
    await flush()
    dispose()

    expect(invoke).toHaveBeenCalledWith('take_open_paths')
    expect(received).toEqual([['/left', '/right']])
  })

  it('把原生 drop 事件原样转发给监听器', async () => {
    await flush()
    expect(webviewDragDrop.state.handler).toBeTypeOf('function')

    const received: Array<{ type: string; x?: number; paths?: readonly string[] }> = []
    const dispose = tauriApi.onDirectoryDragDrop((event) => {
      received.push(event)
    })

    webviewDragDrop.state.handler?.({
      payload: { type: 'drop', paths: ['/Users/sam/src'], position: { x: 200, y: 80 } },
    })
    dispose()

    expect(received).toEqual([{ type: 'drop', x: 200, y: 80, paths: ['/Users/sam/src'] }])
    expect(tauriApi.getPathForFile({} as File)).toBe('/Users/sam/src')
  })
})
