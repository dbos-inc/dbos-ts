// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['**/*.ts'],
  extends: [
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
  ],
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
    }
  },
  rules: {
    // "@typescript-eslint/indent": "off",
    // "@typescript-eslint/unbound-method": [
    //   "error",
    //   {
    //     ignoreStatic: true,
    //   },
    // ],
    "@typescript-eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_" }
    ],
    // "@typescript-eslint/no-misused-promises": [
    //   "error",
    //   {
    //     "checksVoidReturn": false
    //   }
    // ]
  },
},
{
  files: ['**/*.js'],
  extends: [tseslint.configs.disableTypeChecked],
  rules: {
    // turn off other type-aware rules
    'deprecation/deprecation': 'off',
    '@typescript-eslint/internal/no-poorly-typed-ts-props': 'off',

    // turn off rules that don't apply to JS code
    '@typescript-eslint/explicit-function-return-type': 'off',
  },
});

// eslint.configs.recommended,
// ...tseslint.configs.recommended,
// ...tseslint.configs.recommendedTypeChecked,
