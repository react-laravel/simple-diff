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
  TextDiffResult,
} from './types'

export interface AppRuntimeInfo {
  readonly mode: 'tauri' | 'electron' | 'web'
  readonly supportsSftp: boolean
  readonly supportsHistory: boolean
  readonly supportsSync: boolean
  readonly supportsNativeFolderSelection: boolean
  readonly supportsDirectoryDragDrop: boolean
  readonly supportsWriteBack: boolean
}

export interface AppAPI {
  readonly runtime: AppRuntimeInfo

  listFiles: (source: SourceConfig, dirPath: string) => Promise<IpcResult<readonly FileEntry[]>>
  readText: (source: SourceConfig, filePath: string) => Promise<IpcResult<string>>
  writeText: (source: SourceConfig, filePath: string, content: string, expectation?: { content: string; exists: boolean }) => Promise<IpcResult<void>>

  runCompare: (request: CompareRequest) => Promise<IpcResult<CompareResult>>
  runPartialCompare: (request: ComparePartialRequest) => Promise<IpcResult<CompareResult>>
  cancelCompare: (compareId?: string) => Promise<IpcResult<void>>
  startLocalCompareWatch: (request: CompareLocalWatchRequest) => Promise<IpcResult<void>>
  stopLocalCompareWatch: (sessionId?: string) => Promise<IpcResult<void>>
  startSync: (request: StartSyncRequest) => Promise<IpcResult<SyncTaskSnapshot>>
  pauseSync: () => Promise<IpcResult<SyncTaskSnapshot | null>>
  resumeSync: () => Promise<IpcResult<SyncTaskSnapshot | null>>
  getSyncStatus: () => Promise<IpcResult<SyncTaskSnapshot | null>>
  clearSync: () => Promise<IpcResult<void>>

  onScanComplete: (callback: (compareId: string, entries: readonly CompareEntry[]) => void) => (() => void)
  onEntryUpdate: (callback: (compareId: string, entries: readonly CompareEntry[]) => void) => (() => void)
  onCompareLocalDirty: (callback: (sessionId: string, paths: readonly string[]) => void) => (() => void)
  onSyncProgress: (callback: (task: SyncTaskSnapshot | null) => void) => (() => void)

  onLog: (callback: (entry: LogEntry) => void) => (() => void)
  writeLog: (entry: LogEntry) => void

  textDiff: (leftText: string, rightText: string, signal?: AbortSignal) => Promise<IpcResult<TextDiffResult>>

  listSSHConfigs: () => Promise<IpcResult<readonly SSHConfig[]>>
  saveSSHConfig: (config: SSHConfigInput) => Promise<IpcResult<SSHConfig>>
  deleteSSHConfig: (id: string) => Promise<IpcResult<void>>
  testSSHConnection: (id: string) => Promise<IpcResult<boolean>>
  browseSSH: (configId: string, dirPath: string) => Promise<IpcResult<readonly FileEntry[]>>

  listHistory: () => Promise<IpcResult<readonly CompareHistoryEntry[]>>
  clearHistory: () => Promise<IpcResult<void>>
  deleteHistory: (id: string) => Promise<IpcResult<void>>

  showInFolder: (source: SourceConfig, relativePath: string) => Promise<IpcResult<void>>
  renameFile: (source: SourceConfig, oldRelativePath: string, newName: string) => Promise<IpcResult<void>>
  deleteFile: (source: SourceConfig, relativePath: string, isDirectory: boolean) => Promise<IpcResult<void>>

  selectFolder: () => Promise<IpcResult<string | null>>
  selectFile: () => Promise<IpcResult<string | null>>
  onOpenPaths: (callback: (paths: readonly string[]) => void) => (() => void)
  onDirectoryDragDrop: (callback: (event: DirectoryDragDropEvent) => void) => (() => void)
  onWindowCloseRequested?: (callback: () => Promise<boolean>) => (() => void)

  getPathForFile: (file: File) => string
}

export type DirectoryDragDropEvent =
  | { readonly type: 'over'; readonly x: number; readonly y: number }
  | { readonly type: 'leave' }
  | { readonly type: 'drop'; readonly x: number; readonly y: number; readonly paths: readonly string[] }

