import { z } from 'zod';
import { SERVER_PERMISSIONS, SCHEDULE_TRIGGERS } from './types.js';

/**
 * Wire contracts. The API validates every request body against these and the
 * dashboard imports the inferred types, so a shape change is a compile error
 * on both sides rather than a runtime surprise.
 */

export const idSchema = z.string().min(1).max(64);

/**
 * Sign-in handle. Letters, numbers, underscores and dashes — short enough to
 * type, long enough to avoid collisions on a shared panel.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Usernames need at least 3 characters.')
  .max(32, 'Usernames are capped at 32 characters.')
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'Use letters, numbers, underscores or dashes. Start with a letter or number.',
  );

/**
 * Deliberately length-based rather than a character-class gauntlet: NIST
 * guidance, and it produces fewer abandoned signups.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters — a short phrase works well.')
  .max(200, 'That password is too long.');

export const registerSchema = z.object({
  setupToken: z.string().max(200).optional(),
  username: usernameSchema,
  password: passwordSchema,
  /** Optional profile name; defaults to the username when omitted. */
  displayName: z.string().trim().min(1).max(64).optional(),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, 'Enter your password.').max(200, 'That password is too long.'),
});

/**
 * Second step of a sign-in that needs two-factor.
 *
 * Either a six-digit app code or a recovery code — one field rather than two,
 * because asking someone to pick which kind they are holding is a question
 * they should not have to answer.
 */
export const twoFactorLoginSchema = z.object({
  ticket: z.string().min(1).max(256),
  code: z.string().trim().min(1, 'Enter the code from your authenticator app.').max(32),
});

export const serverNameSchema = z
  .string()
  .trim()
  .min(2, 'Give your server a name of at least 2 characters.')
  .max(48, 'Server names are capped at 48 characters.')
  .regex(/^[\w][\w .'-]*$/u, 'Use letters, numbers, spaces, dots, apostrophes or dashes.');

/**
 * Optional fields are also nullable here on purpose.
 *
 * The API returns `swapMib: null` for a server that has no swap override, so
 * a client reading a server and writing it straight back must validate. An
 * `optional()`-only schema rejects its own output, which is a round-trip bug
 * waiting to happen in every form that edits limits.
 */
export const resourceLimitsSchema = z.object({
  memoryMib: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024),
  cpuCores: z.number().min(0).max(256),
  diskMib: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024 * 4),
  swapMib: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024)
    .nullable()
    .optional(),
  ioWeight: z.number().int().min(10).max(1000).nullable().optional(),
});

/** Body for the deploy wizard's final step. */
export const createServerSchema = z.object({
  name: serverNameSchema,
  description: z.string().trim().max(500).optional(),
  gameId: z.string().min(1),
  /** Adapter variant, e.g. "paper" or "palworld-vanilla". */
  variantId: z.string().min(1),
  /** Resolved upstream version, or "latest" to resolve at install time. */
  version: z.string().min(1).max(64).default('latest'),
  nodeId: idSchema.optional(),
  limits: resourceLimitsSchema,
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Requested primary port. Omit to let the allocator choose. */
  port: z.number().int().min(1024).max(65535).optional(),
  startOnCreate: z.boolean().default(true),
  runtimePlatform: z.enum(['linux/amd64', 'linux/arm64']).optional(),
  allowExperimental: z.boolean().default(false),
  acceptedEula: z.string().max(100).optional(),
});

export const updateServerSchema = z.object({
  name: serverNameSchema.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  limits: resourceLimitsSchema.partial().optional(),
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const powerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'kill']),
});

export const consoleCommandSchema = z.object({
  command: z.string().min(1).max(4096),
});

export const settingsPatchSchema = z.object({
  values: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

export const filePathQuerySchema = z.object({
  path: z.string().max(4096).default('/'),
});

export const renameFileSchema = z.object({
  from: z.string().max(4096),
  to: z.string().max(4096),
});

export const scheduleActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('power'),
    action: z.enum(['start', 'stop', 'restart']),
    warningSeconds: z.number().int().min(0).max(300).default(0),
  }),
  z.object({ type: z.literal('command'), command: z.string().min(1).max(1024) }),
  z.object({ type: z.literal('backup'), retain: z.number().int().min(1).max(50).default(5) }),
  z.object({
    type: z.literal('update'),
    /** Restart after the update finishes. */
    startAfter: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('webhook'),
    /**
     * Where to POST. Validated for shape here; whether it points somewhere on
     * the public internet is decided by the API, which can resolve it.
     */
    url: z.string().url().max(2048),
    /** Message body, with {server} {player} {event} {task} placeholders. */
    template: z.string().min(1).max(1024).default('{server}: {event}'),
    /** `discord` sends {content}; `json` sends the event fields. */
    format: z.enum(['discord', 'json']).default('discord'),
  }),
]);

const scheduleFields = z.object({
  name: z.string().trim().min(1).max(64),
  /** Standard 5-field cron in the server's configured timezone. */
  cron: z.string().min(9).max(128).nullish(),
  /** A server event, for schedules that react instead of repeat. */
  triggerType: z.enum(SCHEDULE_TRIGGERS).nullish(),
  /** Suppresses a re-fire within this window. Only meaningful with a trigger. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
  timezone: z.string().max(64).default('UTC'),
  enabled: z.boolean().default(true),
  onlyWhenOnline: z.boolean().default(true),
  actions: z.array(scheduleActionSchema).min(1).max(10),
});

/** A schedule runs on a clock or in response to an event, never both. */
export const scheduleSchema = scheduleFields.superRefine((value, ctx) => {
  if (value.cron && value.triggerType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['triggerType'],
      message: 'A schedule runs either on a repeating time or on an event, not both.',
    });
  }
});

/**
 * PATCH body. Deliberately not refined: a patch that only renames a schedule
 * carries neither timing field, so the either/or rule can only be applied once
 * the body has been merged over the stored row — which the route does with
 * `scheduleTimingIsValid`.
 */
export const scheduleUpdateSchema = scheduleFields.partial();

/** The either/or rule, applied to a fully merged row rather than a patch. */
export function scheduleTimingIsValid(value: {
  cron?: string | null;
  triggerType?: string | null;
}): boolean {
  return Boolean(value.cron) !== Boolean(value.triggerType);
}

export const subuserSchema = z.object({
  username: usernameSchema,
  permissions: z.array(z.enum(SERVER_PERMISSIONS)).min(1),
});
export type UpdateServerInput = z.infer<typeof updateServerSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
