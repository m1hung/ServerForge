/** Diagnostic text must not become an alternative credential store. */
export function redactText(text: string, secrets: string[] = []): string {
  let result = text
    .replace(/\b(?:postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi, '[connection URL redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[credentials]@')
    .replace(/([?&](?:token|key|api_key|apikey|auth|password|secret|signature)=)[^\s&#"']*/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  for (const secret of secrets) if (secret.length >= 8) result = result.replaceAll(secret, '[redacted]');
  return result;
}
export function redactDiagnostic(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnostic(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /password|secret|token|authorization|cookie|recovery.?code|private.?key/i.test(key) ? '[redacted]' : redactDiagnostic(entry, secrets)]));
  return value;
}
