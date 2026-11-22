const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const INTERACTIVE_CONTROL_SELECTOR =
  'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], summary';

const NAV_LIST_ITEM_SELECTOR =
  '[data-testid^="inbox-item-"], [data-testid^="board-topic-item-"], [data-testid^="board-list-item-"], [data-testid^="board-kanban-card-"]';

function isEditableElement(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  if (EDITABLE_TAGS.has(node.tagName)) {
    return true;
  }
  if (node.isContentEditable) {
    return true;
  }
  return Boolean(
    node.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
    )
  );
}

function hasOpenOverlayOrInOverlay(node: EventTarget | null): boolean {
  if (node instanceof HTMLElement) {
    if (
      node.closest(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'
      )
    ) {
      return true;
    }
  }
  if (typeof document !== "undefined") {
    return Boolean(
      document.querySelector(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'
      )
    );
  }
  return false;
}

export function shouldIgnoreGlobalShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) {
    return true;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return true;
  }
  if (isEditableElement(event.target)) {
    return true;
  }
  const activeEl = typeof document !== "undefined" ? document.activeElement : null;
  if (isEditableElement(activeEl)) {
    return true;
  }
  if (hasOpenOverlayOrInOverlay(event.target)) {
    return true;
  }
  return false;
}

export function isNonListInteractiveControl(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  const interactive = node.closest(INTERACTIVE_CONTROL_SELECTOR);
  if (!interactive) {
    return false;
  }
  const navItem = node.closest(NAV_LIST_ITEM_SELECTOR);
  if (navItem && interactive === navItem) {
    return false;
  }
  return true;
}

export function shouldIgnoreActivationShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== " ") {
    return false;
  }
  if (isNonListInteractiveControl(event.target)) {
    return true;
  }
  const activeEl = typeof document !== "undefined" ? document.activeElement : null;
  if (isNonListInteractiveControl(activeEl)) {
    return true;
  }
  return false;
}
