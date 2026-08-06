import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration for the whole workspace.
 *
 * Deliberately not type-aware. Type-aware linting needs a TypeScript program
 * per file and turns `npm run lint` from seconds into tens of seconds, and
 * `npm run typecheck` already runs the compiler over exactly the same code —
 * the rules that would be gained here are mostly ones tsc already enforces.
 * Lint is for the things the compiler is happy with.
 *
 * `npm run lint` runs with `--max-warnings=0`, so everything below is either
 * an error or off. A warning nobody can merge past is an error with extra
 * steps; a warning that does not fail the build is one nobody ever fixes.
 */
export default tseslint.config(
  {
    // Build output, generated clients and dependencies. Listed first because
    // a global `ignores` block applies to every config that follows.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'packages/db/generated/**',
      'apps/api/dist/**',
      // Runtime data: game servers, backups, caches, operator manifests. Not
      // ours, and a game's own shipped JavaScript would otherwise be linted —
      // which turns `npm run lint` into hundreds of errors from somebody
      // else's code the moment a server is deployed.
      'data/**',
    ],
  },

  // ── TypeScript, everywhere ──────────────────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // TypeScript resolves identifiers itself and does it better — the base
      // rule cannot see type-only imports and reports false positives on them.
      'no-undef': 'off',

      // An unused parameter is often deliberate (an interface being satisfied,
      // a positional argument being skipped). The leading-underscore
      // convention is already used across the adapters for exactly this.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // `catch {}` with no binding is used throughout for "this failing is
      // fine", and is clearer than naming an error you do not read.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── React and Next, in the dashboard ────────────────────────────────────
  //
  // The hooks rules earn their place: `rules-of-hooks` catches genuine
  // crashes, and `exhaustive-deps` catches the stale-closure bugs that make a
  // panel show yesterday's data. Neither is a style opinion.
  //
  // The Next plugin is here because the codebase already carries
  // `@next/next/*` disable comments — without the plugin registered those
  // directives silently refer to nothing, which is worse than not having
  // written them.
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,

      // The dashboard is app-router only. This rule hunts for a `pages/`
      // directory, does not find one, and prints an advisory line on every
      // single run — noise that trains people to ignore lint output.
      '@next/next/no-html-link-for-pages': 'off',

      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // Build-tool configuration. Tailwind's plugin array is `require()` by
  // convention and the file is loaded by Tailwind's own transform, not by us.
  {
    files: ['**/tailwind.config.ts', '**/postcss.config.*'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // ── Plain JavaScript: the launcher and build scripts ─────────────────────
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
