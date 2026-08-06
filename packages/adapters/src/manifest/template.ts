import type { ServerContext } from '../types.js';
import type { ManifestArg, ManifestCondition } from './types.js';

/**
 * Token substitution for manifest strings.
 *
 * Deliberately not an expression language. Manifests are contributed by people
 * who want to add a game, not to program, and every construct this format
 * grows is one more thing that can be subtly wrong in a file nobody can run a
 * debugger on. Tokens resolve values and nothing else; anything conditional is
 * expressed structurally, with `when`.
 *
 * Substituted values never reach a shell — argv is passed as an array — so
 * quoting is not a concern here. A missing reference is: it resolves to empty
 * rather than throwing, because a game whose optional field is blank must
 * still start, and `validateManifest` has already rejected references to
 * settings that do not exist.
 */

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([a-zA-Z]+)\s*)?\}\}/g;

export interface TemplateScope {
  ctx: ServerContext;
}

/** Resolves one reference against a server, or undefined when unknown. */
export function resolveRef(ref: string, ctx: ServerContext): string | number | boolean | undefined {
  if (ref.startsWith('setting.')) {
    return ctx.settings[ref.slice('setting.'.length)];
  }

  if (ref.startsWith('port.')) {
    const purpose = ref.slice('port.'.length);
    return ctx.allocations.find((a) => a.purpose === purpose)?.port;
  }

  if (ref.startsWith('env.')) {
    return ctx.environment[ref.slice('env.'.length)];
  }

  switch (ref) {
    case 'serverUid':
      return ctx.serverUid;
    case 'serverName':
      return ctx.name;
    case 'version':
      return ctx.version;
    case 'variantId':
      return ctx.variantId;
    case 'memoryMib':
      return ctx.memoryMib;
    case 'cpuCores':
      return ctx.cpuCores;
    case 'dataPath':
      return ctx.dataPath;
    default:
      return undefined;
  }
}

/**
 * Filters, applied as `{{setting.Public|number}}`.
 *
 * `number` exists because games overwhelmingly want 1/0 on the command line
 * where the panel models a checkbox, and writing "true" there is a silent
 * misconfiguration rather than an error.
 */
function applyFilter(value: string | number | boolean, filter: string | undefined): string {
  switch (filter) {
    case undefined:
      return String(value);
    case 'number':
      if (typeof value === 'boolean') return value ? '1' : '0';
      return String(value);
    case 'lower':
      return String(value).toLowerCase();
    case 'upper':
      return String(value).toUpperCase();
    case 'json':
      return JSON.stringify(value);
    default:
      // Unknown filters are rejected at validation time; reaching here means
      // the manifest bypassed it, so fall back to the raw value.
      return String(value);
  }
}

export const KNOWN_FILTERS = ['number', 'lower', 'upper', 'json'];

/** Substitutes every token in a string. */
export function renderTemplate(template: string, ctx: ServerContext): string {
  return template.replace(TOKEN, (_match, ref: string, filter?: string) => {
    const value = resolveRef(ref, ctx);
    if (value === undefined || value === null) return '';
    return applyFilter(value, filter);
  });
}

/** Every `{{ref|filter}}` in a string, for validation. */
export function extractRefs(template: string): { ref: string; filter?: string }[] {
  const out: { ref: string; filter?: string }[] = [];
  for (const match of template.matchAll(TOKEN)) {
    out.push({ ref: match[1]!, filter: match[2] });
  }
  return out;
}

/**
 * Whether a conditional group applies.
 *
 * "Set" means non-empty and not false. An empty string and a `false` checkbox
 * both mean "the user did not ask for this", and both are the reason the flag
 * should be left off rather than passed with a blank value.
 */
export function evaluateCondition(condition: ManifestCondition, ctx: ServerContext): boolean {
  const value = resolveRef(condition.ref, ctx);

  if (condition.equals !== undefined) {
    return condition.equals.some((candidate) => String(candidate) === String(value ?? ''));
  }

  if (condition.isSet === false) return !isSet(value);
  return isSet(value);
}

function isSet(value: string | number | boolean | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return true;
  return value.trim() !== '';
}

/** Renders a templated argv, dropping groups whose condition does not hold. */
export function renderArgs(args: ManifestArg[], ctx: ServerContext): string[] {
  const out: string[] = [];

  for (const arg of args) {
    if (typeof arg === 'string') {
      out.push(renderTemplate(arg, ctx));
      continue;
    }
    if (!evaluateCondition(arg.when, ctx)) continue;
    for (const inner of arg.args) out.push(renderTemplate(inner, ctx));
  }

  return out;
}

/** Renders a templated env map. */
export function renderEnv(
  env: Record<string, string> | undefined,
  ctx: ServerContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    out[key] = renderTemplate(value, ctx);
  }
  return out;
}
