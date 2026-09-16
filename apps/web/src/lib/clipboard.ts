/** Clipboard API needs HTTPS; the selection fallback also works on a LAN HTTP address. */
export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Fall back to selection. */
    }
  }
  const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement('textarea');
  field.value = text;
  field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
  field.setAttribute('aria-label', 'Text to copy');
  (document.querySelector('dialog[open]') ?? document.body).append(field);
  let copied = false;
  try {
    field.focus();
    field.select();
    copied = document.execCommand('copy');
  } finally {
    field.remove();
    prior?.focus();
  }
  if (!copied) throw new Error('Select the address and copy it manually.');
}
