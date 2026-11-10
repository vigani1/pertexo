import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { databaseRuntimeProbe } from './database-runtime.fixture.mjs';

const runtime = 'pertexo-j2-tests:4300-runtime';
const web = 'pertexo-j2-tests:4300-web';
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

test('both shipped images contain dependency notices and exclude rclone', () => {
  const notices = [
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'cat',
      runtime,
      '/workspace/THIRD_PARTY_NOTICES.txt',
    ]),
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'cat',
      web,
      '/usr/share/nginx/html/THIRD_PARTY_NOTICES.txt',
    ]),
  ];
  assert.equal(
    notices[0],
    notices[1],
    'both images distribute the full notices',
  );
  const inventory = JSON.parse(
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'node',
      runtime,
      '-e',
      `
const fs=require('node:fs'),path=require('node:path');
const base='/workspace/node_modules/.pnpm';const result=[];
for(const dir of fs.readdirSync(base)) {
const nm=path.join(base,dir,'node_modules');if(!fs.existsSync(nm))continue;
for(const name of fs.readdirSync(nm)) {
if(name.startsWith('.'))continue;
const entries=name.startsWith('@')?fs.readdirSync(path.join(nm,name)).map(n=>name+'/'+n):[name];
for(const entry of entries){const file=path.join(nm,entry,'package.json');if(fs.existsSync(file)){const p=JSON.parse(fs.readFileSync(file));if(!p.name.startsWith('@pertexo/'))result.push([p.name,p.version]);}}
}}
console.log(JSON.stringify(result));`,
    ]),
  );
  assert.ok(inventory.length > 100, 'inspect actual production dependencies');
  const lines = notices[0].split('\n');
  for (const [name, version] of inventory) {
    assert.ok(
      lines.some(
        (line) =>
          line.startsWith(`${name} `) &&
          line
            .slice(name.length + 1)
            .split(', ')
            .includes(version),
      ),
      `${name}@${version} is credited`,
    );
  }
  assert.ok(
    notices[0].includes(
      'CPython and bundled standard-library components 3.15.1',
    ),
    'the copied CPython inventory is credited',
  );
  assert.ok(
    notices[0].includes('PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2'),
    'the Python license text is distributed',
  );
  assert.doesNotMatch(notices[0], /(?:^|\n)rclone(?: |\n)/iu);
  assert.ok(
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'cat',
      runtime,
      '/usr/local/LICENSE',
    ]).includes('Copyright'),
    'the Node base retains its license',
  );
  assert.ok(
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'cat',
      web,
      '/usr/share/licenses/nginx/COPYRIGHT',
    ]).includes('Copyright'),
    'the nginx base retains its license',
  );
  for (const image of [runtime, web]) {
    assert.equal(
      docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'sh',
        image,
        '-c',
        "find / -iname rclone -o -iname 'rclone.*' 2>/dev/null || true",
      ]),
      '',
      'rclone is absent from the shipped filesystem',
    );
  }
});

test(
  'runtime database identity and real write errors retain caller outcomes',
  { timeout: 60000 },
  async () => {
    const network = `pertexo-j2-4300-${randomUUID()}`;
    let database;
    docker(['network', 'create', network]);
    try {
      database = docker([
        'run',
        '-d',
        '--rm',
        '--network',
        network,
        '--network-alias',
        'database',
        '-e',
        'POSTGRES_PASSWORD=fixture',
        'postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280',
      ]);
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          docker(['exec', database, 'pg_isready', '-U', 'postgres']);
          break;
        } catch {
          assert.ok(Date.now() < deadline, 'isolated database starts');
          await delay(200);
        }
      }
      const output = docker([
        'run',
        '--rm',
        '--network',
        network,
        '-v',
        `${databaseRuntimeProbe}:/probe.mjs:ro`,
        '--entrypoint',
        'node',
        runtime,
        '--experimental-import-meta-resolve',
        '/probe.mjs',
        '@pertexo/database/platform',
        '@pertexo/database/primitives',
        'drizzle-orm',
      ]);
      assert.match(output, /real 23505\/40001\/55P03/u);
    } finally {
      if (database) docker(['rm', '-f', database]);
      docker(['network', 'rm', network]);
    }
  },
);
