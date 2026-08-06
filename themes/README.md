# Custom CSS themes

Themes are plain `.css` files. They can do as little as recolour the panel, or
as much as a full visual redesign with custom fonts, layout chrome, and
animation.

## Where files go

| Location | Purpose |
| -------- | ------- |
| `themes/` | Built-in examples shipped with the product |
| `data/themes/` | Your custom themes (created by bootstrap) |

A custom file with the same id as a built-in **replaces** it. Filename → theme
id: `zenless.css` → `zenless`. Allowed characters: letters, numbers, `.`, `_`, `-`.

Pick a theme under **Account → Appearance**. The active id is written to
`data-sf-theme` on `<html>` and the stylesheet is loaded from the API.

## Colour tokens only

Override the design tokens (HSL channels, no `hsl()` wrapper):

```css
/*
 * theme: My Palette
 * description: Optional summary for the picker.
 */

:root,
.dark {
  --canvas: 250 12% 9%;
  --surface: 250 10% 12%;
  --accent: 250 90% 76%;
  /* …see apps/web/src/app/globals.css for the full list */
}

.light {
  /* same tokens, tuned for a light canvas */
}
```

## Full redesigns + motion

For a deeper look, **scope every redesign rule** with the theme attribute so
switching themes unloads cleanly:

```css
/*
 * theme: Neon District
 * description: Cut corners, glow, and a drifting grid.
 */

html[data-sf-theme="neon-district"],
html[data-sf-theme="neon-district"].dark {
  --accent: 48 100% 52%;
  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
}

html[data-sf-theme="neon-district"].light {
  --accent: 45 100% 36%;
}

@keyframes my-theme-pulse {
  from { opacity: 0.6; }
  to { opacity: 1; }
}

html[data-sf-theme="neon-district"] .card {
  border-radius: 0;
  animation: my-theme-pulse 2s ease-in-out infinite alternate;
}
```

You may use `@import` for webfonts, `@keyframes`, pseudo-elements, filters,
`clip-path`, and any selectors that match the panel.

### Stable theme hooks

Prefer these over brittle utility-class selectors:

| Hook | Where |
| ---- | ----- |
| `html[data-sf-theme="…"]` | Active theme id |
| `html.dark` / `html.light` | Light/dark mode |
| `[data-sf-shell]` | App shell root |
| `[data-sf-sidebar]` | Desktop sidebar |
| `[data-sf-nav]` | Sidebar nav |
| `[data-sf-workspace]` | Main column |
| `[data-sf-topbar]` | Top header |
| `[data-sf-main]` | Scrollable content |
| `[data-sf-mobile-nav]` | Phone bottom nav |
| `[data-sf-control="button"]` | Buttons |
| `[data-sf-variant="primary"\|…]` | Button variant |
| `.card` / `.panel` | Cards |
| `.display` / `.engraved` / `.legend` / `.eyebrow` | Type styles |
| `.readout` / `.inset-well` / `.meter` / `.lamp` | Common chrome |

External theme CSS is **unlayered**, so it wins over the panel’s `@layer`
component styles when specificity is equal.

### Accessibility

Always gate continuous motion:

```css
@media (prefers-reduced-motion: reduce) {
  html[data-sf-theme="neon-district"] .card {
    animation: none !important;
  }
}
```

The panel also short-circuits animations globally when the OS requests reduced
motion.

## Examples

**Token palettes** (colour only): `ember`, `forest`, `slate`

**Full redesigns** (fonts, chrome, motion):

| Theme | Vibe |
| ----- | ---- |
| `zenless` | New Eridu web concept — acid lime, pill chrome, ghost lettering |
| `blueprint` | Drafting table — cyan grids, plate titles, crosshairs |
| `phosphor` | Green CRT — scan sweep, flicker, terminal type |
| `arcade` | Coin-op cabinet — pixel titles, marquee, insert-coin |
| `inkseal` | Sumi & vermillion — brush titles, seal stamp |
| `obsidian` | Volcanic glass — molten veins, rising embers |

See also the **Custom CSS themes** section in the root `README.md`.
