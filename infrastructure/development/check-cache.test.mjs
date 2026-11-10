import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const bin = resolve('node_modules/.bin');
const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'pertexo-j2-checks-4300-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function command(root, name, args) {
  return spawnSync(name, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 30000,
  });
}
function output(result) {
  return result.stdout + result.stderr;
}

test('changed formatting config rechecks untouched files and narrow changes still fail', () =>
  fixture((root) => {
    mkdirSync(join(root, 'infrastructure/development'), { recursive: true });
    copyFileSync(
      new URL('./format-changed.mjs', import.meta.url),
      join(root, 'infrastructure/development/format-changed.mjs'),
    );
    writeFileSync(join(root, '.prettierrc.json'), '{"semi":true}\n');
    writeFileSync(join(root, 'untouched.js'), 'export const untouched = 1;\n');
    writeFileSync(join(root, 'changed.js'), 'export const changed = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: root },
    );
    const check = () =>
      command(root, process.execPath, [
        'infrastructure/development/format-changed.mjs',
        'HEAD',
      ]);
    assert.equal(check().status, 0);
    writeFileSync(join(root, 'changed.js'), 'export const changed=    2;\n');
    const narrow = check();
    assert.notEqual(narrow.status, 0);
    assert.match(output(narrow), /changed\.js/u);
    writeFileSync(join(root, 'changed.js'), 'export const changed = 1;\n');
    writeFileSync(join(root, '.prettierrc.json'), '{"semi":false}\n');
    const configured = check();
    assert.notEqual(
      configured.status,
      0,
      'a new configuration applies to untouched code',
    );
    assert.match(output(configured), /untouched\.js/u);
  }));

test('the cached typecheck rejects config changes and source changes with existing build state', () =>
  fixture((root) => {
    const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts
      .typecheck;
    mkdirSync(join(root, 'packages/probe'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ private: true, scripts: { typecheck: script } }),
    );
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages: ['packages/*']\n",
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: 'packages/probe' }] }),
    );
    const folder = join(root, 'packages/probe');
    const config = {
      compilerOptions: {
        composite: true,
        strict: true,
        types: [],
        outDir: 'dist',
        noUnusedLocals: false,
      },
      include: ['source.ts'],
    };
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ name: 'probe', private: true }),
    );
    writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify(config));
    writeFileSync(
      join(folder, 'source.ts'),
      'const unused = 1; export const value: number = 1;\n',
    );
    const check = () => command(root, 'pnpm', ['typecheck']);
    const initial = check();
    assert.equal(initial.status, 0, output(initial));
    config.compilerOptions.noUnusedLocals = true;
    writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify(config));
    const configured = check();
    assert.notEqual(configured.status, 0);
    assert.match(output(configured), /TS6133/u);
    config.compilerOptions.noUnusedLocals = false;
    writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify(config));
    assert.equal(check().status, 0);
    // Reuse the successful cache after changing the source, as on a branch switch.
    writeFileSync(
      join(folder, 'source.ts'),
      'export const value: number = "invalid";\n',
    );
    const stale = check();
    assert.notEqual(
      stale.status,
      0,
      'previous successful build state cannot hide an error',
    );
    assert.match(output(stale), /TS2322/u);
  }));
