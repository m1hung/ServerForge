/**
 * INI handling, including Unreal Engine's parenthesised tuple values.
 *
 * Palworld stores its entire configuration in one line:
 *
 *   [/Script/Pal.PalGameWorldSettings]
 *   OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,ServerName="My server")
 *
 * Naive `key=value` INI parsers mangle that, and mangling it silently resets
 * a player's world settings — so the tuple gets its own parser here.
 */

export type IniSections = Record<string, Record<string, string>>;

export function parseIni(text: string): IniSections {
  const out: IniSections = {};
  let current = '';
  out[current] = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1);
      out[current] ??= {};
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    out[current] ??= {};
    out[current]![key] = line.slice(eq + 1).trim();
  }

  if (Object.keys(out['']!).length === 0) delete out[''];
  return out;
}

export function stringifyIni(sections: IniSections): string {
  const chunks: string[] = [];
  for (const [name, entries] of Object.entries(sections)) {
    if (name !== '') chunks.push(`[${name}]`);
    for (const [key, value] of Object.entries(entries)) chunks.push(`${key}=${value}`);
    chunks.push('');
  }
  return chunks.join('\n');
}

/**
 * Parses `(A=1,B="two, with comma",C=(D=3))` into a flat map of the outer
 * level. Quoted strings keep their quotes stripped; nested tuples are kept
 * verbatim so we round-trip settings we do not model.
 */
export function parseTuple(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = value.trim().replace(/^\(/, '').replace(/\)$/, '');

  let key = '';
  let buffer = '';
  let depth = 0;
  let inQuotes = false;
  let readingKey = true;

  const flush = () => {
    if (key.trim() !== '') out[key.trim()] = stripQuotes(buffer.trim());
    key = '';
    buffer = '';
    readingKey = true;
  };

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;

    if (inQuotes) {
      if (char === '"' && body[i - 1] !== '\\') inQuotes = false;
      buffer += char;
      continue;
    }

    switch (char) {
      case '"':
        inQuotes = true;
        buffer += char;
        break;
      case '(':
        depth++;
        buffer += char;
        break;
      case ')':
        depth--;
        buffer += char;
        break;
      case '=':
        if (readingKey && depth === 0) readingKey = false;
        else buffer += char;
        break;
      case ',':
        if (depth === 0) flush();
        else buffer += char;
        break;
      default:
        if (readingKey) key += char;
        else buffer += char;
    }
  }
  flush();
  return out;
}

export function stringifyTuple(entries: Record<string, string>): string {
  return `(${Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')})`;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** Unreal expects strings quoted, numbers/bools/enums bare. */
export function quoteUnreal(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Unreal floats are always written with 6 decimal places. */
export function unrealFloat(value: number): string {
  return value.toFixed(6);
}

export function unrealBool(value: boolean): string {
  return value ? 'True' : 'False';
}
