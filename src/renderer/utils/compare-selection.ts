import type { CompareEntry, SyncDirection } from '../../../shared/types'

export interface CompareSelectionState {
  readonly selectedPaths: ReadonlySet<string>
  readonly anchorPath: string | null
}

export interface CompareSelectionInput {
  readonly orderedPaths: readonly string[]
  readonly clickedPath: string
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}

function canSyncEntryInDirection(entry: CompareEntry, direction: SyncDirection): boolean {
  if (entry.left?.isSymlink || entry.right?.isSymlink) return false
  if (entry.isDirectory) {
    return direction === 'left_to_right' ? entry.state === 'left_only' : entry.state === 'right_only'
  }

  if (entry.state === 'different') return true
  return direction === 'left_to_right' ? entry.state === 'left_only' : entry.state === 'right_only'
}

function collectSubtreeSyncEntries(
  entries: readonly CompareEntry[],
  relativePath: string,
  direction: SyncDirection,
): readonly CompareEntry[] {
  const prefix = relativePath === '' ? '' : `${relativePath}/`
  return entries.filter((entry) => {
    const inSubtree = entry.relativePath === relativePath || entry.relativePath.startsWith(prefix)
    return inSubtree && canSyncEntryInDirection(entry, direction)
  })
}

export function resolveCompareSelection(
  state: CompareSelectionState,
  input: CompareSelectionInput,
): CompareSelectionState {
  const { orderedPaths, clickedPath, shiftKey, metaKey, ctrlKey } = input
  const toggleSelection = metaKey || ctrlKey

  if (shiftKey && state.anchorPath) {
    const anchorIndex = orderedPaths.indexOf(state.anchorPath)
    const targetIndex = orderedPaths.indexOf(clickedPath)

    if (anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex)
      const end = Math.max(anchorIndex, targetIndex)
      return {
        selectedPaths: new Set(orderedPaths.slice(start, end + 1)),
        anchorPath: state.anchorPath,
      }
    }
  }

  if (toggleSelection) {
    const nextSelectedPaths = new Set(state.selectedPaths)
    if (nextSelectedPaths.has(clickedPath)) {
      nextSelectedPaths.delete(clickedPath)
    } else {
      nextSelectedPaths.add(clickedPath)
    }

    return {
      selectedPaths: nextSelectedPaths,
      anchorPath: clickedPath,
    }
  }

  return {
    selectedPaths: new Set([clickedPath]),
    anchorPath: clickedPath,
  }
}

export function collectSyncEntriesForSelection(
  entries: readonly CompareEntry[],
  selectedPaths: ReadonlySet<string>,
  direction: SyncDirection,
): readonly CompareEntry[] {
  const selectedEntries = entries
    .filter((entry) => selectedPaths.has(entry.relativePath))
    .filter((entry) => canSyncEntryInDirection(entry, direction))
    .sort((left, right) => left.relativePath.length - right.relativePath.length || left.relativePath.localeCompare(right.relativePath))

  const selectedRoots: string[] = []
  for (const entry of selectedEntries) {
    if (selectedRoots.some((root) => entry.relativePath === root || entry.relativePath.startsWith(`${root}/`))) {
      continue
    }

    selectedRoots.push(entry.relativePath)
  }

  const entryMap = new Map<string, CompareEntry>()
  for (const root of selectedRoots) {
    for (const entry of collectSubtreeSyncEntries(entries, root, direction)) {
      entryMap.set(entry.relativePath, entry)
    }
  }

  return Array.from(entryMap.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}
