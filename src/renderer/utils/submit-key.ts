/** Enter confirms a form only after IME composition has finished. */
export function isSubmitKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter'
    && !event.defaultPrevented
    && !event.isComposing
    // WebKit may clear isComposing on the Enter that accepts an IME candidate.
    && event.keyCode !== 229
    && !event.repeat
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
}
