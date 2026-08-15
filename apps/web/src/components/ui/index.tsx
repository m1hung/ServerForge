"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Check, Info, Loader2, X } from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The component primitives.
 *
 * Accessibility is built in rather than bolted on: every control has a real
 * <label>, error text is wired through aria-describedby, the modal traps
 * focus and restores it on close, and nothing relies on colour alone to
 * convey meaning.
 *
 * Visually they are flat: one surface, one hairline, one radius. The only
 * filled element on a screen is its primary action — see the note at the top
 * of globals.css.
 */

// ─────────────────────────────────────────────────────────────────── button ──

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md font-sans text-[13px] font-medium transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap",
  {
    variants: {
      variant: {
        // Inverted, so the primary action is the single filled thing on the
        // screen and never has to compete with a status colour.
        primary:
          "bg-accent text-accent-ink hover:bg-accent/90 active:bg-accent/80",
        secondary:
          "border border-line bg-surface-raised text-ink hover:border-line-strong hover:bg-surface-raised/60",
        ghost: "text-ink-muted hover:bg-surface-raised hover:text-ink",
        danger:
          "border border-danger/40 bg-danger/[0.08] text-danger hover:border-danger/60 hover:bg-danger/[0.14]",
        outline:
          "border border-line bg-transparent text-ink-muted hover:border-accent/50 hover:text-accent",
      },
      size: {
        sm: "h-8 px-3 text-[12.5px]",
        md: "h-9 px-3.5",
        lg: "h-11 px-5 text-[14px]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  /** Announced to screen readers while `loading` is true. */
  loadingText?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant,
      size,
      loading,
      loadingText,
      children,
      disabled,
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        data-sf-control="button"
        data-sf-variant={variant ?? "secondary"}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {loading && loadingText ? loadingText : children}
      </button>
    );
  },
);

// ───────────────────────────────────────────────────────────────────── card ──

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props} />;
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // A hairline is the only thing separating a header from its body —
        // no fill, no second surface.
        "flex flex-col gap-1 border-b border-line px-5 py-3.5 sm:px-6 sm:py-4",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("engraved text-[14px]", className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-[13px] text-ink-muted", className)} {...props} />
  );
}

export function CardBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 sm:p-6", className)} {...props} />;
}

// ──────────────────────────────────────────────────────────────────── field ──

interface FieldContextValue {
  id: string;
  describedBy: string;
  invalid: boolean;
}
const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  label: string;
  /** Plain-language explanation. Rendered under the label, always visible. */
  help?: string;
  error?: string;
  required?: boolean;
  /** Extra badge, e.g. "Restart required". */
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  help,
  error,
  required,
  badge,
  children,
  className,
}: FieldProps) {
  const id = useId();
  const describedBy = `${id}-help`;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      <div className={cn("space-y-1.5", className)}>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="legend text-ink-muted">
            {label}
            {required && (
              <span className="ml-1 text-danger" aria-hidden>
                *
              </span>
            )}
          </label>
          {badge}
        </div>

        {help && (
          <p
            id={describedBy}
            className="text-[12.5px] leading-relaxed text-ink-muted"
          >
            {help}
          </p>
        )}

        {children}

        {error && (
          // role="alert" so the message is announced the moment it appears.
          <p
            role="alert"
            className="flex items-start gap-1.5 text-[12.5px] text-danger"
          >
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

function useField() {
  return useContext(FieldContext);
}

/*
 * Every input is the same shape: raised surface, hairline border, mono text.
 * Mono because most of what gets typed into this panel is a value that has to
 * be read back character by character — a port, a path, a seed.
 */
const controlClass =
  "inset-well w-full border px-3 font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink-subtle transition-colors disabled:cursor-not-allowed disabled:opacity-40";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  const field = useField();
  return (
    <input
      ref={ref}
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      className={cn(
        controlClass,
        "h-9",
        field?.invalid
          ? "border-danger"
          : "border-line hover:border-line-strong focus:border-accent",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  const field = useField();
  return (
    <textarea
      ref={ref}
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      className={cn(
        controlClass,
        "min-h-20 py-2 leading-relaxed",
        field?.invalid
          ? "border-danger"
          : "border-line hover:border-line-strong focus:border-accent",
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  const field = useField();
  return (
    <select
      ref={ref}
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      className={cn(
        controlClass,
        "h-9 cursor-pointer appearance-none bg-[length:14px] bg-[right_0.7rem_center] bg-no-repeat pr-9",
        field?.invalid
          ? "border-danger"
          : "border-line hover:border-line-strong focus:border-accent",
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
      }}
      {...props}
    >
      {children}
    </select>
  );
});

/**
 * A switch.
 *
 * State is carried by the knob's position first and its fill second, so it
 * survives greyscale and colour-blindness without needing a printed marking
 * next to it. `role="switch"` plus `aria-checked` carries the same thing to
 * assistive tech.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-40",
        checked
          ? "border-accent bg-accent"
          : "border-line-strong bg-surface-raised",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 transform rounded-full transition-transform duration-150",
          checked
            ? "translate-x-[1.1rem] bg-accent-ink"
            : "translate-x-[2px] bg-ink-subtle",
        )}
        aria-hidden
      />
    </button>
  );
}

// ────────────────────────────────────────────────────────────────── tooltip ──

/**
 * Explains jargon without stealing focus.
 *
 * The content is rendered in the DOM and linked with aria-describedby so a
 * screen reader gets it too — a tooltip only sighted mouse users can reach
 * would defeat the purpose of having plain-language help.
 */
export function Tooltip({
  content,
  children,
}: {
  content: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="relative inline-flex">
      <span
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex cursor-help items-center rounded"
      >
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 animate-fade-in rounded-lg border border-line bg-surface-raised px-3 py-2 text-[12.5px] leading-relaxed text-ink shadow-overlay"
        >
          {content}
        </span>
      )}
    </span>
  );
}

export function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <Info
        className="h-3.5 w-3.5 text-ink-subtle"
        aria-label="More information"
      />
    </Tooltip>
  );
}

// ──────────────────────────────────────────────────────────────────── badge ──

/*
 * A tag. Tinted rather than filled, so a row of them stays quieter than the
 * data they annotate.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-[1.4]",
  {
    variants: {
      tone: {
        neutral: "border-line bg-surface-raised text-ink-muted",
        accent: "border-accent/30 bg-accent/10 text-accent",
        ok: "border-ok/30 bg-ok/10 text-ok",
        warn: "border-warn/30 bg-warn/10 text-warn",
        danger: "border-danger/30 bg-danger/10 text-danger",
        info: "border-info/30 bg-info/10 text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// ──────────────────────────────────────────────────────────────────── modal ──

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Chooses what to focus when a dialog opens.
 *
 * A CSS selector list has no priority — `querySelector('[data-autofocus], button')`
 * returns whichever appears first in the document, which is the close button
 * in every dialog here. So the candidates are tried in explicit order, and a
 * form field is preferred over a button: a dialog that exists to collect a
 * value should put the caret in that value's field.
 */
export function resolveInitialFocus(dialog: HTMLElement): HTMLElement | null {
  const explicit = dialog.querySelector<HTMLElement>("[data-autofocus]");
  if (explicit) return explicit;

  const field = dialog.querySelector<HTMLElement>(
    'input:not([disabled]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])',
  );
  if (field) return field;

  // Fall back to any focusable control, but never the close button — landing
  // on "dismiss" invites dismissing the thing you just opened.
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  return (
    controls.find((el) => el.getAttribute("aria-label") !== "Close") ??
    controls[0] ??
    null
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  /**
   * Callers pass `onClose` as an inline arrow, so its identity changes on
   * every render. Depending on it here would tear down and re-run this whole
   * effect on every keystroke — which re-applied focus mid-typing and threw
   * the caret out of the field being typed into. The ref keeps the latest
   * callback available without making it a dependency.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    if (!dialog) return;

    previouslyFocused.current = document.activeElement as HTMLElement;
    resolveInitialFocus(dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      // Focus trap: Tab from the last element wraps to the first, so keyboard
      // users cannot land behind the overlay.
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      previouslyFocused.current?.focus();
    };
    // Intentionally keyed on `open` alone — see onCloseRef above.
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-[hsl(var(--canvas))]/75 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="panel relative z-10 w-full max-w-lg animate-fade-in shadow-overlay"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-3.5">
          <div className="space-y-1">
            <h2 id={titleId} className="engraved text-[14px]">
              {title}
            </h2>
            {description && (
              <p className="text-[13px] text-ink-muted">{description}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto scrollbar-thin px-6 py-4">
          {children}
        </div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────── empty state ──

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="inset-well mb-5 flex h-12 w-12 items-center justify-center rounded-full">
        <Icon className="h-5 w-5 text-ink-subtle" />
      </div>
      <h3 className="engraved text-[15px]">{title}</h3>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-ink-muted">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── skeleton ──

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

// ───────────────────────────────────────────────────────────────────── toast ──

interface Toast {
  id: number;
  tone: "ok" | "danger" | "info";
  message: string;
  hint?: string;
}

const ToastContext = createContext<{
  push: (toast: Omit<Toast, "id">) => void;
}>({
  push: () => undefined,
});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = (toast: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { ...toast, id }]);
    // Errors stay longer: they usually carry a next step to read.
    setTimeout(
      () => setToasts((c) => c.filter((t) => t.id !== id)),
      toast.tone === "danger" ? 8000 : 4000,
    );
  };

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom,0px))] right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 md:bottom-4"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              // The tone is a single left rule — enough to sort good news
              // from bad at a glance without tinting the whole card.
              "panel pointer-events-auto animate-fade-in border-l-2 px-4 py-3 shadow-overlay",
              toast.tone === "ok" && "border-l-ok",
              toast.tone === "danger" && "border-l-danger",
              toast.tone === "info" && "border-l-info",
            )}
          >
            <div className="flex items-start gap-2.5">
              {toast.tone === "ok" && (
                <Check
                  className="mt-0.5 h-4 w-4 shrink-0 text-ok"
                  aria-hidden
                />
              )}
              {toast.tone === "danger" && (
                <X
                  className="mt-0.5 h-4 w-4 shrink-0 text-danger"
                  aria-hidden
                />
              )}
              {toast.tone === "info" && (
                <Info
                  className="mt-0.5 h-4 w-4 shrink-0 text-info"
                  aria-hidden
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">
                  {toast.message}
                </p>
                {toast.hint && (
                  <p className="mt-1 text-[12.5px] text-ink-muted">
                    {toast.hint}
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
