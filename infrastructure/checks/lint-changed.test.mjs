import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

for (const changed of [
  'packages/source/src/value.ts',
  'eslint.config.mjs',
  'infrastructure/checks/browser-entry-dependencies.mjs',
]) {
  const shared = changed !== 'packages/source/src/value.ts';
  test(
    shared
      ? `${changed} changes check every workspace`
      : 'source changes check the selected workspace and its dependents',
    (t) => {
      const fixture = createFixture(t);
      writeFileSync(join(fixture.root, changed), '// changed\n');
      const result = fixture.run();
      assert.equal(result.status, 0, result.stderr);
      const calls = fixture.calls();
      const listing = calls.find(({ args }) => args.includes('list'));
      assert.ok(
        shared
          ? listing.args.includes('--recursive')
          : listing.args.includes(`...[${fixture.base}]`),
      );
      const native = calls.filter(({ tool }) => tool === 'oxlint');
      assert.equal(native.length, shared ? 2 : 1);
      assert.ok(native[0].args.includes(shared ? '.' : 'packages/source'));
      if (!shared) {
        assert.ok(native[0].args.includes('packages/consumer'));
        assert.ok(!native[0].args.includes('apps/web'));
        assert.ok(!native[0].args.includes('packages/unrelated'));
      }
      const eslint = calls.find(({ args }) => args.includes('eslint'));
      assert.deepEqual(eslint.args.slice(-5), [
        'eslint',
        '--cache',
        '--cache-strategy',
        'content',
        '.',
      ]);
      assert.ok(
        shared
          ? eslint.args.includes('--recursive')
          : eslint.args.includes(`...[${fixture.base}]`),
      );
    },
  );
}

test('a failing scoped lint stops the hook with its exit code', (t) => {
  const fixture = createFixture(t, 17);
  writeFileSync(
    join(fixture.root, 'packages/source/src/value.ts'),
    '// changed\n',
  );
  assert.equal(fixture.run().status, 17);
  assert.ok(!fixture.calls().some(({ args }) => args.includes('eslint')));
});

function createFixture(t, lintExit = 0) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'pertexo-lint-changed-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of [
    'bin',
    'infrastructure/checks',
    'apps/web',
    'packages/source/src',
    'packages/consumer',
    'packages/unrelated',
  ])
    mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'eslint.config.mjs'), '// policy\n');
  writeFileSync(
    join(root, 'packages/source/src/value.ts'),
    'export const value=1;\n',
  );
  copyFileSync(
    new URL('./lint-changed.mjs', import.meta.url),
    join(root, 'infrastructure/checks/lint-changed.mjs'),
  );
  const records = join(root, 'calls.jsonl');
  const append = `import {appendFileSync} from 'node:fs'; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(records)},JSON.stringify({tool:TOOL,args,cwd:process.cwd()})+'\\n');`;
  writeFileSync(
    join(root, 'infrastructure/checks/lint.mjs'),
    append.replace('TOOL', "'oxlint'") + `process.exit(${lintExit});\n`,
  );
  const workspaces = (names) =>
    names.map((name) => ({
      name:
        name === 'apps/web' ? '@pertexo/web' : `@pertexo/${name.split('/')[1]}`,
      path: join(root, name),
    }));
  const pnpm = join(root, 'bin/pnpm');
  writeFileSync(
    pnpm,
    `#!${process.execPath}\n` +
      append.replace('TOOL', "'pnpm'") +
      `if(args.includes('list')) console.log(JSON.stringify(args.includes('--recursive')?${JSON.stringify(workspaces(['packages/source', 'packages/consumer', 'packages/unrelated', 'apps/web']))}:${JSON.stringify(workspaces(['packages/source', 'packages/consumer']))}));\n`,
  );
  chmodSync(pnpm, 0o755);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['add', '.']);
  const base = git(['write-tree']);
  return {
    root,
    base,
    run: () =>
      spawnSync(
        process.execPath,
        ['infrastructure/checks/lint-changed.mjs', base],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: join(root, 'bin') + delimiter + process.env.PATH,
          },
        },
      ),
    calls: () =>
      readFileSync(records, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}
