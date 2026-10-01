import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole monorepo.
 *
 * ESLint resolves config from the file being linted upward, so a single root
 * file covers both workspaces. `tseslint.config(...)` applies the recommended
 * rule set once and each entry below only describes what makes a workspace
 * different -- otherwise the two trees would drift.
 *
 * Type-aware linting is deliberately off. `tsc --noEmit` already runs in
 * `npm run typecheck` for both workspaces, and enabling it here would mean
 * parsing every file twice on every lint.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/uploads/**',
      '**/*.config.{js,ts,mjs,cjs}',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  /* ---- server: Node, ESM, backend ------------------------------------- */
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // The server logs through `utils/logger` so output is structured and
      // scrubbed; `console` is reserved for CLI entrypoints (scripts, seed).
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'no-return-await': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  /* ---- client: browser, React ---------------------------------------- */
  {
    files: ['client/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  /* ---- shared --------------------------------------------------------- */
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Type-only imports read as unused to the base rule.
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `void promise` is the established way this codebase marks a fire-and-
      // forget call, and ESLint cannot tell it apart from a forgotten await.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          /**
           * `typeof import('...')` is allowed. It is the only way to type a
           * module that must not be loaded yet -- `tests/setup.ts` has to set the
           * test database URI before `config/db.js` reads it at module scope.
           */
          disallowTypeAnnotations: false,
        },
      ],
    },
  },

  /* ---- tests ---------------------------------------------------------- */
  {
    files: ['server/src/tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
