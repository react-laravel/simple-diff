import { useAppStore, type Page } from '../stores/app-store'
import { getRuntimeInfo } from '../runtime/runtime-info'
import { openCompareTab, persistActiveCompareTab } from './compare-session-navigation'

export function isPageAvailable(page: Page): boolean {
  const runtime = getRuntimeInfo()
  return (page !== 'ssh' || runtime.supportsSftp) && (page !== 'history' || runtime.supportsHistory)
}

/** Top tabs, application menu and command palette share one non-destructive route. */
export function navigateToPage(page: Page): void {
  const app = useAppStore.getState()
  if (app.page === page || !isPageAvailable(page)) return
  if (page === 'compare') {
    openCompareTab()
    return
  }
  if (app.page === 'compare') persistActiveCompareTab()
  app.setPage(page)
}
