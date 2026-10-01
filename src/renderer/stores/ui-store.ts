import type { StartSyncRequest, SyncPlanPreview } from '../../../shared/types'
import { create } from 'zustand'
import type { StatusTone } from '../components/ui'
import type { CompareSelectionState } from '../utils/compare-selection'
import type { DiffTab } from './app-store'

export interface UnsavedChangesRequest {
  readonly tabs: readonly DiffTab[]
  readonly resolve: (proceed: boolean) => void
}

/**
 * 壳层叠加层。设计蓝图 §2.2：被降级的目的地都落在应用菜单 `⋯`、状态栏或命令面板里，
 * 而不再占用顶层导航槽位。它们统一挂载一次（`components/overlays/OverlayHost.tsx`）。
 */
export type OverlayKind =
  | 'palette'
  | 'shortcuts'
  | 'settings'
  | 'history'
  | 'ssh'
  | 'sync'
  /** F3 的「编辑数据源…」。放在这里而不是 `ComparePage` 的局部 state，`⌘K` 才能开它。 */
  | 'compare-setup'
  /** 对比策略说明。同理：工具栏 `⋯` 与 `⌘K` 用的是同一个开合状态。 */
  | 'strategy-doc'

export interface StatusHint {
  readonly tone: StatusTone
  readonly label: string
}

interface UIStore {
  /** 同一时刻只允许一个叠加层，`Esc` 关闭最上层。 */
  readonly overlay: OverlayKind | null
  /**
   * 会话过滤弹层的开合。`⌘F`（蓝图 §5「聚焦当前视图的筛选」）由全局快捷键层处理，
   * 所以这个状态不能藏在 `CompareToolbar` 的局部 state 里——工具栏在打开文件 Diff
   * 时根本不渲染。
   */
  readonly fileSearchOpen: boolean
  readonly filterPopoverOpen: boolean
  /** 目录树选择态。两个树视图（分栏 / 合并）共用，状态栏据此渲染“已选 n 项”。 */
  readonly treeSelection: CompareSelectionState
  /**
   * 等待确认关闭的文件差异标签（有未保存修改时）。
   *
   * 放在这里而不是 `DiffTabStrip` 的局部 state：`⌘W` 由全局快捷键层处理，标签条的
   * `×`、右键菜单的「关闭其他 / 关闭全部」和 `⌘K` 的关闭命令必须走同一条确认路径，
   * 否则总有一条路会绕过它（旧代码走的是 `window.confirm`，§7.5 明令禁止）。
   */
  readonly pendingDiffTabClose: readonly string[] | null
  readonly pendingSync: { request: Pick<StartSyncRequest, 'leftSource' | 'rightSource' | 'direction'>; preview: SyncPlanPreview; resume: boolean; resolve: (proceed: boolean) => void } | null
  readonly pendingUnsavedChanges: UnsavedChangesRequest | null
  /**
   * 当前视图想说的那一句话，渲染在状态栏的任务槽里（蓝图 §4.5：手动对齐提示
   * 「移到状态栏，作为任务槽的标签，出错时用 warning 色」，而不是工具栏里的行内胶囊）。
   *
   * 放在 store 而不是页面局部 state：说这句话的是 `TextComparePage`，显示它的是
   * `AppShell` 下的 `Statusbar`，两者之间没有父子关系。写它的视图负责在卸载时清空。
   */
  readonly statusHint: StatusHint | null

  openOverlay: (overlay: OverlayKind) => void
  closeOverlay: () => void
  toggleOverlay: (overlay: OverlayKind) => void
  setFileSearchOpen: (open: boolean) => void
  setFilterPopoverOpen: (open: boolean) => void
  setPendingDiffTabClose: (ids: readonly string[] | null) => void
  setPendingSync: (pending: UIStore['pendingSync']) => void
  setPendingUnsavedChanges: (request: UnsavedChangesRequest | null) => void
  setStatusHint: (hint: StatusHint | null) => void
  setTreeSelection: (
    updater: CompareSelectionState | ((current: CompareSelectionState) => CompareSelectionState),
  ) => void
  clearTreeSelection: () => void
}

export const EMPTY_TREE_SELECTION: CompareSelectionState = {
  selectedPaths: new Set<string>(),
  anchorPath: null,
}

export const useUIStore = create<UIStore>()((set, get) => ({
  overlay: null,
  fileSearchOpen: false,
  filterPopoverOpen: false,
  treeSelection: EMPTY_TREE_SELECTION,
  pendingDiffTabClose: null,
  pendingSync: null,
  pendingUnsavedChanges: null,
  statusHint: null,

  openOverlay: (overlay) => set({ overlay }),

  closeOverlay: () => set({ overlay: null }),

  toggleOverlay: (overlay) => set({ overlay: get().overlay === overlay ? null : overlay }),

  setFileSearchOpen: (fileSearchOpen) => set({ fileSearchOpen }),

  setFilterPopoverOpen: (filterPopoverOpen) => set({ filterPopoverOpen }),

  setPendingDiffTabClose: (pendingDiffTabClose) => set({ pendingDiffTabClose }),
  setPendingSync: (pendingSync) => set({ pendingSync }),
  setPendingUnsavedChanges: (pendingUnsavedChanges) => set({ pendingUnsavedChanges }),

  setStatusHint: (statusHint) => set({ statusHint }),

  setTreeSelection: (updater) => set((state) => ({
    treeSelection: typeof updater === 'function' ? updater(state.treeSelection) : updater,
  })),

  clearTreeSelection: () => set({ treeSelection: EMPTY_TREE_SELECTION }),
}))
