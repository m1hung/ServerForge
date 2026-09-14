import { expect, it } from 'vitest';
import { redactDiagnostic } from '@serverforge/core';
it('redacts credential fields, connection URLs, query tokens, bearer values and configured secrets', () => {
  const value = redactDiagnostic({ nested: { password: 'password', tokenHash: 'hash', detail: 'postgresql://user:pass@db/main https://user:pass@host/file?token=private&ok=1 Bearer private-key host-secret-value' }, normal: ['port 3000', 2] }, ['host-secret-value']);
  const text = JSON.stringify(value);
  for (const secret of ['private', 'host-secret-value', 'user:pass', '"hash"']) expect(text).not.toContain(secret);
  expect(value).toMatchObject({ normal: ['port 3000', 2] });
});
