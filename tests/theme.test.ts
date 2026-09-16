import { expect, it } from 'vitest';
import { accentVariables, normalizeAccent } from '../apps/web/src/lib/theme';
import { defaultPreferences, normalizePreferences } from '../apps/web/src/lib/preferences';

it('accepts only six-digit hex accents and preserves legacy display preferences', () => {
  expect(normalizeAccent('#AB12EF')).toBe('#ab12ef');
  for (const value of [
    undefined,
    null,
    '',
    '#fff',
    'red',
    ' #abcdef',
    '#12345678',
    '#zzzzzz',
    {},
    'url(secret)',
  ]) {
    expect(normalizeAccent(value)).toBeNull();
    expect(normalizePreferences({ accentColor: value }).accentColor).toBeNull();
  }
  expect(normalizePreferences({ theme: 'dark', favorites: ['abc'] })).toEqual({
    ...defaultPreferences,
    theme: 'dark',
    favorites: ['abc'],
  });
  expect(normalizePreferences({ accentColor: '#AB12EF' }).accentColor).toBe('#ab12ef');
  expect(accentVariables('not-a-color')).toEqual(accentVariables('#f97316'));
});

// Calculate contrast independently of the resolver, including selected control surfaces.
function rgb(hex: string) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}
function contrast(a: number[], b: number[]) {
  const luminance = (channels: number[]) =>
    channels.reduce((sum, channel, index) => {
      const value = channel / 255;
      return (
        sum +
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index]!
      );
    }, 0);
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}

it('keeps button text, accent text and focus outlines readable for custom and extreme colors', () => {
  // A color cube covers saturated colors, black, white and intermediate luminance thresholds.
  const colors = new Set(['#f97316', '#2563eb', '#16a34a', '#7c3aed', '#db2777', '#64748b']);
  for (const r of ['00', '33', '66', '99', 'cc', 'ff'])
    for (const g of ['00', '33', '66', '99', 'cc', 'ff'])
      for (const b of ['00', '33', '66', '99', 'cc', 'ff']) colors.add(`#${r}${g}${b}`);
  for (const color of colors) {
    const vars = accentVariables(color);
    for (const suffix of ['', '-hover'])
      expect(
        contrast(rgb(vars[`--accent${suffix}`]!), rgb(vars[`--accent${suffix}-text`]!)),
        color,
      ).toBeGreaterThanOrEqual(4.5);
    for (const [mode, surfaces] of [
      ['light', ['#ffffff', '#f8f9fb', '#f0f2f5']],
      ['dark', ['#14171c', '#1d2129', '#292e38', '#181b21', '#35383f']],
    ] as const) {
      for (const surface of surfaces) {
        const ink = rgb(vars[`--accent-ink-${mode}`]!);
        expect(contrast(ink, rgb(surface)), `${color} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      // CSS selected controls tint the raised surface, not the sidebar/overlay surface.
      const selected = rgb(mode === 'dark' ? '#1d2129' : '#ffffff').map(
        (channel, i) => channel * 0.88 + rgb(color)[i]! * 0.12,
      );
      expect(
        contrast(rgb(vars[`--accent-ink-${mode}`]!), selected),
        `${color} selected ${mode}`,
      ).toBeGreaterThanOrEqual(4.5);
      for (const surface of mode === 'dark'
        ? ['#14171c', '#1d2129', '#1c1e24']
        : ['#ffffff', '#f8f9fb'])
        expect(
          contrast(rgb(vars[`--accent-mark-${mode}`]!), rgb(surface)),
          `${color} mark ${surface}`,
        ).toBeGreaterThanOrEqual(3);
    }
  }
});

it('keeps readable accent colors vivid instead of forcing every mark to a pale text tint', () => {
  for (const color of ['#f97316', '#2563eb', '#16a34a', '#db2777', '#64748b'])
    expect(accentVariables(color)['--accent-mark-dark']).toBe(color);
  expect(accentVariables('#7c3aed')['--accent-mark-dark']).toBe('#8142ee');
  for (const color of ['#2563eb', '#7c3aed', '#db2777', '#64748b'])
    expect(accentVariables(color)['--accent-mark-light']).toBe(color);
});
