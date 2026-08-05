# Custom CSS themes

Drop a `.css` file in this directory (`data/themes/`) to make it available in
**Account → Appearance**. Built-in examples also ship in the repo `themes/`
folder.

A theme should redefine the design tokens used by the panel. Start from one of
the examples and keep both dark (`:root, .dark`) and light (`.light`) blocks so
the sun/moon toggle still works.

```css
/*
 * theme: My Theme
 * description: Optional one-line summary shown in the picker.
 */

:root,
.dark {
  --canvas: 250 12% 9%;
  --surface: 250 10% 12%;
  --surface-raised: 250 9% 16%;
  --line: 250 8% 21%;
  --line-strong: 250 7% 35%;
  --ink: 250 20% 96%;
  --ink-muted: 250 9% 75%;
  --ink-subtle: 250 7% 61%;
  --accent: 250 90% 76%;
  --accent-soft: 250 45% 20%;
  --accent-ink: 250 40% 12%;
  --ok: 155 55% 58%;
  --warn: 40 92% 65%;
  --danger: 350 80% 70%;
  --info: 205 90% 70%;
  --focus: 250 90% 76%;
}

.light {
  /* same tokens, tuned for a light canvas */
}
```

Values are HSL channels without the `hsl()` wrapper (e.g. `250 90% 76%`),
matching `apps/web/src/app/globals.css`.

Filename rules: letters, numbers, `.`, `_`, `-` only — e.g. `ember.css`.
A custom file with the same name as a built-in theme replaces it.
