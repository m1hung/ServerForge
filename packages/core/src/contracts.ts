import { z } from 'zod';
import { SERVER_PERMISSIONS, ROLES } from './types.js';

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
  username: usernameSchema,
  password: passwordSchema,
  /** Optional profile name; defaults to the username when omitted. */
  displayName: z.string().trim().min(1).max(64).optional(),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, 'Enter your password.'),
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
  memoryMib: z.number().int().min(0).max(1024 * 1024),
  cpuCores: z.number().min(0).max(256),
  diskMib: z.number().int().min(0).max(1024 * 1024 * 4),
  swapMib: z.number().int().min(0).max(1024 * 1024).nullable().optional(),
  ioWeight: z.number().int().min(1).max(1000).nullable().optional(),
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
});

export const updateServerSchema = z.object({
  name: serverNameSchema.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  limits: resourceLimitsSchema.partial().optional(),
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

export const startupPatchSchema = z.object({
  /** Advanced escape hatch: overrides the adapter's generated command. */
  startupOverride: z.string().max(4096).nullable().optional(),
  javaFlagsPreset: z.enum(['balanced', 'aikar', 'minimal', 'custom']).optional(),
  customJavaFlags: z.string().max(2048).optional(),
  environment: z.record(z.string().max(2048)).optional(),
});

export const filePathQuerySchema = z.object({
  path: z.string().max(4096).default('/'),
});

export const writeFileSchema = z.object({
  path: z.string().max(4096),
  content: z.string().max(10 * 1024 * 1024),
});

export const renameFileSchema = z.object({
  from: z.string().max(4096),
  to: z.string().max(4096),
});

export const createBackupSchema = z.object({
  name: z.string().trim().max(64).optional(),
  /** Glob patterns excluded from the archive, on top of adapter defaults. */
  ignore: z.array(z.string().max(256)).max(64).default([]),
});

export const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** Standard 5-field cron in the server's configured timezone. */
  cron: z.string().min(9).max(128),
  timezone: z.string().max(64).default('UTC'),
  enabled: z.boolean().default(true),
  onlyWhenOnline: z.boolean().default(true),
  actions: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('power'), action: z.enum(['start', 'stop', 'restart']) }),
        z.object({ type: z.literal('command'), command: z.string().min(1).max(1024) }),
        z.object({ type: z.literal('backup'), retain: z.number().int().min(1).max(50).default(5) }),
        z.object({
          type: z.literal('update'),
          /** Restart after the update finishes. */
          startAfter: z.boolean().default(true),
        }),
      ]),
    )
    .min(1)
    .max(10),
});

export const subuserSchema = z.object({
  username: usernameSchema,
  permissions: z.array(z.enum(SERVER_PERMISSIONS)).min(1),
});

export const apiKeySchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** Null = never expires. */
  expiresAt: z.string().datetime().nullable().optional(),
  scopes: z
    .array(z.union([z.literal('*'), z.literal('admin'), z.enum(SERVER_PERMISSIONS)]))
    .min(1)
    .max(32)
    .default(['*']),
});

export const cloneServerSchema = z.object({
  name: serverNameSchema,
});

export const inviteUserSchema = z.object({
  username: usernameSchema,
  role: z.enum(ROLES).default('user'),
});

export const modInstallSchema = z.object({
  source: z.enum(['modrinth', 'curseforge', 'upload', 'url']),
  /** Project slug/id for registry sources. */
  projectId: z.string().max(128).optional(),
  versionId: z.string().max(128).optional(),
  url: z.string().url().max(2048).optional(),
  kind: z.enum(['mod', 'plugin', 'modpack', 'datapack', 'resourcepack']).default('mod'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateServerInput = z.infer<typeof createServerSchema>;
export type UpdateServerInput = z.infer<typeof updateServerSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type ModInstallInput = z.infer<typeof modInstallSchema>;
export type ResourceLimitsInput = z.infer<typeof resourceLimitsSchema>;
export type CloneServerInput = z.infer<typeof cloneServerSchema>;
