import type { AppAPI, AppRuntimeInfo } from '@shared/app-api'
import { computeTextDiffAsync } from './text-diff-client'
import type { CompareHistoryEntry, SSHConfig, SSHConfigInput } from '@shared/types'
import {
  delay,
  localDirtyEmitter,
  entryEmitter,
  ok,
  openPathsEmitter,
  scanEmitter,
  subscribeLog,
  syncEmitter,
} from './mock-bus'
import {
  cancelMockCompare,
  resolveMockSide,
  runMockCompare,
  runMockPartialCompare,
  setMockCompareSources,
  toMockRelativePath,
} from './mock-compare'
import {
  listMockRemoteEntries,
  MOCK_HISTORY,
  MOCK_LEFT_SOURCE,
  MOCK_PRIVATE_KEY_PATH,
  MOCK_RIGHT_SOURCE,
  MOCK_SSH_CONFIGS,
} from './mock-fixtures'
import {
  clearMockSync,
  getMockSyncTask,
  scheduleMockSyncTick,
  setMockSyncStatus,
  startMockSync,
} from './mock-sync'
import { listMockChildren, readMockFile, writeMockFile } from './mock-tree'

/**
 * 浏览器预览用的 `window.api` 实现。
 * `npm run dev:ui` 在没有 Tauri 后端的普通浏览器里运行时使用它；
 * 所有成员返回与真实实现相同的 `IpcResult<T>` 信封。
 */

const SSH_TEST_DELAY_MS = 700

const MOCK_RUNTIME: AppRuntimeInfo = {
  mode: 'web',
  supportsSftp: true,
  supportsHistory: true,
  supportsSync: true,
  supportsNativeFolderSelection: false,
  supportsDirectoryDragDrop: false,
  supportsWriteBack: true,
}

let sshConfigs: SSHConfig[] = [...MOCK_SSH_CONFIGS]
let historyEntries: CompareHistoryEntry[] = [...MOCK_HISTORY]
let folderPickCount = 0

function toSSHConfig(input: SSHConfigInput): SSHConfig {
  return {
    id: input.id ?? `ssh-${Date.now().toString(36)}`,
    label: input.label,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    defaultPath: input.defaultPath,
  }
}

export function createMockApi(): AppAPI {
  return {
    runtime: MOCK_RUNTIME,

    listFiles: (source, dirPath) =>
      ok(listMockChildren(resolveMockSide(source), toMockRelativePath(source, dirPath))),

    readText: (source, filePath) =>
      ok(readMockFile(resolveMockSide(source), toMockRelativePath(source, filePath))),

    writeText: (source, filePath, content, expectation) => {
      if (expectation?.exists && readMockFile(resolveMockSide(source), toMockRelativePath(source, filePath)) !== expectation.content) {
        return Promise.resolve({ success: false, error: '文件已被其他程序修改，已停止覆盖。' })
      }
      writeMockFile(resolveMockSide(source), toMockRelativePath(source, filePath), content)
      return ok<void>(undefined)
    },

    runCompare: (request) => {
      setMockCompareSources(request.left, request.right)
      return runMockCompare(request.compareId)
    },

    runPartialCompare: (request) => runMockPartialCompare(request),

    cancelCompare: async (compareId) => {
      cancelMockCompare(compareId)
      return { success: true }
    },

    startLocalCompareWatch: async (request) => {
      setMockCompareSources(request.left, request.right)
      return { success: true }
    },

    stopLocalCompareWatch: async () => ({ success: true }),

    startSync: async (request) => ({ success: true, data: startMockSync(request) }),
    pauseSync: async () => ({ success: true, data: setMockSyncStatus('paused') }),
    resumeSync: async () => ({ success: true, data: setMockSyncStatus('running') }),
    getSyncStatus: async () => ({ success: true, data: getMockSyncTask() }),

    clearSync: async () => {
      clearMockSync()
      return { success: true }
    },

    onScanComplete: (callback) => scanEmitter.subscribe(callback),
    onEntryUpdate: (callback) => entryEmitter.subscribe(callback),
    onCompareLocalDirty: (callback) => localDirtyEmitter.subscribe(callback),

    onSyncProgress: (callback) => {
      const unsubscribe = syncEmitter.subscribe(callback)
      scheduleMockSyncTick()
      return unsubscribe
    },

    onLog: (callback) => subscribeLog(callback),

    // 渲染进程日志由 log-store 自行入库，这里不再回灌，避免重复
    writeLog: () => {},

    textDiff: computeTextDiffAsync,

    listSSHConfigs: () => ok<readonly SSHConfig[]>(sshConfigs),

    saveSSHConfig: (input) => {
      const config = toSSHConfig(input)
      const index = sshConfigs.findIndex((item) => item.id === config.id)
      sshConfigs = index >= 0
        ? sshConfigs.map((item, position) => position === index ? config : item)
        : [...sshConfigs, config]
      return ok(config)
    },

    deleteSSHConfig: (id) => {
      sshConfigs = sshConfigs.filter((item) => item.id !== id)
      return ok<void>(undefined)
    },

    testSSHConnection: async (id) => {
      await delay(SSH_TEST_DELAY_MS)
      if (id === 'ssh-prod') {
        return { success: false, error: '连接超时：ssh: connect to host 10.0.3.44 port 2222: Operation timed out' }
      }
      return { success: true, data: true }
    },

    browseSSH: (_configId, dirPath) => ok(listMockRemoteEntries(dirPath), SSH_TEST_DELAY_MS),

    listHistory: () => ok<readonly CompareHistoryEntry[]>(historyEntries),

    clearHistory: () => {
      historyEntries = []
      return ok<void>(undefined)
    },

    deleteHistory: (id) => {
      historyEntries = historyEntries.filter((entry) => entry.id !== id)
      return ok<void>(undefined)
    },

    showInFolder: () => ok<void>(undefined),
    renameFile: () => ok<void>(undefined),
    deleteFile: () => ok<void>(undefined),

    // 浏览器里没有系统目录选择器；返回示例根目录，让「浏览」按钮仍然可用
    selectFolder: () => {
      folderPickCount += 1
      return ok<string | null>(folderPickCount % 2 === 1 ? MOCK_LEFT_SOURCE.path : MOCK_RIGHT_SOURCE.path)
    },

    selectFile: () => ok<string | null>(MOCK_PRIVATE_KEY_PATH),

    onOpenPaths: (callback) => openPathsEmitter.subscribe(callback),
    onDirectoryDragDrop: () => () => {},

    // 浏览器里的 File 没有真实路径；SourceSelector 会退回 text/uri-list 与 text/plain
    getPathForFile: () => '',
  }
}
