'use client';

import { useEffect, useId, useRef, useState } from 'react';

export type SecurityProof = { password: string; code: string };

/** Ask for credentials beside the action, then discard them when the dialog closes. */
export function SecurityDialog({
  title,
  description,
  requireCode = false,
  codeLabel = 'Authenticator or recovery code',
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  requireCode?: boolean;
  codeLabel?: string;
  onConfirm: (proof: SecurityProof) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tool-dialog security-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
      onClose={onClose}
    >
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      <form
        className="stack"
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          const form = new FormData(event.currentTarget);
          setPending(true);
          setError('');
          try {
            await onConfirm({
              password: String(form.get('password') || ''),
              code: String(form.get('code') || ''),
            });
            dialog.current?.close();
          } catch (error) {
            setError(
              error instanceof Error ? error.message : 'Could not complete this change. Try again.',
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <fieldset disabled={pending} className="configuration-inputs stack">
          <label>
            Current password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </label>
          {requireCode && (
            <label>
              {codeLabel}
              <input name="code" autoComplete="one-time-code" required maxLength={32} />
            </label>
          )}
        </fieldset>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="row">
          <button
            type="button"
            className="btn secondary"
            disabled={pending}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button className="btn" disabled={pending}>
            {pending ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
