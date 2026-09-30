import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  ChevronsDownUp,
  ChevronsUpDown,
  CirclePlus,
  Columns2,
  Copy,
  EyeOff,
  FileDiff,
  FolderPen,
  FolderSync,
  Folder,
  FolderTree,
  GitCompare,
  History,
  Keyboard,
  Pause,
  Play,
  RefreshCw,
  Save,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  Sun,
  Text,
  Trash2,
  X,
} from 'lucide-react'
import type { CompareHistoryEntry } from '../../../shared/types'
import { useAppStore } from '../stores/app-store'
import { useCompareStore } from '../stores/compare-store'
import { useLogStore } from '../stores/log-store'
import { useSettingsStore } from '../stores/settings-store'
import { useSSHStore } from '../stores/ssh-store'
import { useUIStore } from '../stores/ui-store'
import { getRuntimeInfo } from '../runtime/runtime-info'
import { openCompareTab, startNewCompareSession } from '../utils/compare-session-navigation'
import { navigateToPage } from '../utils/app-navigation'
import { formatCompareTabTitleFromSources } from '../utils/source-label'
import {
  canQueueCompareSync,
  clearCompareSync,
  clearLogPanel,
  copyComparePathPair,
  cycleThemePreference,
  isDiffTabSideDirty,
  openSessionFilterPopover,
  pauseCompareSync,
  requestCloseActiveDiffTab,
  resumeCompareSync,
  saveActiveDiffTabSide,
  showCompareTree,
  startCompareSync,
  swapCompareSources,
  toggleCompareViewMode,
  toggleExpandAllDirs,
  toggleHideDotFiles,
  toggleLogPanel,
} from '../utils/command-actions'
import { useCompareActions } from './useCompare'
import { useOpenHistoryPair } from './useOpenHistoryPair'
import { SHORTCUT } from './shortcuts'
import type { Command } from '../components/ui'

const MAX_RECENT_PAIRS = 8

/** 只在命令面板打开时才去取历史，免得每次启动都白跑一次 IPC。 */
function useRecentHistoryPairs(enabled: boolean): readonly CompareHistoryEntry[] {
  const [pairs, setPairs] = useState<readonly CompareHistoryEntry[]>([])
  const supportsHistory = getRuntimeInfo().supportsHistory

  useEffect(() => {
    if (!enabled || !supportsHistory || typeof window.api.listHistory !== 'function') return

    let cancelled = false
    void (async () => {
      const response = await window.api.listHistory()
      if (cancelled || !response.success || !response.data) return
      setPairs(response.data.slice(0, MAX_RECENT_PAIRS))
    })()

    return () => {
      cancelled = true
    }
  }, [enabled, supportsHistory])

  return pairs
}

export interface UseCommandsOptions {
  /**
   * 只有面板真正打开时才建注册表。这个 hook 订阅了半个 compare store，常驻挂载
   * 会让流式扫描期间的每一条 entry 都触发一次壳层重渲染。
   */
  readonly enabled?: boolean
}

/**
 * 蓝图 chunk 9 第 1 条：命令注册表。
 *
 * 四组固定顺序 —— 导航 · 操作 · 打开 · 设置（PRIMITIVES §18）。
 * §2.3 里每一个被降级的目的地都必须在这里出现一条命令，这正是「降级不等于删除」
 * 这句话唯一的兑现方式（DESIGN-SYSTEM §9 规则 1）。当前不可用的命令带
 * `disabledReason`，而不是变成一行点了没反应的死行。
 *
 * 动作全部来自 `utils/command-actions.ts`——工具栏 `⋯`、同步菜单和全局快捷键层调的
 * 是同一批函数，所以三处不可能各自漂移。
 */
export function useCommands({ enabled = true }: UseCommandsOptions = {}): Command[] {
  const runtime = getRuntimeInfo()
  const openHistoryPair = useOpenHistoryPair()
  const { restartCompare, resumeCompare, pauseCompare, recompareDirtyPaths } = useCompareActions()
  const recentPairs = useRecentHistoryPairs(enabled)

  const openOverlay = useUIStore((state) => state.openOverlay)
  const logVisible = useLogStore((state) => state.visible)
  const logCount = useLogStore((state) => state.logs.length)
  const theme = useSettingsStore((state) => state.theme)
  const sshConfigs = useSSHStore((state) => state.configs)
  const loadSSHConfigs = useSSHStore((state) => state.loadConfigs)

  const { page, compareTabs, diffTabs, activeDiffTabId } = useAppStore(useShallow((state) => ({
    page: state.page,
    compareTabs: state.compareTabs,
    diffTabs: state.diffTabs,
    activeDiffTabId: state.activeDiffTabId,
  })))

  const {
    scanning,
    comparing,
    paused,
    dirtyCount,
    strategyCount,
    viewMode,
    hideDot,
    syncStatus,
    entryCount,
    allExpanded,
    syncEligible,
  } = useCompareStore(useShallow((state) => ({
    scanning: state.scanning,
    comparing: state.comparing,
    paused: state.paused,
    dirtyCount: state.dirtyPaths.size,
    strategyCount: state.strategies.length,
    viewMode: state.viewMode,
    hideDot: state.hideDot,
    syncStatus: state.syncTask?.status ?? null,
    entryCount: state.entries.length,
    // 命令标题里出现的派生值必须**订阅**，否则面板开着时它们不会跟着变。
    allExpanded: state.entrySummary.allDirCount > 0
      && state.expandedDirs.size >= state.entrySummary.allDirCount,
    syncEligible: state.done
      && !state.scanning
      && !state.comparing
      && state.entrySummary.pendingCount === 0
      && state.entrySummary.stats.total > 0,
  })))

  // SFTP 连接要能作为「打开」项出现，就得先有列表；面板打开时补一次即可。
  useEffect(() => {
    if (!enabled || !runtime.supportsSftp || sshConfigs.length > 0) return
    void loadSSHConfigs()
  }, [enabled, loadSSHConfigs, runtime.supportsSftp, sshConfigs.length])

  const activeDiffTab = useMemo(
    () => diffTabs.find((tab) => tab.id === activeDiffTabId) ?? null,
    [activeDiffTabId, diffTabs],
  )

  return useMemo<Command[]>(() => {
    if (!enabled) return []

    const loading = scanning || comparing
    const noStrategies = strategyCount === 0
    const inCompare = page === 'compare'
    const compareOnly = inCompare ? undefined : '先切到目录对比'

    const commands: Command[] = []

    // ---- Navigate --------------------------------------------------------

    commands.push(
      {
        id: 'nav-compare',
        title: '目录对比',
        group: 'navigate',
        icon: Folder,
        hint: '对比工作区',
        keywords: 'home directory compare 目录对比 结果 工作区',
        perform: () => {
          if (page === 'compare') return
          // `openCompareTab()` 自己会 setPage；有活动标签就是结果态，没有就是 setup 态。
          navigateToPage('compare')
        },
      },
      {
        id: 'nav-text',
        title: '文本对比',
        group: 'navigate',
        icon: Text,
        hint: '比对粘贴或拖入的文本',
        keywords: 'text compare 文本对比 粘贴',
        perform: () => {
          if (page === 'text') return
          // 与顶栏模式切换同一条路径：离开工作区前把 live 会话写回它的标签。
          navigateToPage('text')
        },
      },
    )

    // ---- Actions ---------------------------------------------------------

    commands.push(
      {
        id: 'action-new-compare',
        title: '新建对比',
        group: 'action',
        icon: CirclePlus,
        shortcut: SHORTCUT.newCompare,
        hint: '在工作区里开一个空白对比',
        keywords: 'new compare 新建对比 标签',
        perform: () => startNewCompareSession(),
      },
      {
        id: 'action-restart-compare',
        title: loading || entryCount > 0 ? '重启对比' : '开始对比',
        group: 'action',
        icon: loading || entryCount > 0 ? RefreshCw : Play,
        shortcut: SHORTCUT.restartCompare,
        keywords: 'run restart compare 开始 重启 对比 重新',
        disabled: !inCompare || noStrategies,
        disabledReason: compareOnly ?? '至少选择一个比较依据',
        perform: () => {
          void restartCompare()
        },
      },
      {
        id: 'action-pause-compare',
        title: '暂停对比',
        group: 'action',
        icon: Pause,
        shortcut: SHORTCUT.cancelJob,
        keywords: 'pause cancel compare 暂停 取消 对比',
        disabled: !loading,
        disabledReason: '当前没有正在跑的对比',
        perform: () => void pauseCompare(),
      },
      {
        id: 'action-resume-compare',
        title: '继续对比',
        group: 'action',
        icon: Play,
        keywords: 'resume compare 继续 恢复 对比',
        disabled: !paused || noStrategies,
        disabledReason: paused ? '至少选择一个比较依据' : '对比没有处于暂停状态',
        perform: () => {
          void resumeCompare()
        },
      },
      {
        id: 'action-recompare-dirty',
        title: `重比变更 (${dirtyCount})`,
        group: 'action',
        icon: RefreshCw,
        keywords: 'recompare dirty 重比 变更 增量',
        disabled: dirtyCount === 0 || loading || noStrategies,
        disabledReason: dirtyCount === 0 ? '磁盘上没有检测到变更' : '对比正在运行',
        perform: () => {
          void recompareDirtyPaths()
        },
      },
      {
        id: 'action-edit-sources',
        title: '编辑数据源…',
        group: 'action',
        icon: FolderPen,
        shortcut: SHORTCUT.editSources,
        hint: '来源类型、路径、比较依据与会话过滤',
        keywords: 'edit source 编辑数据源 路径 目录 策略 过滤',
        perform: () => {
          openCompareTab()
          openOverlay('compare-setup')
        },
      },
      {
        id: 'action-session-filter',
        title: '会话过滤规则…',
        group: 'action',
        icon: SlidersHorizontal,
        shortcut: SHORTCUT.focusFilter,
        keywords: 'filter 过滤 规则 排除 glob 会话',
        disabled: !inCompare,
        disabledReason: compareOnly,
        perform: openSessionFilterPopover,
      },
      {
        id: 'action-swap-sources',
        title: '交换左右',
        group: 'action',
        icon: ArrowLeftRight,
        keywords: 'swap sides 交换 左右 对调',
        perform: () => swapCompareSources(),
      },
      {
        id: 'action-expand-all',
        title: allExpanded ? '收起全部目录' : '展开全部目录',
        group: 'action',
        icon: allExpanded ? ChevronsDownUp : ChevronsUpDown,
        keywords: 'expand collapse 展开 收起 全部 目录',
        disabled: !inCompare,
        disabledReason: compareOnly,
        perform: () => toggleExpandAllDirs(),
      },
      {
        id: 'action-toggle-view-mode',
        title: viewMode === 'split' ? '切换到合并视图' : '切换到分栏视图',
        group: 'action',
        icon: Columns2,
        keywords: 'view mode split merged 视图 分栏 合并 切换',
        disabled: !inCompare,
        disabledReason: compareOnly,
        perform: () => toggleCompareViewMode(),
      },
      {
        id: 'action-toggle-hide-dot',
        title: hideDot ? '显示点文件' : '隐藏点文件',
        group: 'action',
        icon: EyeOff,
        keywords: 'dotfile hidden 隐藏 点文件 显示',
        disabled: !inCompare,
        disabledReason: compareOnly,
        perform: () => toggleHideDotFiles(),
      },
      {
        id: 'action-copy-path-pair',
        title: '复制路径对',
        group: 'action',
        icon: Copy,
        keywords: 'copy path pair 复制 路径对 剪贴板',
        perform: () => void copyComparePathPair(),
      },
    )

    if (runtime.supportsSync) {
      const syncBlocked = syncEligible ? '同步队列被另一次对比占用' : '需要一次已完成的对比'

      commands.push(
        {
          id: 'action-sync-right',
          title: '同步到右',
          group: 'action',
          icon: ArrowRight,
          keywords: 'sync copy right 同步 到右 复制',
          disabled: !syncEligible || !canQueueCompareSync('left_to_right'),
          disabledReason: syncBlocked,
          perform: () => void startCompareSync('left_to_right'),
        },
        {
          id: 'action-sync-left',
          title: '同步到左',
          group: 'action',
          icon: ArrowLeft,
          keywords: 'sync copy left 同步 到左 复制',
          disabled: !syncEligible || !canQueueCompareSync('right_to_left'),
          disabledReason: syncBlocked,
          perform: () => void startCompareSync('right_to_left'),
        },
        {
          id: 'action-sync-pause',
          title: '暂停同步',
          group: 'action',
          icon: Pause,
          keywords: 'pause sync 暂停 同步',
          disabled: syncStatus !== 'running',
          disabledReason: '当前没有正在跑的同步',
          perform: () => void pauseCompareSync(),
        },
        {
          id: 'action-sync-resume',
          title: '继续同步',
          group: 'action',
          icon: Play,
          keywords: 'resume sync 继续 恢复 同步',
          disabled: syncStatus !== 'paused' && syncStatus !== 'failed',
          disabledReason: '同步没有处于暂停或失败状态',
          perform: () => void resumeCompareSync(),
        },
        {
          id: 'action-sync-clear',
          title: '清除同步',
          group: 'action',
          icon: Trash2,
          keywords: 'clear sync 清除 同步 队列',
          disabled: syncStatus === null || syncStatus === 'running',
          disabledReason: syncStatus === 'running' ? '同步正在运行，先暂停' : '同步队列是空的',
          perform: () => void clearCompareSync(),
        },
      )
    }

    if (runtime.supportsWriteBack) {
      for (const side of ['left', 'right'] as const) {
        const dirty = activeDiffTab ? isDiffTabSideDirty(activeDiffTab, side) : false
        commands.push({
          id: `action-save-${side}`,
          title: side === 'left' ? '保存左侧' : '保存右侧',
          group: 'action',
          icon: Save,
          shortcut: side === 'left' ? SHORTCUT.saveLeft : SHORTCUT.saveRight,
          hint: activeDiffTab?.fileName,
          keywords: `save ${side} 保存 ${side === 'left' ? '左侧' : '右侧'} 文件`,
          disabled: !dirty,
          disabledReason: activeDiffTab ? '这一侧没有未保存的改动' : '先打开一个文件 Diff',
          perform: () => void saveActiveDiffTabSide(side),
        })
      }
    }

    if (activeDiffTab) {
      commands.push(
        {
          id: 'action-close-diff-tab',
          title: '关闭当前文件标签',
          group: 'action',
          icon: X,
          shortcut: SHORTCUT.closeDiffTab,
          hint: activeDiffTab.fileName,
          keywords: 'close diff tab 关闭 文件 标签',
          perform: () => requestCloseActiveDiffTab(),
        },
        {
          id: 'action-back-to-tree',
          title: '回到目录树',
          group: 'action',
          icon: FolderTree,
          shortcut: SHORTCUT.backToTree,
          keywords: 'tree back 目录树 返回 结果',
          perform: () => showCompareTree(),
        },
      )
    }

    commands.push(
      {
        id: 'action-toggle-log',
        title: logVisible ? '收起日志面板' : '展开日志面板',
        group: 'action',
        icon: ScrollText,
        shortcut: SHORTCUT.toggleLog,
        hint: logCount > 0 ? `${logCount} 条` : undefined,
        keywords: 'log 日志 toggle 切换 开关 面板',
        perform: () => toggleLogPanel(),
      },
      {
        id: 'action-clear-log',
        title: '清空日志',
        group: 'action',
        icon: Trash2,
        keywords: 'log 日志 clear 清空 清除',
        disabled: logCount === 0,
        disabledReason: '日志已经是空的',
        perform: () => clearLogPanel(),
      },
      {
        id: 'action-cycle-theme',
        title: '切换主题',
        group: 'action',
        icon: Sun,
        hint: theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色',
        keywords: 'theme dark light system 主题 深色 浅色 跟随系统 切换',
        perform: () => cycleThemePreference(),
      },
    )

    // ---- Open ------------------------------------------------------------

    for (const tab of compareTabs) {
      commands.push({
        id: `open-compare-tab-${tab.id}`,
        title: tab.title,
        group: 'open',
        icon: GitCompare,
        hint: '对比标签',
        keywords: `tab compare 对比 标签 切换 ${tab.title}`,
        perform: () => {
          openCompareTab(tab.id)
        },
      })
    }

    for (const tab of diffTabs) {
      commands.push({
        id: `open-diff-tab-${tab.id}`,
        title: tab.fileName,
        group: 'open',
        icon: FileDiff,
        hint: tab.relativePath,
        keywords: `diff file 文件 差异 标签 ${tab.relativePath}`,
        perform: () => useAppStore.getState().setActiveDiffTab(tab.id),
      })
    }

    for (const entry of recentPairs) {
      commands.push({
        id: `open-history-${entry.id}`,
        title: formatCompareTabTitleFromSources(entry.leftSource, entry.rightSource, sshConfigs),
        group: 'open',
        icon: History,
        hint: '打开最近对比',
        recentAt: entry.timestamp,
        keywords: `history recent 历史 最近 对比 重新 ${entry.leftSource.path} ${entry.rightSource.path}`,
        perform: () => openHistoryPair(entry),
      })
    }

    for (const config of sshConfigs) {
      commands.push({
        id: `open-ssh-${config.id}`,
        title: config.label,
        group: 'open',
        icon: Server,
        hint: `${config.username}@${config.host}`,
        keywords: `ssh sftp 连接 服务器 ${config.host} ${config.username}`,
        perform: () => {
          // 开一个新的 setup 态标签，左侧预填这台机器——用户只要补一个路径。
          startNewCompareSession()
          const state = useCompareStore.getState()
          state.setLeftSourceType('sftp')
          state.setLeftSSHConfigId(config.id)
          useAppStore.getState().setPage('compare')
          useUIStore.getState().openOverlay('compare-setup')
        },
      })
    }

    // ---- Settings --------------------------------------------------------

    commands.push({
      id: 'settings-open',
      title: '设置…',
      group: 'settings',
      icon: Settings,
      shortcut: SHORTCUT.settings,
      hint: '外观 · 对比 · 过滤',
      keywords: 'settings preferences 设置 配置 偏好',
      perform: () => openOverlay('settings'),
    })

    if (runtime.supportsSftp) {
      commands.push({
        id: 'settings-ssh',
        title: 'SSH 连接管理…',
        group: 'navigate',
        icon: Server,
        keywords: 'ssh sftp 管理 连接 服务器',
        perform: () => navigateToPage('ssh'),
      })
    }

    if (runtime.supportsHistory) {
      commands.push({
        id: 'settings-history',
        title: '对比历史…',
        group: 'navigate',
        icon: History,
        keywords: 'history 历史 记录 归档',
        perform: () => navigateToPage('history'),
      })
    }

    if (runtime.supportsSync) {
      commands.push({
        id: 'settings-sync',
        title: '同步任务…',
        group: 'settings',
        icon: FolderSync,
        keywords: 'sync 同步 任务 队列 列表',
        perform: () => openOverlay('sync'),
      })
    }

    commands.push(
      {
        id: 'settings-strategy-doc',
        title: '对比策略说明…',
        group: 'settings',
        icon: BookOpen,
        keywords: 'strategy doc 策略 说明 依据 文档 哈希 签名',
        perform: () => openOverlay('strategy-doc'),
      },
      {
        id: 'settings-shortcuts',
        title: '快捷键…',
        group: 'settings',
        icon: Keyboard,
        shortcut: SHORTCUT.shortcutHelp,
        keywords: 'shortcut help keyboard 快捷键 帮助 按键',
        perform: () => openOverlay('shortcuts'),
      },
    )

    return commands
  }, [
    activeDiffTab,
    allExpanded,
    comparing,
    compareTabs,
    diffTabs,
    dirtyCount,
    enabled,
    entryCount,
    hideDot,
    logCount,
    logVisible,
    openHistoryPair,
    openOverlay,
    page,
    pauseCompare,
    paused,
    recentPairs,
    recompareDirtyPaths,
    restartCompare,
    resumeCompare,
    runtime.supportsHistory,
    runtime.supportsSftp,
    runtime.supportsSync,
    runtime.supportsWriteBack,
    scanning,
    sshConfigs,
    strategyCount,
    syncEligible,
    syncStatus,
    theme,
    viewMode,
  ])
}
