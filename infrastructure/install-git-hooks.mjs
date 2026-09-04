import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repository = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
});

if (repository.status !== 0) {
  process.stdout.write(
    'Skipping Git hook installation outside a Git worktree.\n',
  );
  process.exit(0);
}

const repositoryRoot = repository.stdout.trim();
const hookPath = resolve(repositoryRoot, '.githooks', 'pre-push');

if (process.platform !== 'win32') {
  chmodSync(hookPath, 0o755);
}

const configured = spawnSync(
  'git',
  ['config', '--local', 'core.hooksPath', '.githooks'],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

if (configured.status !== 0) {
  throw new Error('Unable to configure the repository Git hooks path');
}

process.stdout.write('Configured repository Git hooks from .githooks/.\n');
