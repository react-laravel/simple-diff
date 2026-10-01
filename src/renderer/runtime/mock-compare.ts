import { trimTrailingSeparators } from '@shared/source-path'
import type { CompareEntry, ComparePartialRequest, CompareResult, IpcResult, SourceConfig, StrategyName } from '@shared/types'
import { entryEmitter, mockLog, scanEmitter } from './mock-bus'
import { MOCK_LEFT_SOURCE, MOCK_RIGHT_SOURCE, type MockSide } from './mock-fixtures'
import { createMockCompareEntries, summarizeMockEntries } from './mock-tree'

/** 浏览器预览模式的对比引擎：流式发事件、可取消。 */

const SCAN_DELAY_MS = 250
const ENTRY_SLICE_INTERVAL_MS = 400
const ENTRY_SLICE_COUNT = 4

// ─── 当前两侧数据源 ───────────────────────────────────────────

let currentLeftSource: SourceConfig = MOCK_LEFT_SOURCE
let currentRightSource: SourceConfig = MOCK_RIGHT_SOURCE

export function setMockCompareSources(left: SourceConfig, right: SourceConfig): void {
  currentLeftSource = left
  currentRightSource = right
}

export function resolveMockSide(source: SourceConfig): MockSide {
  return source.path === currentRightSource.path ? 'right' : 'left'
}

export function toMockRelativePath(source: SourceConfig, absolutePath: string): string {
  const root = trimTrailingSeparators(source.path)
  const trimmed = trimTrailingSeparators(absolutePath)
  const raw = root && trimmed.startsWith(root) ? trimmed.slice(root.length) : trimmed
  return raw.replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

// ─── 取消控制 ─────────────────────────────────────────────────

class MockCancelledError extends Error {}

interface MockRunController {
  readonly wait: (ms: number) => Promise<void>
  readonly cancel: () => void
}

function createRunController(): MockRunController {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let rejectPending: ((reason: Error) => void) | null = null

  return {
    wait: (ms) => new Promise<void>((resolve, reject) => {
      if (cancelled) {
        reject(new MockCancelledError())
        return
      }
      rejectPending = reject
      timer = setTimeout(() => {
        timer = null
        rejectPending = null
        resolve()
      }, ms)
    }),
    cancel: () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const reject = rejectPending
      rejectPending = null
      reject?.(new MockCancelledError())
    },
  }
}

const runningCompares = new Map<string, MockRunController>()

export function cancelMockCompare(compareId?: string): void {
  if (compareId == null) {
    for (const controller of [...runningCompares.values()]) controller.cancel()
    runningCompares.clear()
    return
  }
  runningCompares.get(compareId)?.cancel()
}

// ─── 对比执行 ─────────────────────────────────────────────────

function isScanResolvable(entry: CompareEntry): boolean {
  return !entry.isDirectory && (entry.state === 'equal' || entry.state === 'different')
}

/** 扫描阶段只知道两侧是否存在；成对文件先以 pending 出现，再由 entry-update 定型。 */
function toScanEntry(entry: CompareEntry): CompareEntry {
  return isScanResolvable(entry) ? { ...entry, state: 'pending', reasons: [] } : entry
}

export async function runMockCompare(compareId: string, strategies: readonly StrategyName[] = ['size', 'mtime']): Promise<IpcResult<CompareResult>> {
  const entries = createMockCompareEntries(strategies)
  const resolvable = entries.filter(isScanResolvable)
  const controller = createRunController()
  const startedAt = Date.now()

  runningCompares.get(compareId)?.cancel()
  runningCompares.set(compareId, controller)
  mockLog({ level: 'info', scope: 'compare', message: `[mock] 开始对比 compareId=${compareId}` })

  try {
    await controller.wait(SCAN_DELAY_MS)
    scanEmitter.emit(compareId, entries.map(toScanEntry))

    const sliceSize = Math.ceil(resolvable.length / ENTRY_SLICE_COUNT)
    for (let index = 0; index < ENTRY_SLICE_COUNT; index += 1) {
      await controller.wait(ENTRY_SLICE_INTERVAL_MS)
      const slice = resolvable.slice(index * sliceSize, (index + 1) * sliceSize)
      if (slice.length > 0) entryEmitter.emit(compareId, slice)
    }

    mockLog({ level: 'info', scope: 'compare', message: `[mock] 对比完成 compareId=${compareId}` })
    return {
      success: true,
      data: {
        entries: [],
        // 条目已经通过事件流式送达，结果里不再重复携带
        entriesIncluded: false,
        stats: summarizeMockEntries(entries),
        duration: Date.now() - startedAt,
        leftSource: currentLeftSource,
        rightSource: currentRightSource,
      },
    }
  } catch (error) {
    if (!(error instanceof MockCancelledError)) throw error
    mockLog({ level: 'warn', scope: 'compare', message: `[mock] 对比已取消 compareId=${compareId}` })
    return { success: false, error: '对比已取消' }
  } finally {
    if (runningCompares.get(compareId) === controller) runningCompares.delete(compareId)
  }
}

export async function runMockPartialCompare(
  request: ComparePartialRequest,
): Promise<IpcResult<CompareResult>> {
  setMockCompareSources(request.left, request.right)
  await new Promise<void>((resolve) => setTimeout(resolve, SCAN_DELAY_MS))

  const entries = createMockCompareEntries(request.strategies).filter((entry) =>
    request.relativeRoots.some((root) =>
      root === '' || entry.relativePath === root || entry.relativePath.startsWith(`${root}/`)))

  return {
    success: true,
    data: {
      entries,
      entriesIncluded: true,
      stats: summarizeMockEntries(entries),
      duration: SCAN_DELAY_MS,
      leftSource: request.left,
      rightSource: request.right,
    },
  }
}
