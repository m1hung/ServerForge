export function resolveInitialFocus(dialog: HTMLElement): HTMLElement | null {
  const autofocus = dialog.querySelector<HTMLElement>('[data-autofocus]');
  if (autofocus && !autofocus.hasAttribute('disabled')) return autofocus;

  const fields = [...dialog.querySelectorAll<HTMLElement>('input, textarea, select')].filter(
    (el) => {
      if (el.hasAttribute('disabled')) return false;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio' || el.type === 'hidden' || el.type === 'button')) {
        return false;
      }
      return true;
    },
  );
  if (fields[0]) return fields[0];

  const actions = [...dialog.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.getAttribute('aria-label') !== 'Close' && !button.disabled,
  );
  if (actions[0]) return actions[0];

  return dialog.querySelector<HTMLElement>('button[aria-label="Close"]');
}
