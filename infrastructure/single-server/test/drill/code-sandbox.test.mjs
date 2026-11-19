import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { createClient } from './support/client.mjs';
import {
  FILTERED_SYSCALLS,
  HEALTHY,
  JAVASCRIPT_ATTACKS,
  PYTHON_ATTACKS,
} from './support/code-attacks.mjs';
import { PUBLIC_HOSTS } from './support/overlay.mjs';
import { docker, mustDocker, waitFor } from './support/process.mjs';
import {
  createWorkspace,
  publishCodeWorkflow,
  readStepResult,
  signIn,
  signUp,
  startRun,
  waitForEndedRun,
} from './support/product.mjs';
import {
  configure,
  createServer,
  destroyServer,
  httpsPort,
  killLikeTheKernel,
} from './support/server.mjs';

// Attacks the Code sandbox the way a hostile workspace member can: Code steps
// in published workflows, run by the real worker against the real code-runner
// container, deployed by deploy.sh with the production compose settings. A
// second workspace runs a healthy step after (and during) each attack to show
// the runner stays fair. Rerun on a Linux machine with Docker:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/code-sandbox.test.mjs
// SIMULATION_REPORT names a file for every attempt's recorded outcome.

const person = {
  email: `sandbox-${randomUUID().slice(0, 8)}@drill.test`,
  password: 'correct-horse-battery-staple-3',
  name: 'Sandbox Person',
};
// The compose default; the example file's 1 would leave no second task to attack.
const CONCURRENCY = 2;
// A healthy step on a free runner finishes well inside this; slower is unfair.
const HEALTHY_STEP_BUDGET_MILLIS = 5_000;
const probeDirectory = new URL('../../../images/code/', import.meta.url);
const report = { scenarios: {} };
const record = (scenario, name, value) => {
  report.scenarios[scenario] ??= {};
  report.scenarios[scenario][name] = value;
};

describe('the Code sandbox under attack on the production stack', () => {
  let server;
  let client;
  let attacker;
  let neighbour;

  const runner = () => server.containerOf('code-runner');
  const healthy = (service) =>
    waitFor(
      async () =>
        (await mustDocker([
          'inspect',
          '--format',
          '{{.State.Health.Status}}',
          await server.containerOf(service),
        ])) === 'healthy',
      { what: `${service} to be healthy`, timeout: 180_000 },
    );
  /** Resolves once `tasks` Python task processes, each with `threads` threads, run in the runner. */
  const pythonTaskRunning = (threads = 1, tasks = 1) =>
    waitFor(
      async () =>
        (await mustDocker(['top', await runner(), '-eo', 'pid,uid,nlwp,args']))
          .split('\n')
          .filter((line) => {
            const [, uid, count, ...args] = line.trim().split(/\s+/u);
            return (
              /^200\d\d$/u.test(uid) &&
              Number(count) >= threads &&
              args.join(' ').includes('python3.15')
            );
          }).length >= tasks,
      { what: 'Python tasks in the runner', timeout: 60_000, every: 200 },
    );
  const prepare = (workspaceId, code, options = {}) =>
    publishCodeWorkflow(client, workspaceId, { code, ...options });

  /** Runs a published Code workflow to its end and reads what its owner sees. */
  async function execute(workspaceId, workflow, timeout) {
    return finish(workspaceId, await startRun(client, workflow), timeout);
  }
  async function finish(workspaceId, runId, timeout) {
    const ended = await waitForEndedRun(client, workspaceId, runId, timeout);
    const step = ended.nodes.find((candidate) => candidate.nodeId === 'code');
    assert.ok(step, JSON.stringify(ended));
    const { output, diagnostics } = await readStepResult(
      client,
      workspaceId,
      runId,
      step,
    );
    return {
      runId,
      status: ended.run.status,
      stepStatus: step.status,
      attempts: step.currentAttemptNumber,
      safeErrorCode: step.safeErrorCode,
      errorSummary: step.errorSummary ?? null,
      message: diagnostics?.error?.message ?? null,
      logs: diagnostics?.logs?.length ?? 0,
      output: output?.kind === 'inline' ? output.value : output,
      stepMillis:
        step.startedAt && step.completedAt
          ? Date.parse(step.completedAt) - Date.parse(step.startedAt)
          : null,
    };
  }
  const attack = async (scenario, name, code, options = {}) => {
    const { timeout, ...settings } = options;
    const result = await execute(
      attacker,
      await prepare(attacker, code, settings),
      timeout,
    );
    record(scenario, name, result);
    return result;
  };

  /** Fails unless another workspace's healthy step runs now, and quickly. */
  let healthyWorkflows;
  async function neighbourIsUnaffected(scenario, name) {
    for (const language of ['javascript', 'python']) {
      const result = await execute(neighbour, healthyWorkflows[language]);
      record(scenario, `${name} then ${language} neighbour`, {
        status: result.status,
        stepMillis: result.stepMillis,
        attempts: result.attempts,
      });
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      // A manual run hands its step an empty object.
      assert.deepEqual(result.output, { healthy: {} });
      assert.equal(result.attempts, 1, `${name}: neighbour needed a retry`);
      assert.ok(
        result.stepMillis < HEALTHY_STEP_BUDGET_MILLIS,
        `${name}: neighbour step took ${result.stepMillis} ms`,
      );
    }
  }
  const failsClearly = (result, code) => {
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.safeErrorCode, code, JSON.stringify(result));
    assert.ok(
      result.message,
      `a message for the user: ${JSON.stringify(result)}`,
    );
  };

  before(async () => {
    server = await createServer();
    await configure(server);
    await server.mustExec(
      `sed -i 's/^CODE_RUNNER_CONCURRENCY=.*/CODE_RUNNER_CONCURRENCY=${CONCURRENCY}/' .env.production`,
    );
    const deployed = await server.script('deploy.sh', [server.releases.first]);
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    client = createClient({
      origin: `https://${PUBLIC_HOSTS.app}`,
      connect: { host: '127.0.0.1', port: httpsPort },
      ca: server.ca,
    });
    assert.equal((await signUp(client, person)).status, 200);
    const mail = async (path) =>
      JSON.parse(
        await mustDocker([
          'exec',
          await server.containerOf('drill-mail'),
          'wget',
          '-qO-',
          `http://127.0.0.1:8025/api/v1/${path}`,
        ]),
      );
    const message = await waitFor(
      async () =>
        (await mail('messages')).messages.find((candidate) =>
          candidate.To.some((to) => to.Address === person.email),
        ),
      { what: 'the verification mail', timeout: 60_000 },
    );
    const link = /https:\/\/\S+verify\S*/u.exec(
      (await mail(`message/${message.ID}`)).Text,
    )?.[0];
    assert.ok(link, 'a verification link');
    assert.ok((await client.get(link)).status < 400);
    assert.equal((await signIn(client, person)).status, 200);
    attacker = await createWorkspace(client);
    neighbour = await createWorkspace(client);
    healthyWorkflows = {
      javascript: await prepare(neighbour, HEALTHY.javascript),
      python: await prepare(neighbour, HEALTHY.python, { language: 'python' }),
    };
    await healthy('code-runner');
  });
  after(() => {
    const path = process.env.SIMULATION_REPORT ?? 'code-sandbox-report.json';
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`Simulation report: ${path}`);
  });
  after(async () => {
    if (process.env.DRILL_KEEP !== 'true') await destroyServer();
  });

  it('runs the code-runner with the production fences', async () => {
    const [info] = JSON.parse(await mustDocker(['inspect', await runner()]));
    const settings = {
      architecture: (
        await mustDocker(['info', '--format', '{{.Architecture}}'])
      ).trim(),
      user: info.Config.User,
      networkMode: info.HostConfig.NetworkMode,
      ipcMode: info.HostConfig.IpcMode,
      readOnly: info.HostConfig.ReadonlyRootfs,
      capDrop: info.HostConfig.CapDrop,
      capAdd: info.HostConfig.CapAdd,
      securityOpt: info.HostConfig.SecurityOpt,
      memoryBytes: info.HostConfig.Memory,
      nanoCpus: info.HostConfig.NanoCpus,
      pidsLimit: info.HostConfig.PidsLimit,
      tmpfs: info.HostConfig.Tmpfs,
      environment: info.Config.Env.filter((entry) => entry.startsWith('CODE_')),
      environmentNames: info.Config.Env.map((entry) => entry.split('=')[0]),
    };
    record('setup', 'code-runner container', settings);
    assert.equal(settings.architecture, 'x86_64');
    assert.equal(settings.networkMode, 'none');
    assert.equal(settings.readOnly, true);
    assert.deepEqual(settings.capDrop, ['ALL']);
    assert.ok(
      settings.environment.includes(`CODE_RUNNER_CONCURRENCY=${CONCURRENCY}`),
    );
    // Nothing worth stealing lives in the runner's own environment.
    for (const name of settings.environmentNames)
      assert.doesNotMatch(
        name,
        /DATABASE|REDIS|SECRET|PASSWORD|TOKEN|_KEY|STORE/u,
      );
  });

  describe('network', () => {
    it('Python reaches nothing: no internet, database, Redis, API, store, metadata or other service', async () => {
      const result = await attack('network', 'python', PYTHON_ATTACKS.network, {
        language: 'python',
      });
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      for (const [name, value] of Object.entries(result.output))
        assert.doesNotMatch(value, /^ALLOWED/u, name);
      assert.equal(result.output.socketModule, 'ENOSYS');
      await neighbourIsUnaffected('network', 'python');
    });

    it('the runner container itself has no route to any service, even without the task fences', async () => {
      const source = `
const net = require('net'), dns = require('dns/promises');
const targets = { postgres: ['postgres', 5432], redis: ['redis', 6379], api: ['api', 3000], storage: ['storage', 9000], worker: ['worker', 3000], metadata: ['169.254.169.254', 80], internet: ['1.1.1.1', 443], dockerHost: ['172.17.0.1', 2375] };
(async () => {
  const result = {};
  for (const [name, [host, port]] of Object.entries(targets))
    result[name] = await new Promise((resolve) => { const socket = net.connect({ host, port, timeout: 3000 }); socket.on('connect', () => { socket.destroy(); resolve('ALLOWED'); }); socket.on('timeout', () => { socket.destroy(); resolve('TIMEOUT'); }); socket.on('error', (error) => resolve(error.code)); });
  result.dns = await dns.lookup('postgres').then(() => 'ALLOWED', (error) => error.code);
  result.interfaces = Object.keys(require('os').networkInterfaces());
  console.log(JSON.stringify(result));
})();`;
      const result = JSON.parse(
        await mustDocker(['exec', await runner(), 'node', '-e', source]),
      );
      record(
        'network',
        'runner container (manager identity, no seccomp)',
        result,
      );
      assert.deepEqual(result.interfaces, ['lo']);
      for (const [name, value] of Object.entries(result))
        if (name !== 'interfaces') assert.notEqual(value, 'ALLOWED', name);
    });
  });

  describe('files', () => {
    it('Python reads no manager, other-task or host secret and writes nowhere', async () => {
      const result = await attack('files', 'python', PYTHON_ATTACKS.files, {
        language: 'python',
      });
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      const { reads, listings, others, writes, ownEnvironment, status } =
        result.output;
      for (const name of [
        'managerEnvironment',
        'managerMemory',
        'managerMaps',
        'managerRoot',
        'managerCwd',
        'managerPrivateTmp',
        'shadow',
        'kernelMemory',
        'runnerSocketDirectory',
      ])
        assert.equal(reads[name], 'EACCES', name);
      for (const name of [
        'dockerSecrets',
        'dockerSocket',
        'productionEnvironment',
      ])
        assert.equal(reads[name], 'ENOENT', name);
      for (const name of [
        'managerDescriptors',
        'runnerSocketDirectory',
        'managerTmp',
      ])
        assert.equal(listings[name], 'EACCES', name);
      assert.ok(Object.keys(others).length > 0, 'another process to attack');
      for (const [pid, process] of Object.entries(others))
        for (const name of ['environ', 'fd', 'mem', 'stdin'])
          assert.doesNotMatch(process[name], /^ALLOWED/u, `${pid} ${name}`);
      for (const [name, value] of Object.entries(writes))
        assert.equal(value, 'ENOSYS', name);
      assert.equal(result.output.rootReadOnly, true);
      for (const name of ownEnvironment)
        assert.doesNotMatch(
          name,
          /DATABASE|REDIS|SECRET|PASSWORD|TOKEN|_KEY|STORE/u,
        );
      assert.match(status, /^Uid:\s*(200\d\d)\s+\1\s+\1\s+\1$/mu);
      assert.match(status, /^CapEff:\s*0+$/mu);
      assert.match(status, /^NoNewPrivs:\s*1$/mu);
      assert.match(status, /^Seccomp:\s*2$/mu);
      await neighbourIsUnaffected('files', 'python');
    });

    it('Python cannot fill the disk', async () => {
      const result = await attack(
        'files',
        'disk fill',
        PYTHON_ATTACKS.diskFill,
        {
          language: 'python',
          timeoutSeconds: 5,
        },
      );
      failsClearly(result, 'code.runtime_error');
      await neighbourIsUnaffected('files', 'disk fill');
    });

    it('JavaScript loads no host module and finds no process object', async () => {
      const modules = await attack(
        'files',
        'javascript modules',
        JAVASCRIPT_ATTACKS.modules,
      );
      assert.equal(modules.status, 'succeeded', JSON.stringify(modules));
      for (const [name, value] of Object.entries(modules.output))
        assert.notEqual(value, 'ALLOWED', name);
      const globals = await attack(
        'files',
        'javascript globals',
        JAVASCRIPT_ATTACKS.globals,
      );
      assert.equal(globals.status, 'succeeded', JSON.stringify(globals));
      assert.deepEqual(globals.output, {
        process: 'undefined',
        functionProcess: 'threw ReferenceError',
        asyncFunctionProcess: 'threw ReferenceError',
        evalProcess: 'threw ReferenceError',
        thisValue: 'undefined',
        consoleProcess: 'threw ReferenceError',
        requireCache: 'undefined',
        requireMain: 'undefined',
        lodashTemplate: 'undefined',
        prepareStackTrace: 'threw TypeError',
        fetch: 'undefined',
        webSocket: 'undefined',
        buffer: 'undefined',
      });
    });

    it("the image's JavaScript kernel-fence probe passes inside the production runner", async () => {
      // python-probe.mjs builds its client from the default settings, which a
      // configured install doesn't share; the Python attacks above cover its fences.
      const result = await docker(
        ['exec', '-i', await runner(), 'node', '--input-type=module', '-'],
        {
          input: readFileSync(new URL('os-probe.mjs', probeDirectory)),
          timeout: 120_000,
        },
      );
      record('files', 'image probe os-probe.mjs', {
        status: result.status,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim().slice(0, 2_000),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      await neighbourIsUnaffected('files', 'image probe');
    });
  });

  describe('privilege', () => {
    it('Python changes no identity, permission or namespace and makes no filtered system call', async () => {
      const result = await attack(
        'privilege',
        'python',
        PYTHON_ATTACKS.privilege,
        {
          language: 'python',
        },
      );
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      const output = result.output;
      for (const name of FILTERED_SYSCALLS)
        assert.equal(output.syscalls[name], 'ENOSYS', name);
      for (const name of [
        'fork',
        'posixSpawn',
        'setuid',
        'setgroups',
        'terminalInjection',
      ])
        assert.equal(output[name], 'ENOSYS', name);
      for (const name of ['raiseFileLimit', 'raiseProcessLimit'])
        assert.match(output[name], /^(?:EPERM|ValueError)$/u, name);
      assert.equal(output.managerLimits, 'EPERM');
      assert.equal(output.signalManager, 'EPERM');
      for (const [pid, value] of Object.entries(output.signals))
        assert.equal(value, 'EPERM', `signal ${pid}`);
      assert.match(output.status, /^NoNewPrivs:\s*1$/mu);
      for (const set of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'])
        assert.match(output.status, new RegExp(`^${set}:\\s*0+$`, 'mu'), set);
      await neighbourIsUnaffected('privilege', 'python');
    });

    it('a set-user-ID program runs without its privilege', async () => {
      const result = await attack(
        'privilege',
        'setuid exec',
        PYTHON_ATTACKS.setuidExec,
        {
          language: 'python',
          timeoutSeconds: 5,
        },
      );
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.ok(result.message);
      await neighbourIsUnaffected('privilege', 'setuid exec');
    });
  });

  describe('resources', () => {
    const cases = [
      [
        'python fork bomb',
        PYTHON_ATTACKS.forkBomb,
        'python',
        'code.runtime_error',
      ],
      [
        'python memory bomb',
        PYTHON_ATTACKS.memoryBomb,
        'python',
        'code.memory_limit',
      ],
      ['python CPU spin', PYTHON_ATTACKS.cpuSpin, 'python', 'code.timeout'],
      [
        'python regex backtracking',
        PYTHON_ATTACKS.regexBacktrack,
        'python',
        'code.timeout',
      ],
      [
        'python thread bomb',
        PYTHON_ATTACKS.threadBomb,
        'python',
        'code.timeout',
      ],
      [
        'python endless print',
        PYTHON_ATTACKS.endlessPrint,
        'python',
        'code.timeout',
      ],
      [
        'python endless raw output',
        PYTHON_ATTACKS.endlessRawOutput,
        'python',
        'code.output_invalid',
      ],
      [
        'python endless error output',
        PYTHON_ATTACKS.endlessErrorOutput,
        'python',
        'code.output_invalid',
      ],
      [
        'python huge return',
        PYTHON_ATTACKS.hugeReturn,
        'python',
        'code.output_invalid',
      ],
      [
        'javascript CPU spin',
        JAVASCRIPT_ATTACKS.cpuSpin,
        'javascript',
        'code.timeout',
      ],
      [
        'javascript Atomics.wait',
        JAVASCRIPT_ATTACKS.atomicsWait,
        'javascript',
        'code.timeout',
      ],
      [
        'javascript microtask flood',
        JAVASCRIPT_ATTACKS.microtaskFlood,
        'javascript',
        'code.timeout',
      ],
      [
        'javascript heap bomb',
        JAVASCRIPT_ATTACKS.memoryBomb,
        'javascript',
        'code.memory_limit',
      ],
      [
        'javascript WebAssembly bomb',
        JAVASCRIPT_ATTACKS.wasmBomb,
        'javascript',
        'code.memory_limit',
      ],
      [
        'javascript zlib bomb',
        JAVASCRIPT_ATTACKS.zlibBomb,
        'javascript',
        'code.memory_limit',
      ],
      [
        'javascript endless log',
        JAVASCRIPT_ATTACKS.endlessLog,
        'javascript',
        'code.timeout',
      ],
      [
        'javascript huge return',
        JAVASCRIPT_ATTACKS.hugeReturn,
        'javascript',
        'code.output_invalid',
      ],
    ];
    for (const [name, code, language, expected] of cases)
      it(`${name} ends with ${expected}, a message, and a fast neighbour`, async () => {
        const started = Date.now();
        const result = await attack('resources', name, code, {
          language,
          timeoutSeconds: expected === 'code.memory_limit' ? 20 : 3,
        });
        result.wallMillis = Date.now() - started;
        failsClearly(result, expected);
        assert.equal(result.attempts, 1, 'a sandbox failure is not retried');
        await neighbourIsUnaffected('resources', name);
      });

    it('descriptors and threads stop at their per-task limits', async () => {
      const descriptors = await attack(
        'resources',
        'python descriptors',
        PYTHON_ATTACKS.descriptors,
        {
          language: 'python',
        },
      );
      assert.equal(
        descriptors.status,
        'succeeded',
        JSON.stringify(descriptors),
      );
      assert.equal(descriptors.output.error, 'EMFILE');
      assert.ok(descriptors.output.opened < 64);
      const threads = await attack(
        'resources',
        'python threads',
        PYTHON_ATTACKS.threadLimit,
        {
          language: 'python',
        },
      );
      assert.equal(threads.status, 'succeeded', JSON.stringify(threads));
      assert.ok(threads.output.threads < 16, JSON.stringify(threads.output));
      await neighbourIsUnaffected('resources', 'descriptors and threads');
    });

    it('a CPU-burning thread bomb leaves a concurrent neighbour fast', async () => {
      const workflow = await prepare(attacker, PYTHON_ATTACKS.threadBomb, {
        language: 'python',
        timeoutSeconds: 15,
      });
      const runId = await startRun(client, workflow);
      // Every thread the task may start is spinning before the neighbour runs.
      await pythonTaskRunning(8);
      await neighbourIsUnaffected('resources', 'concurrent thread bomb');
      const result = await finish(attacker, runId);
      record('resources', 'concurrent thread bomb', result);
      failsClearly(result, 'code.timeout');
    });

    it('a forged result frame is only the task’s own answer', async () => {
      const result = await attack(
        'resources',
        'forged result',
        PYTHON_ATTACKS.forgedResult,
        {
          language: 'python',
        },
      );
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
    });
  });

  // A busy runner makes a step wait for a slot, first come first served, the
  // way n8n's task runners queue work; the wait doesn't eat the step's own
  // time limit, and the step runs once a slot frees.
  describe('a busy runner', () => {
    it('one workspace holding every runner slot makes another workspace’s step wait, then run', async () => {
      const workflow = await prepare(attacker, PYTHON_ATTACKS.cpuSpin, {
        language: 'python',
        timeoutSeconds: 30,
      });
      const hostile = [];
      for (let slot = 0; slot < CONCURRENCY; slot++)
        hostile.push(await startRun(client, workflow));
      await pythonTaskRunning(1, CONCURRENCY);
      const started = Date.now();
      const result = await execute(neighbour, healthyWorkflows.javascript);
      result.wallMillis = Date.now() - started;
      record('busy runner', 'every slot held by another workspace', result);
      for (const runId of hostile)
        failsClearly(await finish(attacker, runId), 'code.timeout');
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.deepEqual(result.output, { healthy: {} });
      assert.equal(result.attempts, 1, 'the step waited instead of retrying');
      assert.ok(
        result.wallMillis > HEALTHY_STEP_BUDGET_MILLIS,
        `the step ran without waiting (${String(result.wallMillis)} ms)`,
      );
    });

    it('three long steps in one workspace share two slots and all finish', async () => {
      const timeoutSeconds = 20;
      const workflow = await prepare(neighbour, PYTHON_ATTACKS.sleep, {
        language: 'python',
        timeoutSeconds,
      });
      const runs = [];
      for (let step = 0; step <= CONCURRENCY; step++)
        runs.push(await startRun(client, workflow));
      const results = [];
      for (const runId of runs) results.push(await finish(neighbour, runId));
      record('busy runner', 'three long steps on two slots', results);
      for (const result of results) {
        assert.equal(result.status, 'succeeded', JSON.stringify(result));
        assert.deepEqual(result.output, { slept: 15 });
        assert.equal(result.attempts, 1, JSON.stringify(result));
      }
      // The step that waited ran longer than its own time limit in all: the
      // wait didn't count against it.
      const longest = Math.max(...results.map((result) => result.stepMillis));
      assert.ok(
        longest > timeoutSeconds * 1_000,
        `no step waited for a slot (longest ${String(longest)} ms)`,
      );
    });
  });

  describe('leftovers', () => {
    for (const language of ['python', 'javascript'])
      it(`${language} state from one workspace's task never reaches the next task`, async () => {
        const attacks =
          language === 'python' ? PYTHON_ATTACKS : JAVASCRIPT_ATTACKS;
        const left = await attack(
          'leftovers',
          `${language} leave behind`,
          attacks.leaveBehind,
          {
            language,
          },
        );
        assert.equal(left.status, 'succeeded', JSON.stringify(left));
        const found = await execute(
          neighbour,
          await prepare(neighbour, attacks.findLeftovers, { language }),
        );
        record('leftovers', `${language} find leftovers`, found);
        assert.equal(found.status, 'succeeded', JSON.stringify(found));
        assert.doesNotMatch(
          JSON.stringify(found.output),
          /workspace A secret/u,
        );
        if (language === 'python') {
          assert.notEqual(found.output.pid, left.output.pid);
          assert.ok(!found.output.processes.includes(left.output.pid));
          assert.equal(left.output.write, 'ENOSYS');
        }
      });
  });

  describe('restarts', () => {
    it('a runner killed mid-task retries the step on the restarted runner', async () => {
      const workflow = await prepare(attacker, PYTHON_ATTACKS.sleep, {
        language: 'python',
        timeoutSeconds: 25,
      });
      const before = Number(
        await mustDocker([
          'inspect',
          '--format',
          '{{.RestartCount}}',
          await runner(),
        ]),
      );
      const runId = await startRun(client, workflow);
      await pythonTaskRunning();
      await killLikeTheKernel(await runner());
      const ended = await waitForEndedRun(client, attacker, runId, 240_000);
      const step = ended.nodes.find((candidate) => candidate.nodeId === 'code');
      const after = Number(
        await mustDocker([
          'inspect',
          '--format',
          '{{.RestartCount}}',
          await runner(),
        ]),
      );
      const result = {
        status: ended.run.status,
        attempts: step.currentAttemptNumber,
        safeErrorCode: step.safeErrorCode,
        errorSummary: step.errorSummary ?? null,
        restarts: after - before,
        output: (await readStepResult(client, attacker, runId, step)).output,
      };
      record('restarts', 'runner killed mid-task', result);
      assert.equal(result.restarts, 1);
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.ok(result.attempts >= 2, JSON.stringify(result));
      await healthy('code-runner');
      await neighbourIsUnaffected('restarts', 'runner killed mid-task');
    });
  });
});
