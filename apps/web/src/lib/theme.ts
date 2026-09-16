export function normalizeAccent(value: unknown): string | null {
  return typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value) ? value.toLowerCase() : null;
}

// Self-contained so the same resolver can run before hydration and after a change.
// Keep helpers inside this function: its source is embedded in the initial script.
export function accentVariables(input: string): Record<string, string> {
  const accent = /^#[a-f0-9]{6}$/i.test(input) ? input.toLowerCase() : '#f97316';
  const rgb = [1, 3, 5].map((offset) => parseInt(accent.slice(offset, offset + 2), 16));
  const mix = (target: number, amount: number) =>
    '#' +
    rgb
      .map((channel) =>
        Math.round(channel * (1 - amount) + target * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  function luminance(color: string | number[]) {
    const channels = (
      typeof color === 'string'
        ? [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
        : color
    )
      .map((channel) => channel / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  }
  function foreground(color: string) {
    return luminance(color) > 0.179 ? '#000000' : '#ffffff';
  }
  function readable(dark: boolean, ratio: number) {
    // Use the actual surface and selected tint, not a fixed luminance target that
    // bleaches every dark-mode accent. Small text needs 4.5:1; logo/title marks
    // need 3:1 on their own neutral backgrounds, never on selected control fills.
    const surface = dark ? (ratio === 3 ? [29, 33, 41] : [53, 56, 63]) : [240, 242, 245];
    const raised = dark ? [29, 33, 41] : [255, 255, 255];
    const backgrounds =
      ratio === 3
        ? [surface]
        : [surface, raised.map((channel, i) => channel * 0.88 + rgb[i]! * 0.12)];
    const levels = backgrounds.map(luminance);
    for (let step = 0; step <= 100; step++) {
      const color = mix(dark ? 255 : 0, step / 100);
      const level = luminance(color);
      if (
        levels.every((background) =>
          dark
            ? (level + 0.05) / (background + 0.05) >= ratio
            : (background + 0.05) / (level + 0.05) >= ratio,
        )
      )
        return color;
    }
    return dark ? '#ffffff' : '#000000';
  }
  const hover = mix(0, 0.1);
  return {
    '--accent': accent,
    '--accent-text': foreground(accent),
    '--accent-hover': hover,
    '--accent-hover-text': foreground(hover),
    '--accent-ink-light': readable(false, 4.5),
    '--accent-ink-dark': readable(true, 4.5),
    '--accent-mark-light': readable(false, 3),
    '--accent-mark-dark': readable(true, 3),
  };
}
