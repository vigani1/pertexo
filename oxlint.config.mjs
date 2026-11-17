import base from './.oxlintrc.json' with { type: 'json' };
import typed from './.oxlint-type-aware.json' with { type: 'json' };
import { lintPolicy } from './eslint.config.mjs';
import { oxlintPolicy } from './infrastructure/checks/lint-rule-ownership.mjs';

const config = {
  extends: [{ ...base, extends: [typed] }],
  options: base.options,
  jsPlugins: [
    {
      name: 'legacy',
      specifier: './infrastructure/checks/oxlint-legacy-rules.mjs',
    },
    { name: 'vitest-js', specifier: '@vitest/eslint-plugin' },
  ],
  overrides: oxlintPolicy(lintPolicy),
};

export default config;
