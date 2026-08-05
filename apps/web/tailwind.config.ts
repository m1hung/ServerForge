import type { Config } from 'tailwindcss';

/**
 * Every colour is a CSS custom property, never a literal.
 *
 * That is what makes the light/dark switch a single class on <html> instead
 * of a `dark:` variant on every element, and it is what makes rebranding a
 * change to one `:root` block.
 *
 * The radius scale is compressed into 4–16px. Tailwind's defaults run up to a
 * full pill, which reads as consumer software; a panel wants one consistent,
 * gentle corner everywhere, so `rounded-xl` lands on 10px rather than 12 and
 * nothing in the interface can accidentally become a lozenge.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'hsl(var(--canvas) / <alpha-value>)',
        surface: 'hsl(var(--surface) / <alpha-value>)',
        'surface-raised': 'hsl(var(--surface-raised) / <alpha-value>)',
        line: 'hsl(var(--line) / <alpha-value>)',
        'line-strong': 'hsl(var(--line-strong) / <alpha-value>)',
        ink: 'hsl(var(--ink) / <alpha-value>)',
        'ink-muted': 'hsl(var(--ink-muted) / <alpha-value>)',
        'ink-subtle': 'hsl(var(--ink-subtle) / <alpha-value>)',
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          soft: 'hsl(var(--accent-soft) / <alpha-value>)',
          ink: 'hsl(var(--accent-ink) / <alpha-value>)',
        },
        ok: 'hsl(var(--ok) / <alpha-value>)',
        warn: 'hsl(var(--warn) / <alpha-value>)',
        danger: 'hsl(var(--danger) / <alpha-value>)',
        info: 'hsl(var(--info) / <alpha-value>)',
      },
      borderRadius: {
        none: '0',
        sm: '0.25rem',
        DEFAULT: '0.375rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.625rem',
        '2xl': '0.75rem',
        '3xl': '1rem',
      },
      boxShadow: {
        overlay: 'var(--shadow-overlay)',
      },
      fontFamily: {
        sans: [
          'var(--font-sans)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          'var(--font-mono)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      letterSpacing: {
        terminal: '0.2em',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(2px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { opacity: '0.6', transform: 'scale(0.9)' },
          '70%': { opacity: '0', transform: 'scale(1.6)' },
          '100%': { opacity: '0' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        /* The block cursor in the brand mark and on live indicators. */
        blink: {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0.15' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 1.6s infinite',
        blink: 'blink 1.4s steps(1, end) infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
