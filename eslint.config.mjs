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
        ...globals.es2019,
      },
      ecmaVersion: 2019
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
