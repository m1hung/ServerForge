"use client";

import { cn } from "@/lib/utils";

/**
 * Server health indicator.
 *
 * Colour alone never carries the meaning — there is always a label, and the
 * animated ring only appears for transitional states so a glance at the fleet
 * page shows which servers are mid-action.
 */

export type ServerState =
  | "creating"
  | "installing"
  | "install_failed"
  | "offline"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "updating"
  | "restoring"
  | "suspended"
  | "deleting";

interface StateStyle {
  label: string;
  /**
   * The dot colour, as a `text-*` class.
   *
   * It is text- rather than bg- because the dot is drawn from `currentColor`:
   * one class colours the dot and its label together, so they can never end
   * up disagreeing.
   */
  text: string;
  /** Transitional states get a slow halo, so mid-action servers stand out. */
  pulse: boolean;
  /** One line explaining what is happening, shown on the server page. */
  explain: string;
}

export const STATE_STYLES: Record<ServerState, StateStyle> = {
  creating: {
    label: "Creating",
    text: "text-info",
    pulse: true,
    explain: "Setting up the server folder.",
  },
  installing: {
    label: "Installing",
    text: "text-info",
    pulse: true,
    explain: "Downloading and unpacking the server files.",
  },
  install_failed: {
    label: "Install failed",
    text: "text-danger",
    pulse: false,
    explain:
      "Something went wrong during installation. The install log has the details.",
  },
  offline: {
    label: "Offline",
    text: "text-ink-muted",
    pulse: false,
    explain: "The server is stopped. Press Start when you are ready.",
  },
  starting: {
    label: "Starting",
    text: "text-warn",
    pulse: true,
    explain: "Booting up. Large modpacks can take a few minutes.",
  },
  running: {
    label: "Online",
    text: "text-ok",
    pulse: false,
    explain: "Accepting players.",
  },
  stopping: {
    label: "Stopping",
    text: "text-warn",
    pulse: true,
    explain: "Saving the world and shutting down.",
  },
  crashed: {
    label: "Crashed",
    text: "text-danger",
    pulse: false,
    explain:
      "The server stopped unexpectedly. The last console lines usually say why.",
  },
  updating: {
    label: "Updating",
    text: "text-info",
    pulse: true,
    explain: "Installing a new version.",
  },
  restoring: {
    label: "Restoring",
    text: "text-info",
    pulse: true,
    explain: "Putting a backup back in place.",
  },
  suspended: {
    label: "Suspended",
    text: "text-ink-muted",
    pulse: false,
    explain: "An administrator has suspended this server.",
  },
  deleting: {
    label: "Deleting",
    text: "text-danger",
    pulse: true,
    explain: "Removing the server and its files.",
  },
};

/**
 * The status dot.
 *
 * Resting states get a flat grey dot rather than a coloured one: in an
 * interface where colour only ever means "something is happening", a stopped
 * server should not be wearing any.
 */
export function StatusDot({
  state,
  className,
}: {
  state: ServerState;
  className?: string;
}) {
  const style = STATE_STYLES[state] ?? STATE_STYLES.offline;
  const dark = state === "offline" || state === "suspended";

  return (
    <span
      className={cn(
        "relative flex h-[7px] w-[7px] shrink-0",
        style.text,
        className,
      )}
    >
      {style.pulse && (
        <span
          className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-current"
          aria-hidden
        />
      )}
      <span
        className={cn("relative h-full w-full", dark ? "lamp-off" : "lamp")}
        aria-hidden
      />
    </span>
  );
}

/**
 * The status label.
 *
 * A dot and its word, sharing one colour via currentColor. Three signals
 * carry the state — coloured/grey, hue, and the word itself — so it survives
 * greyscale, colour-blindness, and a glance from across the room.
 */
export function StatusBadge({
  state,
  className,
}: {
  state: ServerState;
  className?: string;
}) {
  const style = STATE_STYLES[state] ?? STATE_STYLES.offline;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11.5px] font-medium leading-none",
        style.text,
        className,
      )}
    >
      <StatusDot state={state} />
      {style.label}
    </span>
  );
}
