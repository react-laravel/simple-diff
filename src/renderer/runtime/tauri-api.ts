import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { AppAPI, DirectoryDragDropEvent } from '@shared/app-api'
import { computeTextDiffAsync } from './text-diff-client'
import type {
  CompareEntry,
  CompareHistoryEntry,
  CompareLocalWatchRequest,
  ComparePartialRequest,
  CompareRequest,
  CompareResult,
  FileEntry,
  IpcResult,
  LogEntry,
  SourceConfig,
  SSHConfig,
  SSHConfigInput,
  StartSyncRequest,
  SyncTaskSnapshot,
} from '@shared/types'

async function wrap<T>(fn: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await fn()
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function subscribe<T>(
  event: string,
  callback: (payload: T) => void,
): () => void {
  let disposed = false
  let unlisten: UnlistenFn | null = null
  void listen<T>(event, (e) => {
    callback(e.payload)
  }).then((fn) => {
    // 清理可能发生在 listen 完成之前（如 StrictMode 双挂载）：此时立即注销，避免监听器泄漏
    if (disposed) {
      fn()
    } else {
      unlisten = fn
    }
  }).catch((error: unknown) => {
    // 事件注册失败不应冒泡到 window.unhandledrejection
    console.error(`[tauri-api] 订阅事件失败 event=${event}`, error)
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/** Last native drop paths (Tauri onDragDropEvent); HTML5 File has no path in WKWebView. */
let lastNativeDropPaths: string[] = []
const directoryDragDropListeners = new Set<(event: DirectoryDragDropEvent) => void>()

function rememberNativeDropPaths(paths: readonly string[]): void {
  lastNativeDropPaths = [...paths]
}

export function consumeNativeDropPath(): string | null {
  if (lastNativeDropPaths.length === 0) return null
  return lastNativeDropPaths.shift() ?? null
}

function emitDirectoryDragDrop(event: DirectoryDragDropEvent): void {
  for (const listener of directoryDragDropListeners) {
    listener(event)
  }
}

function ensureNativeDropListener(): void {
  if (typeof window === 'undefined') return
  if ((window as unknown as { __simpleDiffDropBound?: boolean }).__simpleDiffDropBound) return
  ;(window as unknown as { __simpleDiffDropBound?: boolean }).__simpleDiffDropBound = true

  // getCurrentWebview() 会同步解引用 Tauri 全局并抛错，因此 try 必须包住整个调用，
  // 只在末尾挂 .catch 拦不到它
  try {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'leave') {
          emitDirectoryDragDrop({ type: 'leave' })
          return
        }

        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          emitDirectoryDragDrop({
            type: 'over',
            x: event.payload.position.x,
            y: event.payload.position.y,
          })
          return
        }

        if (event.payload.type === 'drop') {
          rememberNativeDropPaths(event.payload.paths)
          emitDirectoryDragDrop({
            type: 'drop',
            x: event.payload.position.x,
            y: event.payload.position.y,
            paths: event.payload.paths,
          })
        }
      })
      .catch(() => {
        // Not running inside Tauri webview (e.g. vitest)
      })
  } catch {
    // Not running inside Tauri webview (e.g. vitest / 浏览器预览)
  }
}

ensureNativeDropListener()

export const tauriApi: AppAPI = {
  runtime: {
    mode: 'tauri',
    supportsSftp: true,
    supportsHistory: true,
    supportsSync: true,
    supportsNativeFolderSelection: true,
    supportsDirectoryDragDrop: true,
    supportsWriteBack: true,
  },

  listFiles: (source, dirPath) =>
    wrap(() => invoke<IpcResult<readonly FileEntry[]>>('list_files', { source, dirPath })),

  readText: (source, filePath) =>
    wrap(() => invoke<IpcResult<string>>('read_text_file', { source, filePath })),

  writeText: (source, filePath, content, expectation) =>
    wrap(() => invoke<IpcResult<void>>('write_text_file', { source, filePath, content, expectedContent: expectation?.content, expectedExists: expectation?.exists })),

  runCompare: (request: CompareRequest) =>
    wrap(() => invoke<IpcResult<CompareResult>>('run_compare', { request })),

  runPartialCompare: (request: ComparePartialRequest) =>
    wrap(() => invoke<IpcResult<CompareResult>>('run_partial_compare', { request })),

  cancelCompare: (compareId?: string) =>
    wrap(() => invoke<IpcResult<void>>('cancel_compare', { compareId: compareId ?? null })),

  startLocalCompareWatch: (request: CompareLocalWatchRequest) =>
    wrap(() => invoke<IpcResult<void>>('start_local_compare_watch', { request })),

  stopLocalCompareWatch: (sessionId?: string) =>
    wrap(() => invoke<IpcResult<void>>('stop_local_compare_watch', { sessionId: sessionId ?? null })),

  startSync: (request: StartSyncRequest) =>
    wrap(() => invoke<IpcResult<SyncTaskSnapshot>>('sync_start', { request })),

  pauseSync: () =>
    wrap(() => invoke<IpcResult<SyncTaskSnapshot | null>>('sync_pause')),

  resumeSync: () =>
    wrap(() => invoke<IpcResult<SyncTaskSnapshot | null>>('sync_resume')),

  getSyncStatus: () =>
    wrap(() => invoke<IpcResult<SyncTaskSnapshot | null>>('sync_get_status')),

  clearSync: () =>
    wrap(() => invoke<IpcResult<void>>('sync_clear')),

  onScanComplete: (callback) =>
    subscribe<[string, readonly CompareEntry[]]>('compare:scan-complete', ([compareId, entries]) => {
      callback(compareId, entries)
    }),

  onEntryUpdate: (callback) =>
    subscribe<[string, readonly CompareEntry[]]>('compare:entry-update', ([compareId, entries]) => {
      callback(compareId, entries)
    }),

  onCompareLocalDirty: (callback) =>
    subscribe<[string, readonly string[]]>('compare:local-dirty', ([sessionId, paths]) => {
      callback(sessionId, paths)
    }),

  onSyncProgress: (callback) =>
    subscribe<SyncTaskSnapshot | null>('sync:progress', (task) => {
      callback(task)
    }),

  onLog: (callback) =>
    subscribe<LogEntry>('app:log', (entry) => {
      callback(entry)
    }),

  writeLog: (entry: LogEntry) => {
    void invoke('write_log', { entry })
  },

  textDiff: computeTextDiffAsync,

  onWindowCloseRequested: (callback) => {
    let disposed = false
    let unlisten: UnlistenFn | undefined
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (!await callback()) event.preventDefault()
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup })
      .catch((error: unknown) => console.error('窗口关闭保护注册失败', error))
    return () => { disposed = true; unlisten?.() }
  },

  listSSHConfigs: () =>
    wrap(() => invoke<IpcResult<readonly SSHConfig[]>>('ssh_list_configs')),

  saveSSHConfig: (config: SSHConfigInput) =>
    wrap(() => invoke<IpcResult<SSHConfig>>('ssh_save_config', { input: config })),

  deleteSSHConfig: (id: string) =>
    wrap(() => invoke<IpcResult<void>>('ssh_delete_config', { id })),

  testSSHConnection: (id: string) =>
    wrap(() => invoke<IpcResult<boolean>>('ssh_test', { id })),

  browseSSH: (configId: string, dirPath: string) =>
    wrap(() => invoke<IpcResult<readonly FileEntry[]>>('ssh_browse', { configId, dirPath })),

  listHistory: () =>
    wrap(() => invoke<IpcResult<readonly CompareHistoryEntry[]>>('history_list')),

  clearHistory: () =>
    wrap(() => invoke<IpcResult<void>>('history_clear')),

  deleteHistory: (id: string) =>
    wrap(() => invoke<IpcResult<void>>('history_delete', { id })),

  showInFolder: (source: SourceConfig, relativePath: string) =>
    wrap(() => invoke<IpcResult<void>>('show_in_folder', { source, relativePath })),

  renameFile: (source, oldRelativePath, newName) =>
    wrap(() => invoke<IpcResult<void>>('rename_path', { source, oldRelativePath, newName })),

  deleteFile: (source, relativePath, isDirectory) =>
    wrap(() => invoke<IpcResult<void>>('delete_path', { source, relativePath, isDirectory })),

  selectFolder: () =>
    wrap(() => invoke<IpcResult<string | null>>('select_folder')),

  selectFile: () =>
    wrap(() => invoke<IpcResult<string | null>>('select_file')),

  onOpenPaths: (callback) => {
    // `take_open_paths` resolves asynchronously: a subscriber that unsubscribes
    // before it settles must not receive the startup paths afterwards.
    let disposed = false
    const unsubscribe = subscribe<readonly string[]>('app:open-paths', (paths) => {
      callback(paths)
    })
    void wrap(() => invoke<IpcResult<readonly string[]>>('take_open_paths')).then((result) => {
      if (disposed) return
      if (result.success && result.data && result.data.length > 0) {
        callback(result.data)
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  },

  onDirectoryDragDrop: (callback) => {
    directoryDragDropListeners.add(callback)
    return () => {
      directoryDragDropListeners.delete(callback)
    }
  },

  getPathForFile: () => consumeNativeDropPath() ?? '',
}
