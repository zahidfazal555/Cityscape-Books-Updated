// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'docs/handoff/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.next/**',
      '**/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      complexity: ['error', 10],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Business rules may not touch infrastructure.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['pg', 'next', 'next/*', 'react', '@csd/db', 'node:fs', 'node:http'] },
      ],
    },
  },
  {
    // UI components: each JSX conditional counts as a branch. Business rules stay at 10 (they
    // live in packages/core and packages/services, never in components).
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      complexity: ['error', 20],
      'max-lines-per-function': ['warn', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: { 'max-lines-per-function': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
