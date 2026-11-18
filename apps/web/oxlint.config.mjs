import web from './.oxlintrc.json' with { type: 'json' };
import base from '../../.oxlintrc.json' with { type: 'json' };
import typed from '../../.oxlint-type-aware.json' with { type: 'json' };
import { lintPolicy } from './eslint.config.mjs';
import { oxlintPolicy } from '../../infrastructure/checks/lint-rule-ownership.mjs';
import { testHonestyOverrides } from '../../infrastructure/checks/test-honesty/policy.mjs';

const config = {
  extends: [{ ...web, extends: [{ ...base, extends: [typed] }] }],
  options: base.options,
  jsPlugins: [
    {
      name: 'legacy',
      specifier: '../../infrastructure/checks/oxlint-legacy-rules.mjs',
    },
    { name: 'vitest-js', specifier: '@vitest/eslint-plugin' },
    {
      name: 'test-honesty',
      specifier: '../../infrastructure/checks/test-honesty/plugin.mjs',
    },
    { name: 'react-hooks-js', specifier: 'eslint-plugin-react-hooks' },
  ],
  overrides: [...oxlintPolicy(lintPolicy), ...testHonestyOverrides('apps/web')],
};

export default config;
