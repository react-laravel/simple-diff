import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, Play, Trash2 } from 'lucide-react'
import type { CompareHistoryEntry, SSHConfig, SourceConfig } from '../../../../shared/types'
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  IconButton,
  Skeleton,
  ToggleGroup,
  type Column,
  type ToggleGroupOption,
} from '../ui'
import { useOpenHistoryPair } from '../../hooks/useOpenHistoryPair'
import { truncatePath } from '../../utils/tree-utils'
import ManagementSurface from '../ManagementSurface'

export interface HistoryDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly variant?: 'dialog' | 'page'
}

function extractSavedSftpLabel(savedLabel: string, configId: string): string | null {
  if (!savedLabel.startsWith('sftp://')) return null

  const body = savedLabel.slice('sftp://'.length)
  const separatorIndex = body.indexOf(':')
  if (separatorIndex < 0) return null

  const candidate = body.slice(0, separatorIndex).trim()
  if (!candidate || candidate === configId) {
    return null
  }

  return candidate
}

function formatHistorySourceLabel(
  source: SourceConfig,
  savedLabel: string,
  sshLabelsById: ReadonlyMap<string, string>,
): string {
  if (source.type === 'local') {
    return source.path
  }

  const resolvedLabel = sshLabelsById.get(source.configId)
    ?? extractSavedSftpLabel(savedLabel, source.configId)
    ?? 'SFTP'

  return `${resolvedLabel}:${source.path}`
}

function buildHistorySourceFilterKey(
  source: SourceConfig,
  sshHostsById: ReadonlyMap<string, string>,
): string {
  if (source.type === 'local') {
    return `local:${source.path}`
  }

  return `sftp:${sshHostsById.get(source.configId) ?? source.configId}:${source.path}`
}

function buildHistoryPairFilterKey(
  entry: CompareHistoryEntry,
  sshHostsById: ReadonlyMap<string, string>,
): string {
  return `${buildHistorySourceFilterKey(entry.leftSource, sshHostsById)}↔${buildHistorySourceFilterKey(entry.rightSource, sshHostsById)}`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface HistoryRow {
  readonly entry: CompareHistoryEntry
  readonly leftLabel: string
  readonly rightLabel: string
}

type PendingDeletion =
  | { readonly kind: 'one'; readonly id: string; readonly subject: string }
  | { readonly kind: 'all' }

/**
 * 蓝图 §4.7 / chunk 8 第 2 条：`pages/HistoryPage.tsx` 从一个顶层页面降级成叠加层。
 *
 * 三处实质变化：
 * 1. 列表换成 `DataTable variant="report"`，行可用键盘激活（Enter / Space = 重新对比）。
 *    旧的一堆 `StatPill` 换成 `Badge`。
 * 2. `重新对比` 真的会跑（F8）：`useOpenHistoryPair()` 直接开一个正在运行的新标签，
 *    旧代码只写了六个 store 字段然后 `setPage('home')`，用户要在另一块界面再按一次。
 * 3. 删除 / 清空走 `ConfirmDialog`，不再是点了就没。
 */
// 历史现在也可从顶栏直接打开；首次使用时的上下文入口继续使用对话框。
export default function HistoryDialog({ open, onOpenChange, variant = 'dialog' }: HistoryDialogProps) {
  const [entries, setEntries] = useState<readonly CompareHistoryEntry[]>([])
  const [sshConfigs, setSSHConfigs] = useState<readonly SSHConfig[]>([])
  const [pairFilter, setPairFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null)
  const openHistoryPair = useOpenHistoryPair()

  const sshLabelsById = useMemo(
    () => new Map(sshConfigs.map((config) => [config.id, config.label])),
    [sshConfigs],
  )
  const sshHostsById = useMemo(
    () => new Map(sshConfigs.map((config) => [config.id, config.host])),
    [sshConfigs],
  )

  const load = useCallback(async () => {
    setLoading(true)
    const [historyResult, sshConfigsResult] = await Promise.all([
      window.api.listHistory(),
      window.api.listSSHConfigs(),
    ])

    if (historyResult.success && historyResult.data) {
      setEntries(historyResult.data)
    }

    if (sshConfigsResult.success && sshConfigsResult.data) {
      setSSHConfigs(sshConfigsResult.data)
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [load, open])

  const pairOptions = useMemo<ToggleGroupOption<string>[]>(() => {
    const optionMap = new Map<string, { leftLabel: string; rightLabel: string; count: number }>()

    for (const entry of entries) {
      const value = buildHistoryPairFilterKey(entry, sshHostsById)
      const existing = optionMap.get(value)

      if (existing) {
        optionMap.set(value, { ...existing, count: existing.count + 1 })
        continue
      }

      optionMap.set(value, {
        leftLabel: formatHistorySourceLabel(entry.leftSource, entry.leftLabel, sshLabelsById),
        rightLabel: formatHistorySourceLabel(entry.rightSource, entry.rightLabel, sshLabelsById),
        count: 1,
      })
    }

    return [
      { value: 'all', label: '全部', ariaLabel: '全部历史', count: entries.length },
      ...[...optionMap.entries()].map(([value, { leftLabel, rightLabel, count }]) => {
        // 可访问名字用完整路径，可见文案用截断版——名字不随布局变化。
        const fullLabel = `${leftLabel} ↔ ${rightLabel}`
        return {
          value,
          label: `${truncatePath(leftLabel)} ↔ ${truncatePath(rightLabel)}`,
          ariaLabel: fullLabel,
          title: fullLabel,
          count,
        }
      }),
    ]
  }, [entries, sshHostsById, sshLabelsById])

  const rows = useMemo<HistoryRow[]>(() => {
    const filtered = pairFilter === 'all'
      ? entries
      : entries.filter((entry) => buildHistoryPairFilterKey(entry, sshHostsById) === pairFilter)

    return filtered.map((entry) => ({
      entry,
      leftLabel: formatHistorySourceLabel(entry.leftSource, entry.leftLabel, sshLabelsById),
      rightLabel: formatHistorySourceLabel(entry.rightSource, entry.rightLabel, sshLabelsById),
    }))
  }, [entries, pairFilter, sshHostsById, sshLabelsById])

  useEffect(() => {
    if (pairFilter === 'all') return
    if (pairOptions.some((option) => option.value === pairFilter)) return
    setPairFilter('all')
  }, [pairFilter, pairOptions])

  const handleRerun = useCallback((entry: CompareHistoryEntry) => {
    openHistoryPair(entry)
    onOpenChange(false)
  }, [onOpenChange, openHistoryPair])

  const handleConfirmDeletion = useCallback(async () => {
    if (!pendingDeletion) return

    if (pendingDeletion.kind === 'all') {
      await window.api.clearHistory()
      setEntries([])
    } else {
      await window.api.deleteHistory(pendingDeletion.id)
      setEntries((previous) => previous.filter((entry) => entry.id !== pendingDeletion.id))
    }

    setPendingDeletion(null)
  }, [pendingDeletion])

  const columns = useMemo<Column<HistoryRow>[]>(() => [
    {
      id: 'time',
      header: '时间',
      width: 116,
      cell: (row) => <span className="tabular-nums">{formatTime(row.entry.timestamp)}</span>,
    },
    {
      id: 'pair',
      header: '数据源',
      mono: true,
      cell: (row) => (
        <span title={`${row.leftLabel} ↔ ${row.rightLabel}`}>
          {truncatePath(row.leftLabel)}
          <span className="mx-1.5 text-fg-subtle">↔</span>
          {truncatePath(row.rightLabel)}
        </span>
      ),
    },
    {
      id: 'stats',
      header: '统计',
      width: 240,
      truncate: false,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone="warning" size="xs" className="tabular-nums">不同 {row.entry.stats.different}</Badge>
          <Badge tone="neutral" size="xs" className="tabular-nums">仅左 {row.entry.stats.leftOnly}</Badge>
          <Badge tone="neutral" size="xs" className="tabular-nums">仅右 {row.entry.stats.rightOnly}</Badge>
          <Badge tone="success" size="xs" className="tabular-nums">相同 {row.entry.stats.equal}</Badge>
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      width: 72,
      align: 'right',
      truncate: false,
      cell: (row) => (
        <span className="flex items-center justify-end gap-0.5">
          <IconButton
            icon={Play}
            size="xs"
            variant="ghost"
            label={`重新对比 ${row.leftLabel} ↔ ${row.rightLabel}`}
            onClick={(event) => {
              event.stopPropagation()
              handleRerun(row.entry)
            }}
          />
          <IconButton
            icon={Trash2}
            size="xs"
            variant="danger-ghost"
            label={`删除 ${row.leftLabel} ↔ ${row.rightLabel}`}
            onClick={(event) => {
              event.stopPropagation()
              setPendingDeletion({
                kind: 'one',
                id: row.entry.id,
                subject: `${row.leftLabel} ↔ ${row.rightLabel}`,
              })
            }}
          />
        </span>
      ),
    },
  ], [handleRerun])

  return (
    <>
      <ManagementSurface
        variant={variant}
        open={open}
        onOpenChange={onOpenChange}
        title="对比历史"
        description={loading ? '正在加载…' : `共 ${entries.length} 条记录`}
        size="xl"
        footer={
          <>
            {entries.length > 0 ? (
              <Button
                variant="danger-ghost"
                icon={Trash2}
                onClick={() => setPendingDeletion({ kind: 'all' })}
              >
                清空历史
              </Button>
            ) : null}
            {variant === 'dialog' ? <Button variant="secondary" onClick={() => onOpenChange(false)}>关闭</Button> : null}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {loading ? <Skeleton variant="row" count={6} /> : null}

          {!loading && entries.length === 0 ? (
            <EmptyState
              variant="first-run"
              icon={History}
              title="暂无对比历史"
              description="完成一次目录对比后，结果会自动归档到这里。"
              action={<Button variant="primary" onClick={() => onOpenChange(false)}>回到对比工作区</Button>}
              size="sm"
            />
          ) : null}

          {!loading && entries.length > 0 ? (
            <>
              <ToggleGroup
                aria-label="对比组合"
                variant="chips"
                size="sm"
                value={pairFilter}
                onValueChange={setPairFilter}
                options={pairOptions}
              />

              <DataTable
                aria-label="对比历史列表"
                variant="report"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.entry.id}
                onRowActivate={(row) => handleRerun(row.entry)}
                empty={
                  <EmptyState
                    variant="no-results"
                    title="当前筛选下没有记录"
                    description="换一个对比组合，或者看全部历史。"
                    action={<Button variant="secondary" onClick={() => setPairFilter('all')}>清除筛选</Button>}
                    size="sm"
                  />
                }
              />
            </>
          ) : null}
        </div>
      </ManagementSurface>

      <ConfirmDialog
        open={pendingDeletion !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeletion(null)
        }}
        tone="danger"
        title={pendingDeletion?.kind === 'all' ? '清空全部对比历史？' : '删除这条对比历史？'}
        subject={pendingDeletion?.kind === 'one' ? pendingDeletion.subject : undefined}
        body={pendingDeletion?.kind === 'all' ? `将删除全部 ${entries.length} 条记录。` : undefined}
        consequence="此操作无法撤销。"
        confirmLabel={pendingDeletion?.kind === 'all' ? '清空' : '删除'}
        onConfirm={handleConfirmDeletion}
      />
    </>
  )
}
