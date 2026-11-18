import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import plugin from './plugin.mjs';
import { ALLOWLISTS } from './policy.mjs';
import { repositoryRoot } from './ratchet.mjs';

// Rewrites each rule's allowlist to the counts the code has now. It only
// lowers entries; `--start` writes them from scratch, once, when a rule lands.
const start = process.argv.includes('--start');
const counts = countViolations();
let raised = false;
for (const [rule, allowed] of Object.entries(ALLOWLISTS)) {
  const current = counts.get(rule) ?? new Map();
  const next = {};
  for (const [file, count] of [...current].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const limit = allowed[file] ?? 0;
    if (!start && count > limit) {
      console.error(
        `${rule}: ${file} has ${count}, allowed ${limit}; fix it, do not raise the entry.`,
      );
      raised = true;
      if (limit > 0) next[file] = limit;
    } else next[file] = count;
  }
  writeFileSync(
    path.join(import.meta.dirname, `${rule}.allow.json`),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  const total = (entries) =>
    Object.values(entries).reduce((sum, n) => sum + n, 0);
  console.log(
    `${rule}: ${total(allowed)} → ${total(next)} in ${Object.keys(next).length} files`,
  );
}
process.exitCode = raised ? 1 : 0;

/** Lints with every allowlist empty, so each violation is reported. */
function countViolations() {
  const config = path.join(repositoryRoot, '.test-honesty-count.oxlint.mjs');
  const empty = Object.fromEntries(
    Object.keys(ALLOWLISTS).map((rule) => [rule, {}]),
  );
  writeFileSync(
    config,
    `import { testHonestyOverrides } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'policy.mjs')).href)};
export default {
  categories: { correctness: 'off' },
  plugins: [],
  ignorePatterns: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  jsPlugins: [{ name: 'test-honesty', specifier: ${JSON.stringify(path.join(import.meta.dirname, 'plugin.mjs'))} }],
  overrides: testHonestyOverrides('', ${JSON.stringify(empty)}),
};
`,
  );
  try {
    const result = spawnSync(
      'pnpm',
      ['exec', 'oxlint', '-c', config, '--format', 'json', '.'],
      { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    if (result.error) throw result.error;
    return tally(JSON.parse(result.stdout).diagnostics);
  } finally {
    rmSync(config, { force: true });
  }
}

function tally(diagnostics) {
  const unratcheted = new Set(
    Object.values(plugin.rules).flatMap((rule) =>
      Object.entries(rule.meta.messages)
        .filter(([id]) => ['helper', 'unlisted', 'stale'].includes(id))
        .map(([, text]) => text.split('{{')[0]),
    ),
  );
  const counts = new Map();
  for (const { code, filename, message } of diagnostics) {
    const rule = /^test-honesty\((.+)\)$/u.exec(code ?? '')?.[1];
    if (rule === undefined) throw new Error(`oxlint failed: ${message}`);
    if ([...unratcheted].some((text) => message.startsWith(text))) continue;
    const files = counts.get(rule) ?? new Map();
    files.set(filename, (files.get(filename) ?? 0) + 1);
    counts.set(rule, files);
  }
  return counts;
}
