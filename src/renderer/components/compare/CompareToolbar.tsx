import { useEffect, useMemo } from 'react'
import { ArrowLeft, ArrowRight, ListTree, Loader2, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { formatDuration } from '@shared/format-duration'
import { useCompareStore } from '../../stores/compare-store'
import { useAppStore } from '../../stores/app-store'
import { useSSHStore } from '../../stores/ssh-store'
import { useUIStore } from '../../stores/ui-store'
import { useCompareJob } from '../../hooks/useCompareJob'
import { useCompareSync } from '../../hooks/useCompareSync'
import { formatComparePairLabel, formatCompareTabTitleFromSources } from '../../utils/source-label'
import { Badge, Button, Panel, SplitButton, Toolbar, type MenuItem, type ProgressState } from '../ui'
import CompareFilters from './CompareFilters'
import { useCompareOverflowItems } from './useCompareOverflowItems'

/**
 * 蓝图 §4.3 / chunk 6：34px 的 `Toolbar`（标题 · 副标题 · 3~4 个作业动作 · `⋯`）
 * 加一行 26px 筛选片，取代旧 `CompareToolbar.tsx` 那个 418 行、30 个 prop、
 * 11 个可见控件的双行块。
 *
 * 三处关键收敛：
 * - 组件直接读 store（`useCompareJob` / `useCompareSync`），不再由 `CompareTree`
 *   透传三十个 prop（chunk 6 第 1 条）。
 * - 行内同步条（旧 `:185-231`）删除；同步进度改走 `Toolbar.progress` 那条 2px 线，
 *   且只在这个任务属于当前标签时显示。常驻状态栏是另一层，两层不会同时描述同一件事
 *   （DESIGN-SYSTEM §7.2：同一个作业永远只占一层）。
 * - 取消永远和进度在同一处：作业跑着时「暂停对比」就在进度线正上方，`⌘.` 同义
 *   （DESIGN-SYSTEM §7.3）。
 */
export default function CompareToolbar() {
  // `⌘F` 由全局快捷键层处理，而这个组件在打开文件 Diff 时根本不渲染，
  // 所以过滤弹层的开合必须住在 `ui-store` 里而不是局部 state（chunk 9）。
  const filterPopoverOpen = useUIStore((state) => state.filterPopoverOpen)
  const setFilterPopoverOpen = useUIStore((state) => state.setFilterPopoverOpen)
  const openOverlay = useUIStore((state) => state.openOverlay)

  const job = useCompareJob()
  const sync = useCompareSync()
  const overflowItems = useCompareOverflowItems()

  const sshConfigs = useSSHStore((state) => state.configs)
  const leftSource = useCompareStore((state) => state.leftSource)
  const rightSource = useCompareStore((state) => state.rightSource)
  const compareSessionId = useCompareStore((state) => state.compareSessionId)
  const activeTabTitle = useAppStore(
    (state) => state.compareTabs.find((tab) => tab.id === state.activeCompareTabId)?.title ?? null,
  )

  // `⌘R` / `⌘.` / `⌘F` 现在归 `hooks/useGlobalShortcuts.ts`（chunk 9 第 3 条）。
  // 放在这里曾经有个真实缺陷：`ComparePage` 只在没有活动 diff 标签时渲染工具栏，
  // 所以打开任意一个文件 Diff 之后那三个键会静默失效。
  //
  // 代价是这个开合状态比组件活得久：弹层开着时去打开一个文件 Diff，工具栏会连同
  // 弹层一起卸载，而 `Popover` 没有机会回写 false。卸载时收干净，回到目录树才不会
  // 冒出一个用户没有再次要求的弹层。
  useEffect(() => () => setFilterPopoverOpen(false), [setFilterPopoverOpen])

  const { noStrategies } = job
  const { visibleSyncTask } = sync

  // ---- rendering ---------------------------------------------------------

  const pairLabel = formatComparePairLabel(leftSource, rightSource, sshConfigs)
  const title = activeTabTitle
    ?? (leftSource && rightSource
      ? formatCompareTabTitleFromSources(leftSource, rightSource, sshConfigs)
      : '对比结果')

  const subtitle = (
    <span className="flex items-center gap-2">
      {job.statusLabel ? (
        <span className="inline-flex items-center gap-1 text-running-text">
          <Loader2 aria-hidden size={12} strokeWidth={1.75} className="animate-spin-slow" />
          {job.statusLabel}
        </span>
      ) : null}
      {job.paused ? (
        <Badge tone="warning" size="xs" icon={Pause}>
          已暂停
        </Badge>
      ) : null}
      {job.stats.total > 0 ? <span className="tabular-nums">{job.stats.total} 项</span> : null}
      {!job.statusLabel && !job.paused && job.done ? <span>用时 {formatDuration(job.duration)}</span> : null}
      {job.dirtyCount > 0 ? (
        <Badge tone="warning" size="xs" dot className="tabular-nums">
          待重比 {job.dirtyCount}
        </Badge>
      ) : null}
    </span>
  )

  const progress = useMemo<ProgressState | null>(() => {
    if (job.loading) return { status: 'running' }
    if (job.error) return { status: 'error', value: 1 }
    if (visibleSyncTask?.status === 'running') {
      return {
        status: 'running',
        value: visibleSyncTask.totalItems > 0
          ? visibleSyncTask.completedItems / visibleSyncTask.totalItems
          : undefined,
      }
    }
    return null
  }, [job.error, job.loading, visibleSyncTask])

  const queueBusyHint = !compareSessionId ? '请先重新对比，刷新同步范围' : sync.canStartSync ? '同步队列被另一次对比占用' : '请等待对比完成'

  const syncMenuItems = useMemo<MenuItem[]>(() => [
    {
      id: 'sync-right',
      label: '同步到右',
      icon: ArrowRight,
      disabled: !sync.canStartSync || !sync.canQueue('left_to_right'),
      hint: sync.canQueue('left_to_right') ? undefined : queueBusyHint,
      onSelect: () => void sync.start('left_to_right'),
    },
    {
      id: 'sync-left',
      label: '同步到左',
      icon: ArrowLeft,
      disabled: !sync.canStartSync || !sync.canQueue('right_to_left'),
      hint: sync.canQueue('right_to_left') ? undefined : queueBusyHint,
      onSelect: () => void sync.start('right_to_left'),
    },
    { kind: 'separator', id: 'sync-sep-1' },
    {
      id: 'sync-pause',
      label: '暂停同步',
      icon: Pause,
      disabled: visibleSyncTask?.status !== 'running',
      onSelect: () => void sync.pause(),
    },
    {
      id: 'sync-resume',
      label: '继续同步',
      icon: Play,
      disabled: (visibleSyncTask?.status !== 'paused' && visibleSyncTask?.status !== 'failed') || (visibleSyncTask.status === 'paused' && Boolean(visibleSyncTask.currentPath)),
      onSelect: () => void sync.resume(),
    },
    {
      id: 'sync-clear',
      label: '清除同步',
      icon: Trash2,
      disabled: !visibleSyncTask || visibleSyncTask.status === 'running' || (visibleSyncTask.status === 'paused' && Boolean(visibleSyncTask.currentPath)),
      onSelect: () => void sync.clear(),
    },
    { kind: 'separator', id: 'sync-sep-2' },
    { id: 'sync-queue', label: '同步队列…', icon: ListTree, onSelect: () => useUIStore.getState().openOverlay('sync') },
  ], [queueBusyHint, sync, visibleSyncTask])

  const syncPrimary = visibleSyncTask?.status === 'running'
    ? { label: '暂停同步', icon: Pause, disabled: false, onClick: () => void sync.pause() }
    : visibleSyncTask?.status === 'paused' || visibleSyncTask?.status === 'failed'
      ? { label: '继续同步', icon: Play, disabled: visibleSyncTask.status === 'paused' && Boolean(visibleSyncTask.currentPath), onClick: () => void sync.resume() }
      : {
          label: '同步到右',
          icon: ArrowRight,
          disabled: !sync.canStartSync || !sync.canQueue('left_to_right'),
          onClick: () => void sync.start('left_to_right'),
        }

  const compareActions = job.loading ? (
    <>
      <Button size="sm" variant="ghost" icon={Pause} aria-label="暂停对比" onClick={() => void job.pause()}>
        暂停
      </Button>
      <Button size="sm" variant="primary" icon={RefreshCw} disabled={noStrategies} onClick={() => void job.restart()}>
        重启对比
      </Button>
    </>
  ) : job.paused ? (
    <>
      <Button size="sm" variant="primary" icon={Play} disabled={noStrategies} onClick={() => void job.resume()}>
        继续对比
      </Button>
      <Button size="sm" variant="ghost" icon={RefreshCw} disabled={noStrategies} onClick={() => void job.restart()}>
        重启对比
      </Button>
    </>
  ) : (
    <Button
      size="sm"
      variant="primary"
      icon={job.hasComparedResult ? RefreshCw : Play}
      disabled={noStrategies}
      onClick={() => void job.restart()}
    >
      {job.hasComparedResult ? '重启对比' : '首次对比'}
    </Button>
  )

  return (
    <>
      <Toolbar
        sticky={false}
        title={<span title={pairLabel ?? undefined}>{title}</span>}
        subtitle={subtitle}
        progress={progress}
        overflow={overflowItems}
        actions={
          <>
            {sync.supportsSync ? (
              <SplitButton
                size="sm"
                variant="secondary"
                icon={syncPrimary.icon}
                disabled={syncPrimary.disabled}
                title={syncPrimary.disabled ? queueBusyHint : undefined}
                items={syncMenuItems}
                menuLabel="同步选项"
                onClick={syncPrimary.onClick}
              >
                {syncPrimary.label}
              </SplitButton>
            ) : null}
            {compareActions}
          </>
        }
        filters={
          <CompareFilters
            filterPopoverOpen={filterPopoverOpen}
            onFilterPopoverOpenChange={setFilterPopoverOpen}
            onOpenStrategyDoc={() => openOverlay('strategy-doc')}
          />
        }
      />

      {job.error ? (
        <Panel tone="danger" role="alert" padded={false} className="mx-2 mt-2 shrink-0 rounded-md">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 text-sm text-danger-text">{job.error}</span>
            <Button size="sm" variant="secondary" icon={RefreshCw} disabled={noStrategies} onClick={() => void job.restart()}>
              重试
            </Button>
          </div>
        </Panel>
      ) : null}

      {visibleSyncTask?.lastError ? (
        <p className="mx-2 mt-2 shrink-0 rounded-md border border-danger/40 bg-danger-quiet px-3 py-1.5 text-xs text-danger-text">
          同步错误: {visibleSyncTask.lastError}
        </p>
      ) : null}
    </>
  )
}
