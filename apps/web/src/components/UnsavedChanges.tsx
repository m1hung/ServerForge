'use client';

import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { guardHistory } from '@/lib/navigation-history';

type Changes = {
  label: string;
  dirty: boolean;
  busy?: boolean;
  scope: string;
  save?: () => Promise<boolean>;
  discard: () => void;
};
type Pending = { ids: string[]; proceed: () => void; focus: HTMLElement | null };
type Guard = {
  blocked: (destination: URL) => boolean;
  register: (id: string, get: () => Changes) => () => void;
  clear: (id: string) => void;
  request: (destination: URL | null, proceed: () => void, only?: string) => boolean;
};
const Context = createContext<Guard | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const changes = useRef(new Map<string, () => Changes>());
  const pendingRef = useRef<Pending | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const historyGuard = useRef<ReturnType<typeof guardHistory> | null>(null);
  const [, refresh] = useState(0);
  const clear = useCallback((id: string) => {
    changes.current.delete(id);
    if (pendingRef.current) refresh((value) => value + 1);
  }, []);
  const register = useCallback(
    (id: string, get: () => Changes) => {
      changes.current.set(id, get);
      return () => clear(id);
    },
    [clear],
  );
  const leaving = useCallback(
    (destination: URL | null, only?: string) =>
      [...changes.current]
        .filter(([id, get]) => {
          if (only) return id === only;
          if (!destination) return true;
          const scope = new URL(get().scope, location.origin);
          return (
            destination.origin !== scope.origin ||
            destination.pathname !== scope.pathname ||
            destination.search !== scope.search ||
            (!!scope.hash && destination.hash !== scope.hash)
          );
        })
        .map(([id]) => id),
    [],
  );
  const request = useCallback(
    (destination: URL | null, proceed: () => void, only?: string) => {
      const ids = leaving(destination, only);
      if (!ids.length) {
        proceed();
        return false;
      }
      if (!pendingRef.current) {
        const next = { ids, proceed, focus: document.activeElement as HTMLElement | null };
        pendingRef.current = next;
        setPending(next);
        setError('');
      }
      return true;
    },
    [leaving],
  );
  useLayoutEffect(() => {
    const controller = guardHistory((url) => leaving(url).length > 0, request);
    historyGuard.current = controller;
    return () => controller.stop();
  }, [leaving, request]);
  useEffect(() => {
    // Listen before the router, but wrap its History methods after its own effect.
    const controller = historyGuard.current;
    queueMicrotask(() => controller?.start());
    const warn = (event: BeforeUnloadEvent) => {
      if (changes.current.size) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [leaving, request]);
  useEffect(() => {
    if (pending) dialog.current?.showModal();
  }, [pending]);
  const guard = useMemo(
    () => ({ register, clear, request, blocked: (url: URL) => leaving(url).length > 0 }),
    [register, clear, request, leaving],
  );
  const edits =
    pending?.ids.flatMap((id) => {
      const get = changes.current.get(id);
      return get ? [{ id, ...get() }] : [];
    }) ?? [];
  function stay() {
    const focus = pendingRef.current?.focus;
    // Close before restoring focus; a deferred callback can steal focus from the
    // user's next field edit, particularly when clearing an input.
    dialog.current?.close();
    pendingRef.current = null;
    setPending(null);
    setError('');
    if (
      focus?.isConnected &&
      focus.getClientRects().length &&
      getComputedStyle(focus).visibility !== 'hidden'
    )
      focus.focus();
    else {
      const main = document.querySelector<HTMLElement>('main');
      main?.setAttribute('tabindex', '-1');
      main?.focus();
    }
  }
  async function proceed(save: boolean) {
    if (saving || edits.some((edit) => edit.busy)) return;
    setSaving(true);
    setError('');
    try {
      for (const edit of edits) {
        if (save) {
          if (!edit.save || !(await edit.save()))
            throw new Error(
              `Could not save ${edit.label.toLowerCase()}. Stay on this page to review the fields or error, then try again.`,
            );
        } else edit.discard();
        clear(edit.id);
      }
      const next = pendingRef.current;
      pendingRef.current = null;
      setPending(null);
      next?.proceed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your changes.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Context.Provider value={guard}>
      {children}
      {pending && (
        <dialog
          ref={dialog}
          className="tool-dialog unsaved-dialog"
          aria-labelledby="unsaved-title"
          aria-describedby="unsaved-description"
          onCancel={(event) => {
            event.preventDefault();
            if (!saving) stay();
          }}
        >
          <h2 id="unsaved-title">You have unsaved changes</h2>
          <p id="unsaved-description">
            Save your edits before continuing, discard them, or stay here to keep editing.
          </p>
          <ul>
            {edits.map((edit) => (
              <li key={edit.id}>{edit.label}</li>
            ))}
          </ul>
          {edits.some((edit) => edit.busy) && (
            <p role="status">Wait for the current save to finish.</p>
          )}
          {edits.some((edit) => !edit.save) && (
            <p>Complete this form on the current page, or discard it to continue.</p>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button autoFocus className="btn secondary" disabled={saving} onClick={stay}>
              Stay here
            </button>
            <button
              className="btn secondary"
              disabled={saving || edits.some((edit) => edit.busy)}
              onClick={() => void proceed(false)}
            >
              {edits.length ? 'Discard and leave' : 'Continue'}
            </button>
            {edits.length > 0 && edits.every((edit) => edit.save) && (
              <button
                className="btn"
                disabled={saving || edits.some((edit) => edit.busy)}
                onClick={() => void proceed(true)}
              >
                {saving ? 'Saving…' : 'Save and leave'}
              </button>
            )}
          </div>
        </dialog>
      )}
    </Context.Provider>
  );
}

export function useNavigationGuard() {
  const guard = useContext(Context);
  if (!guard) throw new Error('Navigation protection requires UnsavedChangesProvider.');
  return guard;
}

export function useUnsavedChanges(options: Changes) {
  const guard = useNavigationGuard();
  const id = useId();
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  useLayoutEffect(() => {
    if (options.dirty) return guard.register(id, () => latest.current);
  }, [guard, id, options.dirty, options.busy]);
  return {
    clear: () => guard.clear(id),
    confirm: (proceed: () => void) => guard.request(null, proceed, id),
  };
}

export function ProtectedLink({
  href,
  onNavigate,
  replace,
  scroll,
  ...props
}: Omit<ComponentProps<typeof NextLink>, 'href'> & { href: string }) {
  const guard = useContext(Context);
  const router = useRouter();
  return (
    <NextLink
      {...props}
      href={href}
      replace={replace}
      scroll={scroll}
      onNavigate={(event) => {
        onNavigate?.(event);
        const destination = new URL(href, location.href);
        if (!guard?.blocked(destination)) return;
        // Prevent Next's original transition; the guard resumes it exactly once.
        event.preventDefault();
        guard.request(destination, () =>
          (replace ? router.replace : router.push)(href, { scroll }),
        );
      }}
    />
  );
}
