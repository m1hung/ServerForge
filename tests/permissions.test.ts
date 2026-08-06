import { describe, expect, it } from 'vitest';
import {
  SERVER_PERMISSIONS,
  canAccessServer,
  effectiveServerPermissions,
  explainRefusal,
  resolveServerAccess,
  sanitisePermissionMap,
  type AccessInput,
} from '../packages/core/src/index.js';

/**
 * Authorisation rules, checked exhaustively.
 *
 * This is the function that decides whether a request is allowed, so the cases
 * below are deliberately boring and complete rather than illustrative.
 */

const owner: AccessInput = { panelRole: 'owner' };
const admin: AccessInput = { panelRole: 'admin' };
const plain: AccessInput = { panelRole: 'user' };

describe('the panel owner', () => {
  it('is allowed everything', () => {
    for (const permission of SERVER_PERMISSIONS) {
      expect(canAccessServer(owner, permission)).toBe(true);
    }
  });

  it('cannot be denied, or the panel would have no way back in', () => {
    const denied: AccessInput = {
      panelRole: 'owner',
      roles: [{ name: 'Locked out', permissions: { 'server.delete': 'deny' } }],
    };
    const decision = resolveServerAccess(denied, 'server.delete');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('panel-owner');
  });
});

describe('deny', () => {
  it('beats a panel admin', () => {
    const input: AccessInput = {
      panelRole: 'admin',
      roles: [{ name: 'No files', permissions: { 'server.files': 'deny' } }],
    };
    expect(canAccessServer(input, 'server.files')).toBe(false);
    // Other permissions are untouched.
    expect(canAccessServer(input, 'server.power')).toBe(true);
  });

  it("beats the server's own owner", () => {
    const input: AccessInput = {
      panelRole: 'user',
      isServerOwner: true,
      roles: [{ name: 'Restricted', permissions: { 'server.delete': 'deny' } }],
    };
    expect(canAccessServer(input, 'server.delete')).toBe(false);
    expect(canAccessServer(input, 'server.console')).toBe(true);
  });

  it('beats an allow in another role, whichever order they are in', () => {
    const permissions = { 'server.files': 'allow' } as const;
    const blocked = { 'server.files': 'deny' } as const;

    const allowFirst: AccessInput = {
      panelRole: 'user',
      roles: [
        { name: 'Staff', permissions },
        { name: 'Restricted', permissions: blocked },
      ],
    };
    const denyFirst: AccessInput = {
      panelRole: 'user',
      roles: [
        { name: 'Restricted', permissions: blocked },
        { name: 'Staff', permissions },
      ],
    };

    expect(canAccessServer(allowFirst, 'server.files')).toBe(false);
    expect(canAccessServer(denyFirst, 'server.files')).toBe(false);
  });

  it('beats a direct grant on the membership row', () => {
    const input: AccessInput = {
      panelRole: 'user',
      directGrants: ['server.files'],
      roles: [{ name: 'Restricted', permissions: { 'server.files': 'deny' } }],
    };
    expect(canAccessServer(input, 'server.files')).toBe(false);
  });

  it('names the role responsible, so the message can be acted on', () => {
    const input: AccessInput = {
      panelRole: 'admin',
      roles: [{ name: 'Read only', permissions: { 'server.power': 'deny' } }],
    };
    const decision = resolveServerAccess(input, 'server.power');
    expect(decision.role).toBe('Read only');
    expect(explainRefusal(decision, 'server.power')).toContain('Read only');
  });
});

describe('neutral', () => {
  it('is not a grant', () => {
    const input: AccessInput = { panelRole: 'user', roles: [{ name: 'Empty', permissions: {} }] };
    expect(canAccessServer(input, 'server.power')).toBe(false);
  });

  it('does not block what another role grants', () => {
    const input: AccessInput = {
      panelRole: 'user',
      roles: [
        { name: 'Empty', permissions: {} },
        { name: 'Operators', permissions: { 'server.power': 'allow' } },
      ],
    };
    expect(canAccessServer(input, 'server.power')).toBe(true);
  });

  it('leaves a panel admin with the access they already had', () => {
    const input: AccessInput = { panelRole: 'admin', roles: [{ name: 'Empty', permissions: {} }] };
    expect(canAccessServer(input, 'server.files')).toBe(true);
  });
});

describe('grants', () => {
  it('come from a role', () => {
    const input: AccessInput = {
      panelRole: 'user',
      roles: [{ name: 'Operators', permissions: { 'server.console': 'allow' } }],
    };
    const decision = resolveServerAccess(input, 'server.console');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('granted-by-role');
    expect(decision.role).toBe('Operators');
  });

  it('still come from the direct list, which predates roles', () => {
    const input: AccessInput = { panelRole: 'user', directGrants: ['server.console'] };
    const decision = resolveServerAccess(input, 'server.console');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('granted-directly');
  });

  it('do not leak to permissions nobody granted', () => {
    const input: AccessInput = { panelRole: 'user', directGrants: ['server.console'] };
    expect(canAccessServer(input, 'server.delete')).toBe(false);
  });
});

describe('a user with nothing', () => {
  it('is refused everything', () => {
    for (const permission of SERVER_PERMISSIONS) {
      expect(canAccessServer(plain, permission)).toBe(false);
    }
  });

  it('defaults to refusal rather than to permission', () => {
    expect(resolveServerAccess(plain, 'server.view').reason).toBe('not-granted');
  });
});

describe('effectiveServerPermissions', () => {
  it('matches the per-permission check for every permission', () => {
    const cases: AccessInput[] = [
      owner,
      admin,
      plain,
      { panelRole: 'user', isServerOwner: true },
      { panelRole: 'user', directGrants: ['server.view', 'server.console'] },
      {
        panelRole: 'admin',
        roles: [{ name: 'Restricted', permissions: { 'server.delete': 'deny' } }],
      },
      {
        panelRole: 'user',
        directGrants: ['server.files'],
        roles: [
          { name: 'Staff', permissions: { 'server.power': 'allow' } },
          { name: 'Restricted', permissions: { 'server.files': 'deny' } },
        ],
      },
    ];

    // The dashboard hides tabs using this list while the API checks each
    // request individually. If the two ever disagreed, someone would see a tab
    // that 403s, or lose one they are entitled to.
    for (const input of cases) {
      const effective = effectiveServerPermissions(input);
      for (const permission of SERVER_PERMISSIONS) {
        expect(effective.includes(permission)).toBe(canAccessServer(input, permission));
      }
    }
  });

  it('gives an admin with a deny everything except that one', () => {
    const effective = effectiveServerPermissions({
      panelRole: 'admin',
      roles: [{ name: 'Restricted', permissions: { 'server.delete': 'deny' } }],
    });
    expect(effective).not.toContain('server.delete');
    expect(effective).toContain('server.power');
    expect(effective).toHaveLength(SERVER_PERMISSIONS.length - 1);
  });
});

describe('sanitisePermissionMap', () => {
  it('keeps known permissions with valid states', () => {
    expect(sanitisePermissionMap({ 'server.power': 'allow', 'server.files': 'deny' })).toEqual({
      'server.power': 'allow',
      'server.files': 'deny',
    });
  });

  it('drops permissions that do not exist', () => {
    expect(sanitisePermissionMap({ 'server.launch_missiles': 'allow' })).toEqual({});
  });

  it('drops states that are not allow or deny', () => {
    // "neutral" is expressed by absence, so accepting it as a value would
    // create two ways to say the same thing.
    expect(sanitisePermissionMap({ 'server.power': 'neutral' })).toEqual({});
    expect(sanitisePermissionMap({ 'server.power': true })).toEqual({});
  });

  it('survives junk', () => {
    expect(sanitisePermissionMap(null)).toEqual({});
    expect(sanitisePermissionMap('nope')).toEqual({});
    expect(sanitisePermissionMap([])).toEqual({});
  });
});
