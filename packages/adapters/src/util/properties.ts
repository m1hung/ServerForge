/**
 * `server.properties` reader/writer.
 *
 * Deliberately preserves comments, blank lines and key order on rewrite:
 * users hand-edit this file, and a panel that reformats it on every save is
 * a panel people stop trusting.
 */

export type Properties = Record<string, string>;

export function parseProperties(text: string): Properties {
  const out: Properties = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    out[key] = unescapeValue(line.slice(eq + 1));
  }
  return out;
}

/**
 * Applies `updates` onto `existing` text. Keys already present are updated
 * in place; new keys are appended under a generated section header.
 */
export function mergeProperties(existing: string, updates: Properties): string {
  const remaining = new Map(Object.entries(updates));
  const lines = existing.split(/\r?\n/);

  const merged = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) return rawLine;
    const eq = line.indexOf('=');
    if (eq === -1) return rawLine;
    const key = line.slice(0, eq).trim();
    if (!remaining.has(key)) return rawLine;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${escapeValue(value)}`;
  });

  if (remaining.size > 0) {
    if (merged.length > 0 && merged[merged.length - 1]!.trim() !== '') merged.push('');
    for (const [key, value] of remaining) merged.push(`${key}=${escapeValue(value)}`);
  }

  let text = merged.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

export function stringifyProperties(props: Properties, header?: string): string {
  const lines: string[] = [];
  if (header) for (const line of header.split('\n')) lines.push(`# ${line}`);
  for (const [key, value] of Object.entries(props)) lines.push(`${key}=${escapeValue(value)}`);
  return lines.join('\n') + '\n';
}

/**
 * The Java properties format treats `:` `=` and leading whitespace specially
 * in keys, but values only need newline and backslash handling in practice.
 */
function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function unescapeValue(value: string): string {
  return value
    .trim()
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}
