import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { verifyReleaseEvidence } from '../delivery/verify-ci.mjs';

const commit = 'a'.repeat(40);
const run = {
  head_sha: commit,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};
// The job that makes the final image tags, whatever CI calls it, so renaming it in
// ci.yml without updating the verifier fails here rather than on the first deploy.
const publisher = () => {
  const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const publishing = Object.entries(jobs).filter(
    ([, definition]) => definition.permissions?.packages === 'write',
  );
  const [name, definition] = publishing.find(
    ([candidate]) =>
      !publishing.some(([, other]) =>
        [other.needs ?? []].flat().includes(candidate),
      ),
  );
  return definition.name ?? name;
};
const job = {
  name: publisher(),
  head_sha: commit,
  status: 'completed',
  conclusion: 'success',
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pertexo-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  return { root, bin };
}
test('deployment requires matching successful main push CI and native ARM publication', () => {
  verifyReleaseEvidence(commit, run, [job]);
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { event: 'schedule' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ])
    assert.throws(() =>
      verifyReleaseEvidence(commit, { ...run, ...change }, [job]),
    );
  for (const jobs of [
    [],
    [{ ...job, conclusion: 'skipped' }],
    [{ ...job, head_sha: 'b'.repeat(40) }],
  ])
    assert.throws(() => verifyReleaseEvidence(commit, run, jobs));
});
test('CI verifier rejects missing evidence, wrong ancestry and unsafe SHA before SSH', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.bin, 'git'),
    '#!/bin/sh\nexit "${FIXTURE_GIT_STATUS:-0}"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(f.bin, 'gh'),
    `#!/usr/bin/env python3
import os,sys,json
run=json.loads(${JSON.stringify(JSON.stringify({ ...run, id: 42 }))})
job=json.loads(${JSON.stringify(JSON.stringify(job))})
if 'ci.yml/runs' in sys.argv[-1]: print(json.dumps({'workflow_runs':[] if os.environ.get('NO_RUN') else [run]}))
else: print(json.dumps({'jobs':[job]}))
`,
    { mode: 0o755 },
  );
  const invoke = (sha = commit, changes = {}) =>
    spawnSync(
      process.execPath,
      [resolve('infrastructure/single-server/delivery/verify-ci.mjs'), sha],
      {
        env: {
          ...process.env,
          PATH: f.bin + ':' + process.env.PATH,
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'vigani1/pertexo',
          ...changes,
        },
        encoding: 'utf8',
      },
    );
  assert.equal(invoke().status, 0);
  for (const [sha, env] of [
    ['short', {}],
    ['$(touch bad)', {}],
    [commit, { NO_RUN: 'true' }],
    [commit, { FIXTURE_GIT_STATUS: '1' }],
    [commit, { GITHUB_REF: 'refs/heads/feature' }],
  ])
    assert.notEqual(invoke(sha, env).status, 0);
});
test('SSH dispatcher permits only one literal deployment and propagates its status', (t) => {
  const f = fixture(t);
  copyFileSync(
    resolve('infrastructure/single-server/dispatch.sh'),
    join(f.root, 'dispatch.sh'),
  );
  writeFileSync(
    join(f.root, 'deploy.sh'),
    '#!/bin/sh\nprintf "%s" "$1" > "$PERTEXO_BETA_ROOT/argument"\nexit 7\n',
    { mode: 0o755 },
  );
  const invoke = (command) =>
    spawnSync('bash', [join(f.root, 'dispatch.sh')], {
      env: {
        ...process.env,
        PERTEXO_BETA_ROOT: f.root,
        SSH_ORIGINAL_COMMAND: command,
      },
      encoding: 'utf8',
    });
  for (const command of [
    '',
    'bash',
    'deploy main',
    `deploy ${commit}; touch bad`,
    `deploy ${commit}\nwhoami`,
    `deploy ${commit} extra`,
  ]) {
    assert.equal(invoke(command).status, 64);
    assert.equal(existsSync(join(f.root, 'argument')), false);
  }
  assert.equal(invoke(`deploy ${commit}`).status, 7);
  assert.equal(readFileSync(join(f.root, 'argument'), 'utf8'), commit);
});
test('SSH sender pins trust, keeps key files private and cleans them after failure', (t) => {
  const f = fixture(t);
  const key = join(f.root, 'fixture-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = readFileSync(key + '.pub', 'utf8');
  const log = join(f.root, 'ssh.json');
  writeFileSync(
    join(f.bin, 'ssh'),
    `#!/usr/bin/env python3
import os,sys,json,stat
from pathlib import Path
assert 'BETA_SSH_PRIVATE_KEY' not in os.environ
assert 'BETA_SSH_KNOWN_HOSTS' not in os.environ
args=sys.argv[1:]; key=Path(args[args.index('-i')+1]); known=Path(next(arg.split('=',1)[1] for arg in args if arg.startswith('UserKnownHostsFile=')))
assert stat.S_IMODE(key.stat().st_mode)==0o600
assert stat.S_IMODE(known.stat().st_mode)==0o600
assert key.read_text().startswith('-----BEGIN OPENSSH PRIVATE KEY-----')
Path(os.environ['FIXTURE_LOG']).write_text(json.dumps(args))
sys.exit(23)
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: f.bin + ':' + process.env.PATH,
    RUNNER_TEMP: f.root,
    BETA_COMMIT: commit,
    BETA_SSH_HOST: 'beta.example.test',
    BETA_SSH_USER: 'pertexo',
    BETA_SSH_PRIVATE_KEY: readFileSync(key, 'utf8'),
    BETA_SSH_KNOWN_HOSTS: 'beta.example.test ' + publicKey,
    FIXTURE_LOG: log,
  };
  const result = spawnSync(
    'bash',
    [resolve('infrastructure/single-server/delivery/send.sh')],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 23, result.stderr);
  const args = JSON.parse(readFileSync(log, 'utf8'));
  for (const option of [
    'StrictHostKeyChecking=yes',
    'GlobalKnownHostsFile=/dev/null',
    'IdentitiesOnly=yes',
    'BatchMode=yes',
    'UpdateHostKeys=no',
    'VerifyHostKeyDNS=no',
    'ForwardAgent=no',
    'ClearAllForwardings=yes',
  ])
    assert.ok(args.includes(option), option);
  assert.deepEqual(args.slice(-2), ['beta.example.test', `deploy ${commit}`]);
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith('pertexo-ssh.')),
    false,
  );
  rmSync(log);
  for (const changes of [
    { BETA_COMMIT: 'main' },
    { BETA_SSH_HOST: '-oProxyCommand=bad' },
    { BETA_SSH_KNOWN_HOSTS: 'other.example.test ' + publicKey },
  ]) {
    assert.notEqual(
      spawnSync(
        'bash',
        [resolve('infrastructure/single-server/delivery/send.sh')],
        { env: { ...env, ...changes } },
      ).status,
      0,
    );
    assert.equal(existsSync(log), false);
  }
});
test('workflow exposes only manual main dispatch and verifies evidence before using SSH secrets', () => {
  const workflow = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.deploy.if, "github.ref == 'refs/heads/main'");
  const steps = workflow.jobs.deploy.steps;
  const verify = steps.findIndex(
    (step) => step.name === 'Verify main CI and image publication',
  );
  const ssh = steps.findIndex((step) => step.name === 'Deploy over pinned SSH');
  assert.ok(verify < ssh);
  assert.equal(steps[verify].env.BETA_SSH_PRIVATE_KEY, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});
