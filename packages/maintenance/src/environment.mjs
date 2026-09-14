export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) value = value.slice(1, -1);
    result[match[1]] = value.replaceAll('$$', '$');
  }
  return result;
}
