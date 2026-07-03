Update .eslintrc.js — replace the JavaScript ESLint config with this TypeScript config:

module.exports = {
  env: { node: true, es2021: true, jest: true },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', project: './tsconfig.json' },
  plugins: ['@typescript-eslint'],
  rules: {
    'no-console': 'warn',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};

Delete the 7 original .js source files (the .ts replacements now exist): src/index.js, src/utils/constants.js, src/utils/logger.js, src/services/database.js, src/services/threatService.js, src/components/strideAnalyzer.js, src/components/threatRouter.js. (config/webpack.config.js and .eslintrc.js stay as .js.)
