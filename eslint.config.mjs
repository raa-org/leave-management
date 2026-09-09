/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

/**
 * Minimal-noise ESLint config focused on bug-class rules, not formatting.
 *
 * Rationale: in the orchestrator critic loop we deliberately do NOT run
 * ESLint as a verdict gate (TypeScript + tests + LLM review cover the
 * useful ground). This config exists so `npm run lint` works for human
 * inspection. React-specific bug rules apply only inside apps/web.
 *
 * `parserOptions.project` lists every tsconfig in the monorepo so type-
 * aware rules (no-floating-promises, no-misused-promises) work across
 * apps and libs without per-project config duplication.
 */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.nx/**',
      'tmp/**',
      'apps/*/dist/**',
      'libs/**/dist/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        project: [
          './apps/api/tsconfig.json',
          './apps/web/tsconfig.json',
          './libs/shared/contracts/tsconfig.json',
        ],
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      eqeqeq: ['error', 'always'],
      'no-throw-literal': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  prettier,
]
