import { useCompareStore } from '../stores/compare-store'
import type { Page } from '../stores/app-store'

export function applyOpenedLocalPaths(
  paths: readonly string[],
  handlers: {
    setPage: (page: Page) => void
    runCompare: () => void
  },
): boolean {
  const localPaths = paths.map((path) => path.trim()).filter(Boolean)
  if (localPaths.length === 0) return false

  const compareState = useCompareStore.getState()
  handlers.setPage('compare')

  if (localPaths.length >= 2) {
    compareState.setLeftSourceType('local')
    compareState.setLeftSSHConfigId('')
    compareState.setLeftPath(localPaths[0])
    compareState.setRightSourceType('local')
    compareState.setRightSSHConfigId('')
    compareState.setRightPath(localPaths[1])
    handlers.runCompare()
    return true
  }

  const path = localPaths[0]
  if (compareState.leftPath && !compareState.rightPath) {
    compareState.setRightSourceType('local')
    compareState.setRightSSHConfigId('')
    compareState.setRightPath(path)
    return true
  }

  compareState.setLeftSourceType('local')
  compareState.setLeftSSHConfigId('')
  compareState.setLeftPath(path)
  return true
}
