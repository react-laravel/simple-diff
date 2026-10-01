import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { mergePathFilters } from '@shared/path-filter'
import { useShallow } from 'zustand/react/shallow'
import type { CompareEntry, CompareFilter } from '../../../shared/types'
import { useCompareStore } from '../stores/compare-store'
import { useSettingsStore } from '../stores/settings-store'
import { addRendererLog } from '../stores/log-store'
import { computeVisibleTreeNodesAsync } from '../runtime/compare-tree-client'
import { buildVisibleNodeList, prepareCompareEntries, type TreeSide, type VisibleTreeNodes } from '../utils/tree-utils'

interface UseVisibleCompareNodesOptions {
  readonly entries: readonly CompareEntry[]
  readonly filter: CompareFilter
  readonly side?: TreeSide
}

const HEAVY_ENTRIES_THRESHOLD = 50_000
const EMPTY_NODES = buildVisibleNodeList([], new Set())

export function useVisibleCompareNodes({ entries, filter, side }: UseVisibleCompareNodesOptions): VisibleTreeNodes {
  const deferredEntries = useDeferredValue(entries)
  const { expandedDirs, extensionFilter, hideDot, hideDotFilter } = useCompareStore(useShallow((state) => ({
    expandedDirs: state.expandedDirs,
    extensionFilter: state.extensionFilter,
    hideDot: state.hideDot,
    hideDotFilter: state.hideDotFilter,
  })))
  const sessionKey = useCompareStore(state => state.activeCompareId ?? state.compareSessionId)
  const globalPathFilters = useSettingsStore(state => state.globalPathFilters)
  const pathFilter = useMemo(() => mergePathFilters(globalPathFilters, extensionFilter), [extensionFilter, globalPathFilters])
  const options = useMemo(() => ({ filter, pathFilter, hideDot, hideDotFilter, side }), [filter, pathFilter, hideDot, hideDotFilter, side])
  const heavy = deferredEntries.length >= HEAVY_ENTRIES_THRESHOLD
  const latestEntries = useRef(deferredEntries)
  latestEntries.current = deferredEntries
  const [computed, setComputed] = useState<{ sessionKey: string | null; nodes: VisibleTreeNodes } | null>(null)

  useEffect(() => {
    if (!heavy) { setComputed(null); return }
    setComputed(previous => previous?.sessionKey === sessionKey ? previous : null)
    const controller = new AbortController()
    let running = false
    let lastEntries: readonly CompareEntry[] | null = null
    const computeLatest = () => {
      if (running || lastEntries === latestEntries.current) return
      running = true
      lastEntries = latestEntries.current
      void computeVisibleTreeNodesAsync(lastEntries, options, expandedDirs, controller.signal)
        .then(nodes => { if (nodes && !controller.signal.aborted) setComputed({ sessionKey, nodes }) })
        .catch(error => {
          if (controller.signal.aborted) return
          setComputed({ sessionKey, nodes: EMPTY_NODES })
          addRendererLog('compare', 'error', error instanceof Error ? error.message : '目录树计算失败')
        })
        .finally(() => { running = false })
    }
    // Complete each snapshot, then use the newest batch. Frequent scan events cannot starve it.
    computeLatest()
    const timer = setInterval(computeLatest, 200)
    return () => { clearInterval(timer); controller.abort() }
  }, [heavy, options, expandedDirs, sessionKey])

  const immediate = useMemo(() => heavy ? EMPTY_NODES : buildVisibleNodeList(prepareCompareEntries(deferredEntries, options), expandedDirs),
    [heavy, deferredEntries, options, expandedDirs])
  return heavy ? computed?.sessionKey === sessionKey ? computed.nodes : EMPTY_NODES : immediate
}
