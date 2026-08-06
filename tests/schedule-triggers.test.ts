import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_TRIGGERS,
  scheduleSchema,
  scheduleTimingIsValid,
  scheduleUpdateSchema,
} from '../packages/core/src/index.js';

/**
 * Schedules run on a clock or on an event, never both and never neither.
 *
 * The rule is enforced in two places on purpose: `scheduleSchema` catches a
 * create that sets both, and `scheduleTimingIsValid` catches the merged result
 * of a PATCH — where either field may be absent simply because the caller was
 * only renaming the task.
 */

const actions = [{ type: 'power' as const, action: 'restart' as const }];

describe('scheduleSchema', () => {
  it('accepts a cron schedule', () => {
    const parsed = scheduleSchema.parse({ name: 'Nightly', cron: '0 4 * * *', actions });
    expect(parsed.cron).toBe('0 4 * * *');
    expect(parsed.triggerType).toBeUndefined();
    expect(parsed.cooldownSeconds).toBe(0);
  });

  it('accepts an event schedule with a cooldown', () => {
    const parsed = scheduleSchema.parse({
      name: 'Backup on join',
      triggerType: 'player.join',
      cooldownSeconds: 300,
      actions,
    });
    expect(parsed.triggerType).toBe('player.join');
    expect(parsed.cooldownSeconds).toBe(300);
  });

  it('accepts an explicit null for the side that is not in use', () => {
    const parsed = scheduleSchema.parse({
      name: 'Backup on join',
      cron: null,
      triggerType: 'player.join',
      actions,
    });
    expect(parsed.cron).toBeNull();
  });

  it('rejects a schedule that is both timed and triggered', () => {
    const result = scheduleSchema.safeParse({
      name: 'Both',
      cron: '0 4 * * *',
      triggerType: 'player.join',
      actions,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown trigger', () => {
    const result = scheduleSchema.safeParse({
      name: 'Nope',
      triggerType: 'player.sneezed',
      actions,
    });
    expect(result.success).toBe(false);
  });

  it('caps the cooldown at a day', () => {
    expect(
      scheduleSchema.safeParse({
        name: 'Too long',
        triggerType: 'player.join',
        cooldownSeconds: 86_401,
        actions,
      }).success,
    ).toBe(false);
  });
});

describe('scheduleUpdateSchema', () => {
  it('allows a patch that touches neither timing field', () => {
    const parsed = scheduleUpdateSchema.parse({ name: 'Renamed' });
    expect(parsed.name).toBe('Renamed');
    expect(parsed.cron).toBeUndefined();
    expect(parsed.triggerType).toBeUndefined();
  });

  it('distinguishes "not supplied" from "explicitly cleared"', () => {
    // The route relies on this: `undefined` keeps the stored value, `null`
    // clears it. Collapsing the two would make switching a schedule from
    // timed to triggered impossible.
    const cleared = scheduleUpdateSchema.parse({ cron: null, triggerType: 'server.ready' });
    expect(cleared.cron).toBeNull();

    const untouched = scheduleUpdateSchema.parse({ triggerType: 'server.ready' });
    expect(untouched.cron).toBeUndefined();
  });

  it('still allows a patch that only pauses a schedule', () => {
    expect(scheduleUpdateSchema.parse({ enabled: false }).enabled).toBe(false);
  });
});

describe('scheduleTimingIsValid', () => {
  it('accepts exactly one of the two', () => {
    expect(scheduleTimingIsValid({ cron: '0 4 * * *', triggerType: null })).toBe(true);
    expect(scheduleTimingIsValid({ cron: null, triggerType: 'player.join' })).toBe(true);
  });

  it('rejects both, which would fire from two directions', () => {
    expect(scheduleTimingIsValid({ cron: '0 4 * * *', triggerType: 'player.join' })).toBe(false);
  });

  it('rejects neither, which would never fire at all', () => {
    expect(scheduleTimingIsValid({ cron: null, triggerType: null })).toBe(false);
    expect(scheduleTimingIsValid({})).toBe(false);
  });

  it('treats an empty cron string as absent rather than as a value', () => {
    expect(scheduleTimingIsValid({ cron: '', triggerType: 'player.join' })).toBe(true);
    expect(scheduleTimingIsValid({ cron: '', triggerType: null })).toBe(false);
  });
});

describe('SCHEDULE_TRIGGERS', () => {
  it('covers both event sources the panel already detects', () => {
    // Player events come from the adapter's inspectLog; the rest from the
    // single writer for server state. Anything added here needs a publisher.
    expect(SCHEDULE_TRIGGERS).toContain('player.join');
    expect(SCHEDULE_TRIGGERS).toContain('player.leave');
    expect(SCHEDULE_TRIGGERS).toContain('server.ready');
    expect(SCHEDULE_TRIGGERS).toContain('server.crashed');
    expect(SCHEDULE_TRIGGERS).toContain('server.stopped');
  });
});
