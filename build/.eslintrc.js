module.exports = {
  env: {
    node: true,
    browser: false
  },
  parserOptions: {
    ecmaVersion: 6,
    sourceType: 'script'
  },
  extends: ['../.eslintrc.js'],
  rules: {
    'lodash/prefer-lodash-method': 'off'
  }
};
