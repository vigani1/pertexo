import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const base = process.argv[2] ?? 'origin/main';
const changed = [
  ...run('git', ['diff', '--name-only', '-z', base], true).split('\0'),
  ...run(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    true,
  ).split('\0'),
];
// Shared policy and dependency changes can affect otherwise untouched workspaces.
const all = changed.some(
  (path) =>
    /(?:^|\/)(?:eslint\.config\.[^/]+|oxlint\.config\.[^/]+|\.oxlintrc[^/]*|\.oxlint-type-aware\.json|package\.json|tsconfig[^/]*\.json)$/u.test(
      path,
    ) ||
    [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.pnpmfile.mjs',
      '.github/workflows/ci.yml',
      '.githooks/pre-push',
      'infrastructure/checks/browser-entry-dependencies.mjs',
    ].includes(path) ||
    /^infrastructure\/checks\/(?:lint|oxlint|tsgolint)[^/]*\.mjs$/u.test(path),
);
const selection = all ? ['--recursive'] : ['--filter', `...[${base}]`];
const workspaces = JSON.parse(
  run(
    'pnpm',
    [...selection, '--filter', '!pertexo', 'list', '--depth', '-1', '--json'],
    true,
  ),
);
console.log(
  `Linting ${all ? 'all' : 'affected'} workspaces: ${workspaces.map(({ name }) => name).join(', ') || 'none'}`,
);
const targets = all
  ? ['--ignore-pattern', 'apps/web', '.']
  : [
      'infrastructure',
      ...readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && /\.(?:mjs|cjs|ts|mts|cts)$/u.test(entry.name),
        )
        .map((entry) => entry.name),
      ...workspaces
        .filter(({ name }) => name !== '@pertexo/web')
        .map(({ path }) => relative(root, path)),
    ];
run(process.execPath, ['infrastructure/checks/lint.mjs', ...targets]);
if (workspaces.some(({ name }) => name === '@pertexo/web'))
  run(
    process.execPath,
    ['../../infrastructure/checks/lint.mjs', '.'],
    false,
    resolve(root, 'apps/web'),
  );
run('pnpm', ['lint:infrastructure']);
if (workspaces.length > 0)
  run('pnpm', [
    ...selection,
    '--filter',
    '!pertexo',
    '--workspace-concurrency=1',
    'exec',
    'eslint',
    '--cache',
    '--cache-strategy',
    'content',
    '.',
  ]);

function run(command, args, capture = false, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}
