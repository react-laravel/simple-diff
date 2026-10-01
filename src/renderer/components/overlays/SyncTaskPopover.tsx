import { ListTree, Pause, Play, Trash2 } from 'lucide-react'
import type { SyncTaskStatus } from '../../../../shared/types'
import { Button, ProgressBar, type JobStatus } from '../ui'
import { useCompareStore } from '../../stores/compare-store'
import { useCompareSync } from '../../hooks/useCompareSync'
import { useUIStore } from '../../stores/ui-store'
import { formatSyncProgress } from '../../utils/format-sync-progress'

/** DESIGN-SYSTEM §7 的统一状态机；同步任务的四个状态映射到其中四个。 */
export const SYNC_JOB_STATUS: Record<SyncTaskStatus, JobStatus> = {
  running: 'running',
  paused: 'queued',
  completed: 'done',
  failed: 'error',
}

/**
 * F7 第三层的第一跳：状态栏任务槽点开后的任务摘要。
 *
 * 计数 + 进度 + 暂停/继续/清除 + 「查看全部」（打开 `SyncDrawer`）。它和抽屉、
 * 工具栏进度线读的是同一个 store 与同一组动作（`useCompareSync`），F7 说的
 * 「一套词汇三层落点」就是这个意思。
 */
export default function SyncTaskPopover() {
  const openOverlay = useUIStore((state) => state.openOverlay)
  const syncTask = useCompareStore((state) => state.syncTask)
  const { pause, resume, clear } = useCompareSync()

  if (!syncTask) {
    return (
      <div className="flex w-64 flex-col gap-2 text-xs text-fg-muted">
        <p>当前没有进行中的同步任务。</p>
        <Button size="sm" icon={ListTree} onClick={() => openOverlay('sync')}>
          查看同步队列
        </Button>
      </div>
    )
  }

  return (
    <div className="flex w-72 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-fg">
        <span className="font-medium">同步 {syncTask.completedItems}/{syncTask.totalItems}</span>
        <span className="tabular-nums text-fg-muted">
          {formatSyncProgress(syncTask.completedItems, syncTask.totalItems)}
        </span>
      </div>
      <ProgressBar
        status={SYNC_JOB_STATUS[syncTask.status]}
        value={syncTask.totalItems > 0 ? syncTask.completedItems / syncTask.totalItems : 0}
        detail={syncTask.currentPath ?? undefined}
      />
      {syncTask.lastError ? <p className="text-2xs text-danger-text">{syncTask.lastError}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {syncTask.status === 'running' ? (
          <Button size="sm" icon={Pause} onClick={() => void pause()}>暂停</Button>
        ) : null}
        {syncTask.status === 'paused' || syncTask.status === 'failed' ? (
          <Button size="sm" icon={Play} disabled={syncTask.status === 'paused' && Boolean(syncTask.currentPath)} onClick={() => void resume()}>继续</Button>
        ) : null}
        <Button size="sm" icon={Trash2} disabled={syncTask.status === 'running' || (syncTask.status === 'paused' && Boolean(syncTask.currentPath))} onClick={() => void clear()}>
          清除
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openOverlay('sync')}>查看全部</Button>
      </div>
    </div>
  )
}
