// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Scratch space, ignored by git as well. A flat config reads no `.gitignore`, so
      // anything left here — a doc site's dependency cache, a throwaway probe — otherwise
      // gets linted as if it were source.
      '**/temp/**',
      // Framework build output. Next and Nuxt both emit committed-looking TypeScript into
      // these, and linting generated code produces nothing anyone can act on.
      '**/.next/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
);
