// Keep collapsed settings reachable for search and native form validation.
export function revealField(field: HTMLElement) {
  for (let parent = field.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
}
