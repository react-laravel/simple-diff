// ─── File Entry ───────────────────────────────────────────────

export interface FileEntry {
  readonly name: string
  readonly path: string // relative to comparison root
  readonly isDirectory: boolean
  readonly isSymlink?: boolean
  readonly size: number // bytes
  readonly mtime: number // Unix timestamp ms
}

// ─── Source Config ────────────────────────────────────────────

export type SourceType = 'local' | 'sftp'

export type SourceConfig =
  | { readonly type: 'local'; readonly path: string }
  | { readonly type: 'sftp'; readonly configId: string; readonly path: string }

// ─── SSH Config ──────────────────────────────────────────────

export type SSHAuthType = 'password' | 'privateKey'

/** Exposed to renderer — no secrets */
export interface SSHConfig {
  readonly id: string
  readonly label: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly authType: SSHAuthType
  readonly defaultPath?: string
}

/** Sent from renderer when saving — may include secrets */
export interface SSHConfigInput {
  readonly id?: string
  readonly label: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly authType: SSHAuthType
  readonly defaultPath?: string
  readonly password?: string
  readonly privateKeyPath?: string
  readonly passphrase?: string
}

export interface SSHBrowseResult {
  readonly path: string
  readonly rootPath: string
  readonly entries: readonly FileEntry[]
}

/** Main-process only — contains encrypted secrets */
export interface SSHConfigInternal extends SSHConfig {
  readonly password?: string
  readonly privateKeyPath?: string
  readonly passphrase?: string
}

// ─── Compare ─────────────────────────────────────────────────

export type CompareState = 'pending' | 'comparing' | 'equal' | 'left_only' | 'right_only' | 'different'
export type CompareFilter = CompareState | 'all' | 'paired' | 'unresolved'

export type DiffReason =
  | { readonly type: 'type'; readonly leftType: 'file' | 'directory' | 'symlink'; readonly rightType: 'file' | 'directory' | 'symlink' }
  | { readonly type: 'size'; readonly leftSize: number; readonly rightSize: number }
  | { readonly type: 'mtime'; readonly leftMtime: number; readonly rightMtime: number }
  | { readonly type: 'hash'; readonly leftHash: string; readonly rightHash: string }
  | { readonly type: 'quick_hash'; readonly leftHash: string; readonly rightHash: string }

export type StrategyName = 'size' | 'mtime' | 'hash' | 'quick_hash'

export interface CompareEntry {
  readonly relativePath: string
  readonly name: string
  readonly isDirectory: boolean
  readonly state: CompareState
  readonly left?: FileEntry
  readonly right?: FileEntry
  readonly reasons: readonly DiffReason[]
}

export interface CompareFileFingerprint {
  readonly isDirectory: boolean
  readonly isSymlink?: boolean
  readonly size: number
  readonly mtime: number
}

export interface CompareCacheEntry {
  readonly relativePath: string
  readonly state: 'equal' | 'different'
  readonly left: CompareFileFingerprint
  readonly right: CompareFileFingerprint
  readonly reasons: readonly DiffReason[]
}

export interface CompareRequest {
  readonly compareId: string
  readonly left: SourceConfig
  readonly right: SourceConfig
  readonly strategies: readonly StrategyName[]
  readonly extensionFilter?: readonly string[]
  readonly previousEntries?: readonly CompareCacheEntry[]
}

export interface ComparePartialRequest {
  /** 原始全量对比会话 id；提供时局部结果会并入该会话的受信任映射 */
  readonly compareId?: string
  readonly left: SourceConfig
  readonly right: SourceConfig
  readonly strategies: readonly StrategyName[]
  readonly extensionFilter?: readonly string[]
  readonly previousEntries?: readonly CompareCacheEntry[]
  readonly relativeRoots: readonly string[]
}

export interface CompareLocalWatchRequest {
  readonly sessionId: string
  readonly left: SourceConfig
  readonly right: SourceConfig
}

export interface CompareLocalDirtyEvent {
  readonly sessionId: string
  readonly paths: readonly string[]
}

export interface CompareStats {
  readonly total: number
  readonly equal: number
  readonly different: number
  readonly leftOnly: number
  readonly rightOnly: number
}

export interface CompareResult {
  readonly entries: readonly CompareEntry[]
  readonly entriesIncluded?: boolean
  readonly stats: CompareStats
  readonly duration: number // ms
  readonly leftSource?: SourceConfig
  readonly rightSource?: SourceConfig
}

// ─── Sync ────────────────────────────────────────────────────

export type SyncDirection = 'left_to_right' | 'right_to_left'
export type SyncTaskStatus = 'running' | 'paused' | 'completed' | 'failed'
export type SyncItemKind = 'directory' | 'file'
export type SyncTaskItemStatus = 'pending' | 'running' | 'completed'

export interface SyncItem {
  readonly relativePath: string
  readonly kind: SyncItemKind
}

export interface SyncTaskItemSnapshot {
  readonly relativePath: string
  readonly kind: SyncItemKind
  readonly status: SyncTaskItemStatus
}

export interface SyncTaskSnapshot {
  readonly id: string
  readonly leftSource: SourceConfig
  readonly rightSource: SourceConfig
  readonly direction: SyncDirection
  readonly status: SyncTaskStatus
  readonly totalItems: number
  readonly completedItems: number
  readonly currentPath: string | null
  readonly currentBytes?: number
  readonly currentTotalBytes?: number
  readonly lastCompletedPath: string | null
  readonly lastError: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly itemsDelta?: boolean
  readonly items?: readonly SyncTaskItemSnapshot[]
}

export interface StartSyncRequest {
  readonly compareId: string
  readonly leftSource: SourceConfig
  readonly rightSource: SourceConfig
  readonly direction: SyncDirection
  readonly entries: readonly CompareEntry[]
  readonly planId?: string
}

export interface SyncPlanPreview {
  readonly planId: string
  readonly files: number
  readonly directories: number
  readonly overwrites: number
}

// ─── Text Diff ───────────────────────────────────────────────

export interface DiffLine {
  readonly type: 'equal' | 'add' | 'remove'
  readonly lineNumber: number
  readonly content: string
}

export interface TextDiffResult {
  readonly leftLines: readonly DiffLine[]
  readonly rightLines: readonly DiffLine[]
}

// ─── Compare History ─────────────────────────────────────────

export interface CompareHistoryEntry {
  readonly id: string
  readonly timestamp: number
  readonly leftLabel: string
  readonly rightLabel: string
  readonly leftSource: SourceConfig
  readonly rightSource: SourceConfig
  readonly stats: CompareStats
}

// ─── Log ─────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error'
export type LogScope = 'app' | 'compare' | 'compare-watch' | 'sync' | 'ssh'

export interface LogEntry {
  readonly timestamp: number
  readonly level: LogLevel
  readonly scope: LogScope
  readonly message: string
}

// ─── IPC Channels ────────────────────────────────────────────

export const IPC_CHANNELS = {
  FILE_SOURCE_LIST: 'file-source:list',
  FILE_READ_TEXT: 'file:read-text',
  FILE_WRITE_TEXT: 'file:write-text',
  COMPARE_RUN: 'compare:run',
  COMPARE_RUN_PARTIAL: 'compare:run-partial',
  COMPARE_CANCEL: 'compare:cancel',
  COMPARE_PROGRESS: 'compare:progress',
  COMPARE_SCAN_COMPLETE: 'compare:scan-complete',
  COMPARE_ENTRY_UPDATE: 'compare:entry-update',
  COMPARE_LOCAL_WATCH_START: 'compare:local-watch:start',
  COMPARE_LOCAL_WATCH_STOP: 'compare:local-watch:stop',
  COMPARE_LOCAL_DIRTY: 'compare:local-dirty',
  LOG: 'app:log',
  LOG_WRITE: 'app:log-write',
  TEXT_DIFF: 'text:diff',
  SSH_LIST_CONFIGS: 'ssh:list-configs',
  SSH_SAVE_CONFIG: 'ssh:save-config',
  SSH_DELETE_CONFIG: 'ssh:delete-config',
  SSH_TEST: 'ssh:test',
  SSH_BROWSE: 'ssh:browse',
  HISTORY_LIST: 'history:list',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_DELETE: 'history:delete',
  SYNC_START: 'sync:start',
  SYNC_PAUSE: 'sync:pause',
  SYNC_RESUME: 'sync:resume',
  SYNC_GET_STATUS: 'sync:get-status',
  SYNC_CLEAR: 'sync:clear',
  SYNC_PROGRESS: 'sync:progress',
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILE: 'dialog:select-file',
  FILE_SHOW_IN_FOLDER: 'file:show-in-folder',
  FILE_RENAME: 'file:rename',
  FILE_DELETE: 'file:delete',
  APP_OPEN_PATHS: 'app:open-paths',
} as const

// ─── IPC Result Envelope ─────────────────────────────────────

export interface IpcResult<T> {
  readonly success: boolean
  readonly data?: T
  readonly error?: string
}
