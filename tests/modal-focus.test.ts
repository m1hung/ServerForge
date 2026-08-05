// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { resolveInitialFocus } from '../apps/web/src/components/ui/index.js';

/**
 * Regression tests for dialog focus.
 *
 * The reported symptom was that typing a backup name moved focus to the close
 * button. Two bugs combined:
 *
 *  1. `querySelector('[data-autofocus], button, input')` returns whichever
 *     element comes first in the *document*, not the first selector that
 *     matches — and the close button is the first button in every dialog.
 *  2. The focus effect depended on `onClose`, which callers pass as an inline
 *     arrow, so it re-ran on every keystroke and re-applied that focus.
 *
 * This covers (1). The second is a hook dependency and is verified in the
 * browser; the fix is documented at the `onCloseRef` in the Modal.
 */

/** Builds a dialog with the same structure the Modal renders. */
function dialogWith(bodyHtml: string): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `
    <div>
      <h2>Title</h2>
      <button aria-label="Close">x</button>
    </div>
    <div>${bodyHtml}</div>
    <div>
      <button>Cancel</button>
      <button>Confirm</button>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}

describe('resolveInitialFocus', () => {
  it('prefers the field marked data-autofocus over the close button', () => {
    const dialog = dialogWith('<input data-autofocus id="wanted" /><input id="other" />');
    expect(resolveInitialFocus(dialog)?.id).toBe('wanted');
  });

  it('honours data-autofocus even when it is the last control in the dialog', () => {
    const dialog = dialogWith('<input id="first" /><textarea data-autofocus id="wanted"></textarea>');
    expect(resolveInitialFocus(dialog)?.id).toBe('wanted');
  });

  it('focuses the first form field when nothing is marked', () => {
    const dialog = dialogWith('<input id="name" /><input id="second" />');
    expect(resolveInitialFocus(dialog)?.id).toBe('name');
  });

  it('never lands on the close button when a field exists', () => {
    const dialog = dialogWith('<input id="name" />');
    const focused = resolveInitialFocus(dialog);
    expect(focused?.getAttribute('aria-label')).not.toBe('Close');
  });

  it('skips checkboxes, which are not what a form dialog is asking for', () => {
    const dialog = dialogWith('<input type="checkbox" id="agree" /><input type="text" id="name" />');
    expect(resolveInitialFocus(dialog)?.id).toBe('name');
  });

  it('ignores disabled fields', () => {
    const dialog = dialogWith('<input id="locked" disabled /><input id="usable" />');
    expect(resolveInitialFocus(dialog)?.id).toBe('usable');
  });

  it('falls back to a real action rather than the close button', () => {
    // A confirmation dialog with no inputs at all.
    const dialog = dialogWith('<p>Are you sure?</p>');
    const focused = resolveInitialFocus(dialog);
    expect(focused?.textContent).toBe('Cancel');
    expect(focused?.getAttribute('aria-label')).not.toBe('Close');
  });

  it('returns the close button only when it is the sole control', () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<button aria-label="Close">x</button>';
    document.body.appendChild(dialog);
    expect(resolveInitialFocus(dialog)?.getAttribute('aria-label')).toBe('Close');
  });

  it('returns null when there is nothing focusable', () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<p>Just text</p>';
    document.body.appendChild(dialog);
    expect(resolveInitialFocus(dialog)).toBeNull();
  });
});
