import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.argv[2] ?? 'origin/main';
const changed = execFileSync('git', ['diff', '--name-only', '-z', base], {
  cwd: root,
  encoding: 'utf8',
});
const untracked = execFileSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', '-z'],
  {
    cwd: root,
    encoding: 'utf8',
  },
);
const files = [...new Set((changed + untracked).split('\0').filter(Boolean))];
// Configuration and tool updates can change formatting in otherwise untouched files.
const wholeTree = files.some(
  (file) =>
    /(?:^|\/)(?:package\.json|\.prettier[^/]*|prettier\.config\.[^/]+|\.editorconfig)$/u.test(
      file,
    ) || ['pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file),
);
const targets = wholeTree
  ? ['.']
  : files.filter((file) => existsSync(join(root, file)));
if (targets.length > 0) {
  const result = spawnSync(
    'prettier',
    ['--check', '--ignore-unknown', ...targets],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
