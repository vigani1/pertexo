import tseslint from 'typescript-eslint';
import { builtinRules } from 'eslint/use-at-your-own-risk';

// Oxlint has no native versions of these checks; use the original rule code.
const config = {
  rules: {
    ...Object.fromEntries(
      [
        'no-dupe-args',
        'no-octal',
        'no-restricted-syntax',
        'no-restricted-imports',
        'max-params',
        'no-unsafe-optional-chaining',
      ].map((name) => [name, builtinRules.get(name)]),
    ),
    'consistent-indexed-object-style':
      tseslint.plugin.rules['consistent-indexed-object-style'],
  },
};

export default config;
