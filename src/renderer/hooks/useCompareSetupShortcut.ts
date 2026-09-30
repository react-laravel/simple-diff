import { useEffect, type RefObject } from 'react'
import { useUIStore } from '../stores/ui-store'
import { isSubmitKey } from '../utils/submit-key'

const INTERACTIVE = 'input, textarea, select, button, a[href], [contenteditable], [role="button"], [role="textbox"], [role="combobox"], [tabindex]'
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** The setup hint also applies after clicking empty space, without taking over other controls. */
export function useCompareSetupShortcut(
  panelRef: RefObject<HTMLDivElement | null>,
  onSubmit: () => void | Promise<void>,
): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current
      if (!panel || !isSubmitKey(event)) return

      const ui = useUIStore.getState()
      const dialog = panel.closest('[role="dialog"]')
      if (ui.pendingSync || ui.pendingUnsavedChanges || ui.pendingDiffTabClose) return
      if (ui.overlay !== null && !(ui.overlay === 'compare-setup' && dialog)) return
      // Local popovers and SFTP/strategy dialogs do not all live in the UI store.
      if (Array.from(document.querySelectorAll(OVERLAY)).some((layer) => layer !== dialog)) return

      const target = event.target
      // Clicking blank setup content focuses the accessible parent tabpanel.
      const page = panel.closest('[role="tabpanel"]')
      if (target instanceof Element && target !== document.body && target !== document.documentElement && target !== page) {
        if (!panel.contains(target)) return
        // Stop at the panel: its parent dialog may itself have tabindex="-1".
        for (let node: Element | null = target; node && node !== panel; node = node.parentElement) {
          if (node.matches(INTERACTIVE)) return
        }
      }

      event.preventDefault()
      void onSubmit()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [panelRef, onSubmit])
}
