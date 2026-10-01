import { formatSize } from '../tree-row-utils'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FolderSync, GitCompare, Pause, Play, Trash2 } from 'lucide-react'
import type { SyncTaskItemSnapshot, SyncTaskStatus } from '../../../../shared/types'
import { Badge, Button, Drawer, EmptyState, Panel, ProgressBar, type Tone } from '../ui'
import { useCompareStore } from '../../stores/compare-store'
import { useSSHStore } from '../../stores/ssh-store'
import { useCompareSync } from '../../hooks/useCompareSync'
import { formatSyncProgress } from '../../utils/format-sync-progress'
import { formatComparePairLabel } from '../../utils/source-label'
import { openCompareTab } from '../../utils/compare-session-navigation'
import { SYNC_JOB_STATUS } from './SyncTaskPopover'

export interface SyncDrawerProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

const TASK_TONE: Record<SyncTaskStatus, Tone> = {
  running: 'running',
  paused: 'warning',
  completed: 'success',
  failed: 'danger',
}

const TASK_LABEL: Record<SyncTaskStatus, string> = {
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
}

const ITEM_TONE: Record<SyncTaskItemSnapshot['status'], Tone> = {
  pending: 'idle',
  running: 'running',
  completed: 'success',
}

const ITEM_LABEL: Record<SyncTaskItemSnapshot['status'], string> = {
  pending: '待执行',
  running: '进行中',
  completed: '已完成',
}

function QueueGroup({ title, items }: { readonly title: string; readonly items: readonly SyncTaskItemSnapshot[] }) {
  const [page, setPage] = useState(0)
  const pageSize = 100
  const lastPage = Math.max(0, Math.ceil(items.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const visibleItems = items.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  return (
    <Panel
      header={
        <>
          <span className="text-xs font-medium text-fg-muted">{title}</span>
          <span className="ml-auto text-xs tabular-nums text-fg-subtle">{items.length}</span>
        </>
      }
      padded={false}
    >
      {items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-fg-subtle">暂无{title}项目</p>
      ) : (
        <ul className="divide-y divide-border">
          {visibleItems.map((item) => (
            <li
              key={`${item.kind}:${item.relativePath}`}
              className="flex items-center gap-2 px-3 py-1.5"
            >
              <Badge tone={ITEM_TONE[item.status]} size="xs">{ITEM_LABEL[item.status]}</Badge>
              <span className="shrink-0 text-2xs text-fg-muted">{item.kind === 'directory' ? '目录' : '文件'}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={item.relativePath}>
                {item.relativePath}
              </span>
            </li>
          ))}
        </ul>
      )}
      {items.length > pageSize ? <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2 text-xs text-fg-muted">
        <span>{currentPage + 1} / {lastPage + 1} 页</span>
        <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
        <Button size="sm" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>下一页</Button>
      </div> : null}
    </Panel>
  )
}

/**
 * 蓝图 §4.8 / chunk 8 第 4 条：`pages/SyncPage.tsx` 整页降级成右侧抽屉。
 *
 * 三组队列（正在执行 / 等待队列 / 已完成）逐字搬过来；任务概览里的方向、文件数、
 * 时间戳同样保留。同步任务的三层落点（工具栏 2px 进度线、状态栏任务槽 + 摘要
 * `Popover`、这个抽屉）现在共用 `useCompareSync()` 的一组动作，不会再出现四份
 * 各写各的暂停按钮（§1.2.5）。
 */
export default function SyncDrawer({ open, onOpenChange }: SyncDrawerProps) {
  const syncTask = useCompareStore((state) => state.syncTask)
  const { pause, resume, clear } = useCompareSync()
  const { configs, loadConfigs } = useSSHStore(useShallow((state) => ({
    configs: state.configs,
    loadConfigs: state.loadConfigs,
  })))

  useEffect(() => {
    if (!open || !syncTask) return
    if (syncTask.leftSource.type !== 'sftp' && syncTask.rightSource.type !== 'sftp') return
    void loadConfigs()
  }, [loadConfigs, open, syncTask])

  const items = useMemo(() => syncTask?.items ?? [], [syncTask])
  const groups = useMemo(() => [
    { key: 'running', title: '正在执行', items: items.filter((item) => item.status === 'running') },
    { key: 'pending', title: '等待队列', items: items.filter((item) => item.status === 'pending') },
    { key: 'completed', title: '已完成', items: items.filter((item) => item.status === 'completed') },
  ], [items])

  const pairLabel = syncTask
    ? formatComparePairLabel(syncTask.leftSource, syncTask.rightSource, configs)
    : null

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      size="md"
      title="同步队列"
      description={syncTask ? (pairLabel ?? '未识别同步来源') : '当前没有进行中的同步任务'}
    >
      {!syncTask ? (
        <EmptyState
          variant="first-run"
          icon={FolderSync}
          title="暂无同步任务"
          description="在目录对比里执行复制或同步后，这里会显示完整的文件队列。"
          action={
            <Button
              variant="primary"
              icon={GitCompare}
              onClick={() => {
                openCompareTab()
                onOpenChange(false)
              }}
            >
              回到目录对比
            </Button>
          }
          size="sm"
        />
      ) : (
        <div className="flex flex-col gap-3">
          {syncTask.status === 'paused' && syncTask.currentPath ? <p role="status" className="text-xs text-fg-muted">正在完成当前文件，随后暂停；完成前无法清除队列。</p> : null}
          {syncTask.currentPath && syncTask.currentTotalBytes ? <Panel>
            <p className="truncate font-mono text-xs text-fg" title={syncTask.currentPath}>{syncTask.currentPath}</p>
            <ProgressBar status="running" value={(syncTask.currentBytes ?? 0) / syncTask.currentTotalBytes}
              detail={`${formatSize(syncTask.currentBytes ?? 0)} / ${formatSize(syncTask.currentTotalBytes)}`} />
          </Panel> : null}
          <Panel>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={TASK_TONE[syncTask.status]} size="sm" dot>
                  {TASK_LABEL[syncTask.status]}
                </Badge>
                <span className="tabular-nums text-fg-muted">
                  {syncTask.completedItems}/{syncTask.totalItems} · {formatSyncProgress(syncTask.completedItems, syncTask.totalItems)}
                </span>
              </div>

              <ProgressBar
                status={SYNC_JOB_STATUS[syncTask.status]}
                value={syncTask.totalItems > 0 ? syncTask.completedItems / syncTask.totalItems : 0}
                detail={syncTask.currentPath ?? undefined}
                onCancel={syncTask.status === 'running' ? () => void pause() : undefined}
              />

              {syncTask.lastCompletedPath ? (
                <p className="truncate text-2xs text-fg-subtle" title={syncTask.lastCompletedPath}>
                  最近完成 · <span className="font-mono">{syncTask.lastCompletedPath}</span>
                </p>
              ) : null}

              {syncTask.lastError ? (
                <p role="alert" className="text-xs text-danger-text">{syncTask.lastError}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  icon={GitCompare}
                  onClick={() => {
                    openCompareTab()
                    onOpenChange(false)
                  }}
                >
                  查看对应对比
                </Button>
                {syncTask.status === 'running' ? (
                  <Button size="sm" icon={Pause} onClick={() => void pause()}>暂停</Button>
                ) : null}
                {syncTask.status === 'paused' || syncTask.status === 'failed' ? (
                  <Button size="sm" variant="primary" icon={Play} disabled={syncTask.status === 'paused' && Boolean(syncTask.currentPath)} onClick={() => void resume()}>继续</Button>
                ) : null}
                <Button
                  size="sm"
                  variant="danger-ghost"
                  icon={Trash2}
                  disabled={syncTask.status === 'running' || (syncTask.status === 'paused' && Boolean(syncTask.currentPath))}
                  onClick={() => void clear()}
                >
                  清除
                </Button>
              </div>
            </div>
          </Panel>

          <Panel header={<span className="text-xs font-medium text-fg-muted">任务概览</span>}>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <div>
                <dt className="text-fg-muted">方向</dt>
                <dd className="mt-0.5 font-medium text-fg">
                  {syncTask.direction === 'left_to_right' ? '左 → 右' : '右 → 左'}
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">文件数</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-fg">{items.length || syncTask.totalItems}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">创建时间</dt>
                <dd className="mt-0.5 font-medium text-fg">{new Date(syncTask.createdAt).toLocaleString('zh-CN')}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">更新时间</dt>
                <dd className="mt-0.5 font-medium text-fg">{new Date(syncTask.updatedAt).toLocaleString('zh-CN')}</dd>
              </div>
            </dl>
          </Panel>

          {items.length === 0 ? (
            <p className="px-1 text-xs text-fg-muted">当前任务尚未生成可展示的文件列表</p>
          ) : (
            groups.map((group) => <QueueGroup key={group.key} title={group.title} items={group.items} />)
          )}
        </div>
      )}
    </Drawer>
  )
}
