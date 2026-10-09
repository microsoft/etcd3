/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const typescript = require('@typescript-eslint/eslint-plugin');
const headers = require('eslint-plugin-headers');

module.exports = [
  { ignores: ['**/*.d.ts', '**/test/*.*', '**/*.js'] },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  ...typescript.configs['flat/recommended'],
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2018,
        sourceType: 'module',
      },
    },
    plugins: { headers },
    rules: {
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'headers/header-format': [
        'error',
        {
          source: 'string',
          style: 'jsdoc',
          content: 'Copyright (C) Microsoft Corporation. All rights reserved.',
          blockPrefix: '---------------------------------------------------------\n',
          blockSuffix: '\n *--------------------------------------------------------',
          linePrefix: ' * ',
        },
      ],
    },
  },
];
