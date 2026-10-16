import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const image = process.argv[2];
if (!image || !/^[a-z0-9][a-zA-Z0-9._/:@-]*$/u.test(image))
  throw new Error(
    'usage: node infrastructure/images/code/verify.mjs <cached-runtime-image>',
  );
const docker = async (args, timeout = 30_000) => {
  const result = await execute('docker', args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return (
    args[0] === 'logs' ? result.stdout + result.stderr : result.stdout
  ).trim();
};
const suffix = randomUUID(),
  label = `pertexo.code-qualification=${suffix}`,
  volume = `pertexo-code-${suffix}`,
  containers = [];
const mount = (name) =>
  `type=bind,src=${fileURLToPath(new URL(name, import.meta.url))},dst=/probe/${name},readonly`;
const limits = JSON.parse(
  await docker([
    'run',
    '--rm',
    '--pull=never',
    '--network',
    'none',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    "import{DEFAULT_CODE_SETTINGS,codeContainerLimits}from'./packages/node-sdk/dist/index.js'; console.log(JSON.stringify(codeContainerLimits(DEFAULT_CODE_SETTINGS)))",
  ]),
);
await docker(['volume', 'create', '--label', label, volume]);
try {
  const manager = await docker([
    'run',
    '-d',
    '--pull=never',
    '--label',
    label,
    '--network',
    'none',
    '--ipc',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m,mode=0700',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--cap-add',
    'KILL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '0:10001',
    '--memory',
    `${limits.memoryMiB}m`,
    '--memory-swap',
    `${limits.memoryMiB}m`,
    '--cpus',
    String(limits.cpus),
    '--pids-limit',
    String(limits.pids),
    '--oom-score-adj',
    '-1000',
    '-e',
    `NODE_OPTIONS=--max-old-space-size=${limits.managerHeapMiB}`,
    '-v',
    `${volume}:/run/pertexo-code`,
    '--mount',
    mount('os-probe.mjs'),
    '--entrypoint',
    'node',
    image,
    'apps/code-runner/dist/main.js',
  ]);
  containers.push(manager);
  const ready = async () => {
    for (let index = 0; index < 100; index++) {
      const info = JSON.parse(await docker(['inspect', manager]))[0];
      if (!info.State.Running)
        throw new Error(
          'Code runner stopped: ' + (await docker(['logs', manager])),
        );
      try {
        await docker([
          'exec',
          manager,
          'test',
          '-f',
          '/tmp/pertexo-code-runner-ready',
        ]);
        return;
      } catch {
        await delay(100);
      }
    }
    throw new Error('Code runner readiness timed out');
  };
  await ready();
  const before = JSON.parse(await docker(['inspect', manager]))[0].RestartCount;
  console.log(await docker(['exec', manager, 'node', '/probe/os-probe.mjs']));
  const client = await docker([
    'run',
    '-d',
    '--pull=never',
    '--label',
    label,
    '--network',
    'none',
    '--read-only',
    '--user',
    '10001:10001',
    '-v',
    `${volume}:/run/pertexo-code`,
    '--mount',
    mount('client-probe.mjs'),
    '--entrypoint',
    'node',
    image,
    '/probe/client-probe.mjs',
  ]);
  containers.push(client);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const info = JSON.parse(await docker(['inspect', client]))[0];
    if (!info.State.Running) {
      assert.equal(info.State.ExitCode, 0, await docker(['logs', client]));
      break;
    }
    if (Date.now() > deadline)
      throw new Error('Code transport qualification timed out');
    await delay(200);
  }
  console.log(await docker(['logs', client]));
  const after = JSON.parse(await docker(['inspect', manager]))[0];
  assert.equal(after.RestartCount, before);
  assert.equal(after.State.OOMKilled, false);
  assert.equal(after.State.Running, true);
  // A hard manager restart leaves a stale socket and kills every task through
  // PDEATHSIG; the replacement must recover its unused pool and private socket.
  // Reserve a ready process and submit a nonterminating task before the crash.
  const inFlight = await docker([
    'run',
    '-d',
    '--pull=never',
    '--label',
    label,
    '--network',
    'none',
    '--read-only',
    '--user',
    '10001:10001',
    '-v',
    `${volume}:/run/pertexo-code`,
    '--mount',
    mount('restart-probe.mjs'),
    '--entrypoint',
    'node',
    image,
    '/probe/restart-probe.mjs',
  ]);
  containers.push(inFlight);
  for (let index = 0; ; index++) {
    const info = JSON.parse(await docker(['inspect', inFlight]))[0];
    const logs = await docker(['logs', inFlight]);
    if (logs.includes('Code task submitted.')) break;
    assert.equal(info.State.Running, true, logs);
    if (index >= 100) throw new Error('Restart probe did not submit its task');
    await delay(50);
  }
  await docker(['kill', '--signal', 'KILL', manager]);
  for (let index = 0; ; index++) {
    const info = JSON.parse(await docker(['inspect', inFlight]))[0];
    if (!info.State.Running) {
      assert.equal(info.State.ExitCode, 0, await docker(['logs', inFlight]));
      break;
    }
    if (index >= 100)
      throw new Error('Crashed manager left the task client waiting');
    await delay(50);
  }

  await docker(['start', manager]);
  await ready();
  const clean = await docker([
    'run',
    '--rm',
    '--pull=never',
    '--label',
    label,
    '--network',
    'none',
    '--read-only',
    '--user',
    '10001:10001',
    '-v',
    `${volume}:/run/pertexo-code`,
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    "import{createCodeRunnerClient}from'./apps/worker/dist/attempts/code/client.js';import{DEFAULT_CODE_SETTINGS}from'./packages/node-sdk/dist/index.js';const c=createCodeRunnerClient({settings:DEFAULT_CODE_SETTINGS,socketPath:'/run/pertexo-code/runner.sock',requireHardened:true});try{const r=await c.execute({code:'return 42;',timeoutSeconds:2,input:null,variables:{}},AbortSignal.timeout(10000));if(r.kind!=='succeeded'||r.output!==42)throw Error('Restart failed');console.log('Hard manager restart recovered with a fresh task.')}finally{c.close()}",
  ]);
  console.log(clean);
} finally {
  for (const id of containers.reverse()) {
    const info = JSON.parse(await docker(['inspect', id]))[0];
    assert.equal(info.Config.Labels['pertexo.code-qualification'], suffix);
    await docker(['rm', '-f', id]);
  }
  const owned = JSON.parse(await docker(['volume', 'inspect', volume]))[0];
  assert.equal(owned.Labels['pertexo.code-qualification'], suffix);
  await docker(['volume', 'rm', volume]);
}
