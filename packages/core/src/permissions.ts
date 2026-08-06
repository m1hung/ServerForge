import { SERVER_PERMISSIONS, type Role, type ServerPermission } from './types.js';

/**
 * Who may do what on a server.
 *
 * Permissions come from four places — the panel role, owning the server, roles
 * assigned on that server, and direct grants on the membership row — and this
 * is the only thing that decides how they combine. Keeping it a pure function
 * means the rules can be tested exhaustively without a database, which for
 * authorisation code is the difference between "we think" and "we know".
 *
 * Two rules, in this order:
 *
 *   1. The panel owner is always allowed. Nothing can deny them, because a
 *      panel whose owner can be locked out of it has no way back.
 *   2. Otherwise a deny beats everything. A role that denies `server.files`
 *      takes it away from a panel admin and from the server's own owner, which
 *      is the whole point of having deny rather than just "not granted".
 *
 * Everything else is a grant, and a permission nobody grants is refused.
 */

export type PermissionState = 'allow' | 'deny';

/** A permission that is absent is *neutral*: it neither grants nor blocks. */
export type PermissionMap = Partial<Record<ServerPermission, PermissionState>>;

export interface AssignedRole {
  /** Shown in the "why can't I?" message, so it must be the human name. */
  name: string;
  permissions: PermissionMap;
}

export interface AccessInput {
  panelRole: Role;
  /** True when this person owns the server being checked. */
  isServerOwner?: boolean;
  /**
   * Direct allow grants on the membership row. Predates roles and still
   * works — a small panel should not have to define a role to share a server.
   */
  directGrants?: readonly string[];
  /** Roles assigned to this person on this server. */
  roles?: readonly AssignedRole[];
}

export type AccessReason =
  | 'panel-owner'
  | 'denied-by-role'
  | 'server-owner'
  | 'panel-admin'
  | 'granted-by-role'
  | 'granted-directly'
  | 'not-granted';

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  /** The role responsible, when a role decided it. */
  role?: string;
}

export function resolveServerAccess(
  input: AccessInput,
  permission: ServerPermission,
): AccessDecision {
  // The one exemption. Deliberately before the deny sweep.
  if (input.panelRole === 'owner') {
    return { allowed: true, reason: 'panel-owner' };
  }

  const denying = (input.roles ?? []).find((role) => role.permissions[permission] === 'deny');
  if (denying) {
    return { allowed: false, reason: 'denied-by-role', role: denying.name };
  }

  if (input.isServerOwner) return { allowed: true, reason: 'server-owner' };
  if (input.panelRole === 'admin') return { allowed: true, reason: 'panel-admin' };

  const granting = (input.roles ?? []).find((role) => role.permissions[permission] === 'allow');
  if (granting) return { allowed: true, reason: 'granted-by-role', role: granting.name };

  if ((input.directGrants ?? []).includes(permission)) {
    return { allowed: true, reason: 'granted-directly' };
  }

  return { allowed: false, reason: 'not-granted' };
}

/** Convenience for call sites that only need the yes/no. */
export function canAccessServer(input: AccessInput, permission: ServerPermission): boolean {
  return resolveServerAccess(input, permission).allowed;
}

/**
 * Every permission this person actually holds, after roles and denies.
 *
 * The dashboard uses this to decide which tabs to show, so it has to agree
 * with the per-request check exactly — hence both going through the same
 * function rather than the UI reimplementing the rules.
 */
export function effectiveServerPermissions(input: AccessInput): ServerPermission[] {
  return SERVER_PERMISSIONS.filter((permission) => canAccessServer(input, permission));
}

/** Explains a refusal in the terms the person reading it can act on. */
export function explainRefusal(decision: AccessDecision, permission: ServerPermission): string {
  const label = permission.replace('server.', '');
  if (decision.reason === 'denied-by-role') {
    return `The "${decision.role}" role blocks ${label} here, which overrides any other access you have.`;
  }
  return `You don't have the "${label}" permission here.`;
}

/** Drops unknown keys and bad states from a submitted permission map. */
export function sanitisePermissionMap(input: unknown): PermissionMap {
  if (!input || typeof input !== 'object') return {};
  const output: PermissionMap = {};
  for (const permission of SERVER_PERMISSIONS) {
    const value = (input as Record<string, unknown>)[permission];
    if (value === 'allow' || value === 'deny') output[permission] = value;
  }
  return output;
}
