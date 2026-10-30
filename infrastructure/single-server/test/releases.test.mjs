import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { it } from './support/it.mjs';

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.test',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();

/** A server with a real git checkout and real release tags; only Docker is fake here. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pertexo-releases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  for (const directory of [bin, state]) mkdirSync(directory);
  writeFileSync(join(root, '.env.production'), 'FIXTURE=true\n', {
    mode: 0o600,
  });
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  const work = join(root, 'work');
  mkdirSync(join(work, 'infrastructure/single-server'), { recursive: true });
  writeFileSync(
    join(work, 'infrastructure/single-server/compose.yaml'),
    'services: {}',
  );
  git(work, 'init', '--quiet', '-b', 'main');
  const commits = {};
  for (const name of ['v0.9.0', 'v0.10.0', 'unreleased']) {
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '--allow-empty', '-m', name);
    commits[name] = git(work, 'rev-parse', 'HEAD');
    if (name !== 'unreleased') git(work, 'tag', name);
  }
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '--quiet', 'origin', 'main', '--tags');
  execFileSync('git', ['clone', '--quiet', origin, join(root, 'repository')]);
  git(join(root, 'repository'), 'tag', '-d', 'v0.9.0', 'v0.10.0');
  const log = join(root, 'commands.jsonl');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env python3
import os, sys, json
args=sys.argv[1:]
with open(os.environ['FIXTURE_LOG'],'a') as log:
 log.write(json.dumps({'args':args})+'\\n')
if args[0]=='version' or args[0]=='info': print('aarch64' if 'Architecture' in ' '.join(args) else 'arm64'); sys.exit(0)
if args[0]=='image':
 template=args[args.index('--format')+1] if '--format' in args else ''
 print(template.replace('{{.Architecture}}','arm64').replace('{{index .Config.Labels "org.opencontainers.image.revision"}}',os.environ.get('SERVICE_VERSION','')))
if 'logs' in args: print('Database already at migration head.')
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'uname'),
    `#!/bin/sh\nif [ "$1" = -m ]; then echo aarch64; exit 0; fi\nexec ${execFileSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).trim()} "$@"\n`,
    { mode: 0o755 },
  );
  if (process.platform !== 'linux') {
    writeFileSync(
      join(bin, 'stat'),
      `#!${process.execPath}\nimport {statSync} from 'node:fs';\nconsole.log((statSync(process.argv.at(-1)).mode & 0o777).toString(8));\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const deploy = (...args) =>
    spawnSync(
      'bash',
      [resolve('infrastructure/single-server/deploy.sh'), ...args],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PERTEXO_BETA_ROOT: root,
          FIXTURE_LOG: log,
        },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
  const current = () =>
    existsSync(join(state, 'current'))
      ? readFileSync(join(state, 'current'), 'utf8').trim()
      : undefined;
  return { commits, deploy, current, log };
}

// ops-09, docs-deps-product-17: a self-hoster has to pick a 40-character SHA and hope.
it('deploy.sh installs a release by its version tag', (t) => {
  const f = fixture(t);
  const result = f.deploy('v0.9.0');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.current(), f.commits['v0.9.0']);
});

// ops-09: version order, so v0.10.0 is newer than v0.9.0, and an untagged tip is no release.
it('deploy.sh latest installs the newest release', (t) => {
  const f = fixture(t);
  const result = f.deploy('latest');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.current(), f.commits['v0.10.0']);
});

test('deploy.sh still takes a full commit', (t) => {
  const f = fixture(t);
  const result = f.deploy(f.commits.unreleased);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.current(), f.commits.unreleased);
});

test('deploy.sh refuses a version that does not exist before touching serving', (t) => {
  const f = fixture(t);
  const result = f.deploy('v9.9.9');
  assert.notEqual(result.status, 0);
  assert.equal(f.current(), undefined);
  const commands = existsSync(f.log) ? readFileSync(f.log, 'utf8') : '';
  assert.doesNotMatch(commands, /"stop"/u);
});

test('deploy.sh refuses anything shaped like a shell command', (t) => {
  const f = fixture(t);
  for (const value of [
    'v1.0.0;touch unwanted',
    '$(touch unwanted)',
    '--upload-pack=x',
  ])
    assert.equal(f.deploy(value).status, 64);
  assert.equal(existsSync(f.log), false);
});

// docs-deps-product-17, ops-09
it('the changelog says what each release changed and how to upgrade to it', () => {
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const releases = changelog.match(
    /^## \[?v\d+\.\d+\.\d+\]?.*\d{4}-\d{2}-\d{2}.*$/gmu,
  );
  assert.ok(releases?.length > 0, 'at least one dated version heading');
  const first = changelog.slice(changelog.indexOf(releases[0]));
  const entry = first.slice(0, first.indexOf('\n## ', 1) + 1 || undefined);
  assert.match(entry, /^### Upgrad/mu);
});

// docs-deps-product-17: "one version until launch" ends with the first outside user.
it('the upgrade page says how to move between releases and what can go wrong', () => {
  const page = readFileSync('docs/operations/upgrading.md', 'utf8');
  assert.match(page, /CHANGELOG\.md/u);
  assert.match(page, /deploy\.sh latest/u);
  assert.match(page, /deploy\.sh v\d+\.\d+\.\d+/u);
  // The rule a stranger needs before their first upgrade.
  assert.match(page, /back ?up/iu);
  assert.match(page, /schema|migration/iu);
  assert.match(page, /roll ?back/iu);
  assert.ok(
    readFileSync('docs/operations/single-server.md', 'utf8').includes(
      'upgrading.md',
    ),
  );
});
