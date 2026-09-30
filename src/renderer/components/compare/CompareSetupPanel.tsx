import { confirmUnsavedChanges, isDiffTabDirty } from '../../utils/unsaved-changes'
import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowLeftRight, FolderOpen, History, Play } from 'lucide-react'
import type { StrategyName } from '../../../../shared/types'
import { useCompareStore } from '../../stores/compare-store'
import { useAppStore } from '../../stores/app-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import { useCompareActions } from '../../hooks/useCompare'
import { useCompareSetupShortcut } from '../../hooks/useCompareSetupShortcut'
import { isSubmitKey } from '../../utils/submit-key'
import { isFilterAdditionOnly } from '../../utils/filter-change'
import { getRuntimeInfo } from '../../runtime/runtime-info'
import SourceSelector from '../SourceSelector'
import { Button, EmptyState, Panel } from '../ui'
import FilterPopover from './FilterPopover'
import StrategyChips from './StrategyChips'
import StrategyDocDialog from './StrategyDocDialog'

export interface CompareSetupPanelProps {
  /**
   * `page` = 对比标签的 setup 内容区；`dialog` = `⋯ → 编辑数据源…`。
   * 后者复用同一个活动标签重新跑（F3），前者开一个新标签。
   */
  readonly variant?: 'page' | 'dialog'
  readonly onSubmitted?: () => void
}

function describeMissingInput(leftPath: string, rightPath: string, strategyCount: number): string | null {
  if (!leftPath || !rightPath) {
    return '选择左右目录'
  }
  if (strategyCount === 0) {
    return '至少选择一个比较依据'
  }
  return null
}

/**
 * 蓝图 §4.2 / chunk 5 第 1 条：唯一的数据源编辑面板。
 *
 * 吸收了 `HomePage.tsx:137-246`（数据源卡片、策略卡片、过滤摘要、CTA）与
 * `CompareToolbar.tsx:269-296`（策略筛选片）。两个挂载点、一份实现，不会再出现
 * 「同一件事两块界面」的分叉（§1.2.1）。
 */
export default function CompareSetupPanel({ variant = 'page', onSubmitted }: CompareSetupPanelProps) {
  const [strategyDocOpen, setStrategyDocOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const runtime = getRuntimeInfo()
  const openOverlay = useUIStore((s) => s.openOverlay)
  const globalPathFilters = useSettingsStore((s) => s.globalPathFilters)
  const compareTabCount = useAppStore((s) => s.compareTabs.length)
  const { runCompare, rerunActiveSessionIfRunning } = useCompareActions()

  const {
    leftSourceType,
    rightSourceType,
    leftPath,
    rightPath,
    leftSSHConfigId,
    rightSSHConfigId,
    strategies,
    extensionFilter,
    error,
    loading,
    setLeftSourceType,
    setRightSourceType,
    setLeftPath,
    setRightPath,
    setLeftSSHConfigId,
    setRightSSHConfigId,
    setStrategies,
    setExtensionFilter,
  } = useCompareStore(useShallow((s) => ({
    leftSourceType: s.leftSourceType,
    rightSourceType: s.rightSourceType,
    leftPath: s.leftPath,
    rightPath: s.rightPath,
    leftSSHConfigId: s.leftSSHConfigId,
    rightSSHConfigId: s.rightSSHConfigId,
    strategies: s.strategies,
    extensionFilter: s.extensionFilter,
    error: s.error,
    loading: s.scanning || s.comparing,
    setLeftSourceType: s.setLeftSourceType,
    setRightSourceType: s.setRightSourceType,
    setLeftPath: s.setLeftPath,
    setRightPath: s.setRightPath,
    setLeftSSHConfigId: s.setLeftSSHConfigId,
    setRightSSHConfigId: s.setRightSSHConfigId,
    setStrategies: s.setStrategies,
    setExtensionFilter: s.setExtensionFilter,
  })))

  const handleSwapSources = () => {
    const previousLeft = { type: leftSourceType, path: leftPath, configId: leftSSHConfigId }
    setLeftSourceType(rightSourceType)
    setLeftPath(rightPath)
    setLeftSSHConfigId(rightSSHConfigId)
    setRightSourceType(previousLeft.type)
    setRightPath(previousLeft.path)
    setRightSSHConfigId(previousLeft.configId)
  }

  const handleToggleStrategy = (name: StrategyName) => {
    const next = [...strategies]
    const index = next.indexOf(name)
    if (index >= 0) {
      next.splice(index, 1)
    } else {
      next.push(name)
    }
    setStrategies(next)
  }

  const handleSessionFilterChange = async (patterns: readonly string[]) => {
    const previousFilters = useCompareStore.getState().extensionFilter
    setExtensionFilter(patterns)
    const activeTabId = useAppStore.getState().activeCompareTabId
    if (activeTabId) {
      useAppStore.getState().updateCompareTabSnapshot(activeTabId, () => useCompareStore.getState().createTabSnapshot())
    }

    if (isFilterAdditionOnly(previousFilters, patterns)) {
      return
    }

    await rerunActiveSessionIfRunning()
  }

  const handlePickFolder = async () => {
    const result = await window.api.selectFolder()
    if (!result.success || !result.data) return
    if (!leftPath) {
      setLeftPath(result.data)
      return
    }
    setRightPath(result.data)
  }

  const missingInput = describeMissingInput(leftPath, rightPath, strategies.length)
  const submitDisabled = submitting || loading || missingInput !== null

  const handleSubmit = async () => {
    const state = useCompareStore.getState()
    if (submittingRef.current || state.scanning || state.comparing
      || describeMissingInput(state.leftPath, state.rightPath, state.strategies.length)) return

    submittingRef.current = true
    setSubmitting(true)
    try {
      if (variant === 'dialog' && useAppStore.getState().diffTabs.some(isDiffTabDirty)) {
        const sessionId = useAppStore.getState().activeCompareTabId
        if (!await confirmUnsavedChanges() || !panelRef.current
          || sessionId !== useAppStore.getState().activeCompareTabId) return
        useAppStore.getState().clearDiffTabs()
      }
      const pending = runCompare(variant === 'dialog' ? { reuseActiveSession: true } : undefined)
      onSubmitted?.()
      await pending
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  useCompareSetupShortcut(panelRef, handleSubmit)

  const submitLabel = variant === 'dialog' ? '应用并重新对比' : '开始对比'
  const submitHint = missingInput ?? '按 Enter 直接开始'
  const showFirstRun = variant === 'page' && compareTabCount === 0 && !leftPath && !rightPath

  return (
    <div ref={panelRef} className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
      {showFirstRun && (
        <EmptyState
          variant="first-run"
          icon={FolderOpen}
          title="还没有做过目录对比"
          description="选择左右两个目录，或从历史里挑一次以前的对比。"
          action={
            <Button variant="secondary" icon={FolderOpen} onClick={() => void handlePickFolder()}>
              选择目录…
            </Button>
          }
          secondaryAction={runtime.supportsHistory ? (
            <Button variant="ghost" icon={History} onClick={() => openOverlay('history')}>
              从历史打开…
            </Button>
          ) : undefined}
          size="sm"
        />
      )}

      <Panel
        header={
          <>
            <span className="text-xs font-medium text-fg-muted">数据源</span>
            <Button
              size="sm"
              variant="secondary"
              icon={ArrowLeftRight}
              className="ml-auto"
              disabled={!leftPath && !rightPath}
              title="交换左右数据源"
              onClick={handleSwapSources}
            >
              交换左右
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <SourceSelector
            label="左侧"
            sourceType={leftSourceType}
            path={leftPath}
            sshConfigId={leftSSHConfigId}
            onSourceTypeChange={setLeftSourceType}
            onPathChange={setLeftPath}
            onSSHConfigIdChange={setLeftSSHConfigId}
            onSubmit={handleSubmit}
          />
          <SourceSelector
            label="右侧"
            sourceType={rightSourceType}
            path={rightPath}
            sshConfigId={rightSSHConfigId}
            onSourceTypeChange={setRightSourceType}
            onPathChange={setRightPath}
            onSSHConfigIdChange={setRightSSHConfigId}
            onSubmit={handleSubmit}
          />
        </div>
      </Panel>

      <Panel
        header={
          <>
            <span className="text-xs font-medium text-fg-muted">比较依据</span>
            <Button variant="link" size="sm" className="ml-auto" onClick={() => setStrategyDocOpen(true)}>
              策略说明…
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <StrategyChips strategies={strategies} onToggle={handleToggleStrategy} />
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <span className="text-xs font-medium text-fg-muted">过滤</span>
            <FilterPopover extensionFilter={extensionFilter} onChange={handleSessionFilterChange} label="编辑过滤…" />
            <span className="text-xs text-fg-muted">
              会话 <span className="tabular-nums text-fg">{extensionFilter.length}</span> 条 ·
              全局 <span className="tabular-nums text-fg">{globalPathFilters.length}</span> 条
            </span>
          </div>
        </div>
      </Panel>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="lg"
          icon={Play}
          loading={loading}
          disabled={submitDisabled}
          aria-describedby="compare-setup-hint"
          onClick={handleSubmit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isSubmitKey(event.nativeEvent)) event.preventDefault()
          }}
        >
          {submitLabel}
        </Button>
        <span
          id="compare-setup-hint"
          className={missingInput ? 'text-xs text-warning-text' : 'text-xs text-fg-muted'}
        >
          {submitHint}
        </span>
      </div>

      {error && (
        <Panel tone="danger" role="alert">
          <span className="text-sm text-danger-text">{error}</span>
        </Panel>
      )}

      <StrategyDocDialog open={strategyDocOpen} onOpenChange={setStrategyDocOpen} />
    </div>
  )
}
