import globals from 'globals';
import reviewableConfigBaseline from 'reviewable-configs/eslint-config/baseline.js';
import reviewableConfigLodash from 'reviewable-configs/eslint-config/lodash.js';

export default [
  ...reviewableConfigBaseline,
  ...reviewableConfigLodash,
  {
    files: ['src/**'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2015,
      },
      ecmaVersion: 2015
    },
    rules: {
      // Tweak rules for compatibility with ES2015, removed when updating ES version.
      'prefer-arrow-callback': 'off',
      'import/no-unresolved': ['error', {ignore: ['^ava$']}],
      'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}]
    }
  },
  {
    files: ['src/**/*.test.js'],
    rules: {
      'import/no-unresolved': ['error', {ignore: ['^ava$']}]
    }
  },
  {
    files: ['Gruntfile.js'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  }
];
