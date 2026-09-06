import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);

test('documentation fixtures cannot mutate the repository inherited from a Git hook', async () => {
  const protectedRoot = await mkdtemp(
    path.join(tmpdir(), 'pertexo-git-isolation-'),
  );
  // The control repository must never inherit the real caller's Git identity.
  const controlEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GIT_') && name !== 'NODE_TEST_CONTEXT',
    ),
  );
  const git = (...args) =>
    execute('git', ['-C', protectedRoot, ...args], {
      env: controlEnvironment,
    });
  try {
    await git('init', '--quiet');
    await git('config', 'user.name', 'Protected Test Repository');
    await git('config', 'user.email', 'protected@example.test');
    await writeFile(
      path.join(protectedRoot, 'sentinel.txt'),
      'must remain unchanged\n',
    );
    await git('add', 'sentinel.txt');
    await git('commit', '--quiet', '-m', 'protected baseline');
    const { stdout: headBefore } = await git('rev-parse', 'HEAD');
    const configBefore = await readFile(
      path.join(protectedRoot, '.git/config'),
      'utf8',
    );
    const result = await execute(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        path.join(import.meta.dirname, 'validate-documentation.test.mjs'),
      ],
      {
        timeout: 30_000,
        env: {
          ...controlEnvironment,
          GIT_DIR: path.join(protectedRoot, '.git'),
          GIT_COMMON_DIR: path.join(protectedRoot, '.git'),
          GIT_WORK_TREE: protectedRoot,
          GIT_INDEX_FILE: path.join(protectedRoot, '.git/index'),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'user.name',
          GIT_CONFIG_VALUE_0: 'Inherited Hook Identity',
        },
      },
    ).then(
      ({ stdout }) => ({ passed: true, stdout }),
      (error) => ({ passed: false, detail: error.stderr || error.stdout }),
    );
    assert.equal(result.passed, true, result.detail);
    assert.match(result.stdout, /# tests [1-9]\d*/u);
    assert.equal((await git('rev-parse', 'HEAD')).stdout, headBefore);
    assert.equal(
      await readFile(path.join(protectedRoot, '.git/config'), 'utf8'),
      configBefore,
    );
    assert.equal((await git('status', '--porcelain')).stdout, '');
  } finally {
    await rm(protectedRoot, { recursive: true, force: true });
  }
});
