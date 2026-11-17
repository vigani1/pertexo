// These rules have whole-repository parity through native rules or the
// unchanged ESLint plugins. Keep policy values in the owning lint config.
const movedRules = new Map([
  ['no-undef', 'eslint/no-undef'],
  ['no-restricted-imports', 'legacy/no-restricted-imports'],
  ['max-lines', 'eslint/max-lines'],
  [
    '@typescript-eslint/switch-exhaustiveness-check',
    'typescript/switch-exhaustiveness-check',
  ],
  [
    '@typescript-eslint/consistent-indexed-object-style',
    'legacy/consistent-indexed-object-style',
  ],
  ['max-params', 'legacy/max-params'],
  ['no-unsafe-optional-chaining', 'legacy/no-unsafe-optional-chaining'],
  ['max-lines-per-function', 'eslint/max-lines-per-function'],
  ['no-dupe-args', 'legacy/no-dupe-args'],
  ['no-octal', 'legacy/no-octal'],
  ['no-restricted-syntax', 'legacy/no-restricted-syntax'],
  ['vitest/expect-expect', 'vitest-js/expect-expect'],
  ...[
    'preserve-manual-memoization',
    'immutability',
    'refs',
    'purity',
    'config',
    'gating',
  ].map((name) => [`react-hooks/${name}`, `react-hooks-js/${name}`]),
]);

export function remainingEslintPolicy(policy) {
  return policy.map((entry) => ({
    ...entry,
    ...(entry.rules
      ? {
          rules: Object.fromEntries(
            Object.entries(entry.rules).filter(
              ([name]) => !movedRules.has(name),
            ),
          ),
        }
      : {}),
  }));
}

export function oxlintPolicy(policy) {
  return policy.flatMap((entry) => {
    const rules = Object.fromEntries(
      Object.entries(entry.rules ?? {})
        .filter(([name]) => movedRules.has(name))
        .map(([name, value]) => [movedRules.get(name), value]),
    );
    if (Object.keys(rules).length === 0 && !entry.languageOptions?.globals)
      return [];
    return [
      {
        files: entry.files ?? ['**/*'],
        ...(entry.ignores ? { excludeFiles: entry.ignores } : {}),
        ...(entry.languageOptions?.globals
          ? { globals: entry.languageOptions.globals }
          : {}),
        rules,
      },
    ];
  });
}
