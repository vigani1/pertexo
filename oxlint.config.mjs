import base from './.oxlintrc.json' with { type: 'json' };
import typed from './.oxlint-type-aware.json' with { type: 'json' };
import { lintPolicy } from './eslint.config.mjs';
import { oxlintPolicy } from './infrastructure/checks/lint-rule-ownership.mjs';
import { testHonestyOverrides } from './infrastructure/checks/test-honesty/policy.mjs';

const config = {
  extends: [{ ...base, extends: [typed] }],
  options: base.options,
  jsPlugins: [
    {
      name: 'legacy',
      specifier: './infrastructure/checks/oxlint-legacy-rules.mjs',
    },
    { name: 'vitest-js', specifier: '@vitest/eslint-plugin' },
    {
      name: 'test-honesty',
      specifier: './infrastructure/checks/test-honesty/plugin.mjs',
    },
  ],
  overrides: [...oxlintPolicy(lintPolicy), ...testHonestyOverrides('')],
};

export default config;
