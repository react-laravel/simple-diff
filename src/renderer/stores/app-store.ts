import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SourceConfig, TextDiffResult } from '../../../shared/types'
import { showToast } from './toast-store'
import { sanitizePersistedCompareSessionSnapshot, type CompareSessionSnapshot } from './compare-store'

/**
 * 设计蓝图 §2.2：顶层目的地从 7 个收敛到两种模式。SSH管理 / 历史 / 同步任务 / 设置
 * 都变成叠加层（`stores/ui-store.ts` 的 `overlay`），不再是页面。
 *
 * chunk 5 起 `'home'` 也不再是页面：“尚无结果”是对比工作区自己的 setup 态，
 * 由 `hasCompareSessionContent()` 推导，没有新增持久化字段。
 */
// 当前顶栏同时提供 SSH 管理和对比历史，旧的上下文弹窗入口仍然保留。
export type Page = 'compare' | 'text' | 'ssh' | 'history'

/** 顶栏模式切换与 `Page` 一一对应。 */
export type AppMode = Page

export function pageToMode(page: Page): AppMode {
  return page
}

export interface DiffTab {
  readonly id: string
  readonly sessionId: string
  readonly relativePath: string
  readonly fileName: string
  readonly hasLeftFile: boolean
  readonly hasRightFile: boolean
  readonly leftSource: SourceConfig | null
  readonly rightSource: SourceConfig | null
  readonly leftFullPath: string
  readonly rightFullPath: string
  readonly leftContent: string
  readonly rightContent: string
  readonly originalLeftContent: string
  readonly originalRightContent: string
  readonly diffResult: TextDiffResult | null
  readonly loadError: string | null
  readonly loading: boolean
  readonly savingLeft?: boolean
  readonly savingRight?: boolean
  readonly contentsLoaded?: boolean
  readonly computing?: boolean
  readonly undoStack?: readonly { leftContent: string; rightContent: string }[]
  readonly redoStack?: readonly { leftContent: string; rightContent: string }[]
}

export interface CompareTab {
  readonly id: string
  readonly title: string
  readonly snapshot: CompareSessionSnapshot
  readonly diffTabs: readonly DiffTab[]
  readonly activeDiffTabId: string | null
}

interface AppStore {
  readonly page: Page
  readonly diffTabs: readonly DiffTab[]
  readonly activeDiffTabId: string | null
  readonly compareTabs: readonly CompareTab[]
  readonly activeCompareTabId: string | null

  setPage: (page: Page) => void
  addDiffTab: (tab: DiffTab) => void
  updateDiffTab: (id: string, updates: Partial<DiffTab>) => void
  updateDiffTabSession: (sessionId: string, updates: Partial<DiffTab>) => void
  closeDiffTab: (id: string) => void
  setActiveDiffTab: (id: string | null) => void
  replaceDiffTabs: (tabs: readonly DiffTab[], activeId: string | null) => void
  clearDiffTabs: () => void
  saveCompareTab: (tab: CompareTab) => void
  updateCompareTabSnapshot: (id: string, updater: (snapshot: CompareSessionSnapshot) => CompareSessionSnapshot) => void
  updateCompareTabSnapshotByCompareId: (compareId: string, updater: (snapshot: CompareSessionSnapshot) => CompareSessionSnapshot) => void
  closeCompareTab: (id: string) => void
  setActiveCompareTab: (id: string | null) => void
  hasDiffTabSession: (id: string, sessionId: string) => boolean
}

interface PersistedAppState {
  readonly page: Page
  readonly compareTabs: readonly CompareTab[]
  readonly activeCompareTabId: string | null
}

const VALID_PAGES: readonly Page[] = ['compare', 'text', 'ssh', 'history']

/**
 * v1 从未持久化 `page`，且旧版联合类型还包含 home/ssh/history/sync/settings。
 * 任何无法识别的值都落回 `'compare'`，避免返回用户停在一个已不存在的页面上。
 */
export function migratePersistedAppState(persisted: unknown): PersistedAppState {
  const state = (persisted ?? {}) as Partial<PersistedAppState>
  const page = VALID_PAGES.includes(state.page as Page) ? (state.page as Page) : 'compare'

  return {
    page,
    compareTabs: state.compareTabs ?? [],
    activeCompareTabId: state.activeCompareTabId ?? null,
  }
}

/** Persist all dirty drafts and the active file; diff results are recomputed on restore. */
function sanitizePersistedDiffTabs(
  diffTabs: readonly DiffTab[],
  keepContentForId: string | null,
): readonly DiffTab[] {
  return diffTabs
    .filter((tab) => !tab.loading)
    .map(({ undoStack: _undo, redoStack: _redo, savingLeft: _savingLeft, savingRight: _savingRight, ...tab }) => (tab.id === keepContentForId || tab.leftContent !== tab.originalLeftContent || tab.rightContent !== tab.originalRightContent
      ? { ...tab, computing: false, contentsLoaded: !tab.loadError, diffResult: null } : {
      ...tab,
      leftContent: '',
      rightContent: '',
      originalLeftContent: '',
      originalRightContent: '',
      contentsLoaded: false,
      computing: false,
      diffResult: null,
    }))
}

function createRestorableCompareTab(
  tab: CompareTab,
  liveDiffTabs?: readonly DiffTab[],
  liveActiveDiffTabId?: string | null,
  keepActiveDiffContent = false,
): CompareTab {
  const requestedActiveDiffTabId = liveDiffTabs === undefined ? tab.activeDiffTabId : liveActiveDiffTabId ?? null
  const diffTabs = sanitizePersistedDiffTabs(
    liveDiffTabs ?? tab.diffTabs,
    keepActiveDiffContent ? requestedActiveDiffTabId : null,
  )
  const activeDiffTabId = requestedActiveDiffTabId === null ? null : diffTabs.some((diffTab) => diffTab.id === requestedActiveDiffTabId)
    ? requestedActiveDiffTabId
    : (diffTabs.at(-1)?.id ?? null)

  return {
    ...tab,
    diffTabs,
    activeDiffTabId,
  }
}

export function createPersistedAppState(state: Pick<AppStore, 'page' | 'compareTabs' | 'activeCompareTabId' | 'diffTabs' | 'activeDiffTabId'>): PersistedAppState {
  const shouldMergeLiveDiffTabs = state.page === 'compare' || state.diffTabs.length > 0 || state.activeDiffTabId !== null
  const persistedCompareTabs = state.compareTabs.map((tab) => {
    const isActiveCompareTab = shouldMergeLiveDiffTabs && tab.id === state.activeCompareTabId
    const restorableTab = createRestorableCompareTab(
      tab,
      isActiveCompareTab ? state.diffTabs : undefined,
      isActiveCompareTab ? state.activeDiffTabId : undefined,
      isActiveCompareTab,
    )

    return {
      ...restorableTab,
      snapshot: sanitizePersistedCompareSessionSnapshot(tab.snapshot),
    }
  })

  return {
    page: state.page,
    compareTabs: persistedCompareTabs,
    activeCompareTabId: state.activeCompareTabId,
  }
}

const noopStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

const appStorage = createJSONStorage<PersistedAppState>(() => {
  if (typeof window !== 'undefined' && window.localStorage) {
    return {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => window.localStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        try { window.localStorage.setItem(key, value) }
        catch { showToast({ id: 'workspace-persist-error', tone: 'error', message: '工作区恢复数据保存失败', description: '请先保存文件修改，再关闭应用。' }) }
      },
    }
  }

  return noopStorage
})

export const useAppStore = create<AppStore>()(persist<AppStore, [], [], PersistedAppState>((set, get) => ({
  page: 'compare',
  diffTabs: [],
  activeDiffTabId: null,
  compareTabs: [],
  activeCompareTabId: null,

  setPage: (page) => set({ page }),

  addDiffTab: (tab) => {
    const existing = get().diffTabs.find((t) => t.id === tab.id)
    if (existing) {
      set({ activeDiffTabId: tab.id })
      return
    }
    set((state) => ({
      diffTabs: [...state.diffTabs, tab],
      activeDiffTabId: tab.id,
    }))
  },

  updateDiffTab: (id, updates) => {
    set((state) => ({
      diffTabs: state.diffTabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }))
  },

  updateDiffTabSession: (sessionId, updates) => set((state) => ({
    diffTabs: state.diffTabs.map((tab) => tab.sessionId === sessionId ? { ...tab, ...updates } : tab),
    compareTabs: state.compareTabs.map((session) => ({
      ...session,
      diffTabs: session.diffTabs.map((tab) => tab.sessionId === sessionId ? { ...tab, ...updates } : tab),
    })),
  })),

  closeDiffTab: (id) => {
    set((state) => {
      const newTabs = state.diffTabs.filter((t) => t.id !== id)
      const newActive =
        state.activeDiffTabId === id
          ? newTabs.length > 0
            ? newTabs[newTabs.length - 1].id
            : null
          : state.activeDiffTabId
      return { diffTabs: newTabs, activeDiffTabId: newActive }
    })
  },

  setActiveDiffTab: (id) => set({ activeDiffTabId: id }),

  replaceDiffTabs: (tabs, activeDiffTabId) => set({
    diffTabs: [...tabs],
    activeDiffTabId,
  }),

  clearDiffTabs: () => set({ diffTabs: [], activeDiffTabId: null }),

  saveCompareTab: (tab) => {
    set((state) => {
      const diffTabs = tab.diffTabs.filter((file) => !file.loading)
      const nextTab = { ...tab, diffTabs, activeDiffTabId: tab.activeDiffTabId === null ? null
        : diffTabs.some((file) => file.id === tab.activeDiffTabId) ? tab.activeDiffTabId : diffTabs.at(-1)?.id ?? null }
      const existingIndex = state.compareTabs.findIndex((candidate) => candidate.id === tab.id)

      if (existingIndex < 0) {
        return { compareTabs: [...state.compareTabs, nextTab] }
      }

      const compareTabs = [...state.compareTabs]
      compareTabs[existingIndex] = nextTab
      return { compareTabs }
    })
  },

  updateCompareTabSnapshot: (id, updater) => {
    set((state) => {
      const compareTabs = state.compareTabs.map((tab) => {
        if (tab.id !== id) return tab
        return {
          ...tab,
          snapshot: updater(tab.snapshot),
        }
      })

      return { compareTabs }
    })
  },

  updateCompareTabSnapshotByCompareId: (compareId, updater) => {
    set((state) => {
      const compareTabs = state.compareTabs.map((tab) => {
        if (tab.snapshot.activeCompareId !== compareId) return tab
        return {
          ...tab,
          snapshot: updater(tab.snapshot),
        }
      })

      return { compareTabs }
    })
  },

  closeCompareTab: (id) => {
    set((state) => {
      const compareTabs = state.compareTabs.filter((tab) => tab.id !== id)
      const activeCompareTabId = state.activeCompareTabId === id
        ? (compareTabs.at(-1)?.id ?? null)
        : state.activeCompareTabId

      return {
        compareTabs,
        activeCompareTabId,
      }
    })
  },

  setActiveCompareTab: (id) => set({ activeCompareTabId: id }),

  hasDiffTabSession: (id, sessionId) => {
    return get().diffTabs.some((tab) => tab.id === id && tab.sessionId === sessionId)
  },
}), {
  name: 'simple-diff-app-store',
  storage: appStorage,
  version: 2,
  migrate: (persisted) => migratePersistedAppState(persisted),
  partialize: (state: AppStore) => createPersistedAppState(state),
}))
